// Claude Code format kayması kalkanı (09/01) — tanılama sinyallerini toplar ve CompatReport üretir.
// Saf Node: electron importu yok. Kayıt başına maliyet O(1) sayaç artışı; rapor yalnızca değişince yeniden üretilir.
//
// İki tür sinyal:
//  - Olay sinyalleri (tanınmayan kayıt tipi, eksik alan, geçersiz hook satırı, çözümlenemeyen statusLine):
//    dakikalık kovalarda sayılır, son 30 dk penceresine bakılır.
//  - Durum sinyalleri (registry sağlığı, süreç ↔ registry çelişkisi): son gözlemlenen durum; düzelince kalkar.
import { COMPAT, compareVersions, maxLevel, safeVersion, type CompatLevel, type CompatReport, type CompatSignal, type CompatSignalId } from '@shared/compat';
import { enumValue, shapeInto, shapeObject } from '@shared/schemaRules';
import type { RegistryHealth } from './registry';

/** Normalizer'ın beslediği yüzey (events.ts NormalizerState.sink). */
export interface CompatSink {
  record(): void;
  unknownType(type: string, rec: Record<string, unknown>): void;
  missingKey(key: string): void;
}

export const COMPAT_WINDOW_MS = 30 * 60_000;
const BUCKET_MS = 60_000;
/** Süreç var, canlı registry kaydı yok: bu süre boyunca kesintisiz sürerse hata. */
export const CONTRADICTION_MS = 60_000;
/** Şeması saklanan en fazla tanınmayan tip ve tip başına anahtar. */
const MAX_SHAPE_TYPES = 10;
const MAX_SHAPE_KEYS = 40;
/** Rapor ayrıntısında tutulan en fazla farklı anahtar (sinyal başına). */
const MAX_DETAIL_KEYS = 50;

export const COMPAT_THRESHOLDS = {
  /** Tanınmayan kayıt oranı (pencere içinde) ve oranın anlamlı olması için en az kayıt. */
  unknownRatio: 0.01,
  unknownRatioMin: 10,
  /** Tek bir tip bu kadar kayda ulaşırsa oran ne olursa olsun uyarı. */
  unknownPerType: 50,
  missingKeys: 20,
  hookBadLines: 10,
  statusLineUnparsed: 3,
} as const;

type EventSignal = 'unknownRecordTypes' | 'unknownRecordKeys' | 'hookBadLines' | 'statusLineUnparsed';

interface Bucket {
  idx: number;
  records: number;
  counts: Map<EventSignal, Map<string, number>>;
}

export interface CompatMonitorOptions {
  now: () => number;
  testedMin?: string;
  testedMax?: string;
}

export class CompatMonitor implements CompatSink {
  private readonly now: () => number;
  private readonly testedMin: string;
  private readonly testedMax: string;
  private buckets: Bucket[] = [];
  /** Henüz kovaya aktarılmamış kayıt sayısı: sıcak yolda saat okunmasın (bir sonraki olay/raporda aktarılır). */
  private pendingRecords = 0;
  private shapes = new Map<string, Map<string, Set<string>>>();
  private registry: RegistryHealth | null = null;
  private claudeProcs: number | null = null;
  private contradictionSince: number | null = null;
  private claudeVersion: string | null = null;
  private dirty = true;
  private cache: { report: CompatReport; key: string; bucket: number } | null = null;

  constructor(opts: CompatMonitorOptions) {
    this.now = opts.now;
    this.testedMin = opts.testedMin ?? COMPAT.testedMin;
    this.testedMax = opts.testedMax ?? COMPAT.testedMax;
  }

  // ---------- olay girişleri ----------

  record(): void {
    this.pendingRecords++;
  }

  unknownType(type: string, rec: Record<string, unknown>): void {
    const name = enumValue(type);
    this.inc('unknownRecordTypes', name);
    let m = this.shapes.get(name);
    if (!m) {
      if (this.shapes.size >= MAX_SHAPE_TYPES) return;
      m = new Map();
      this.shapes.set(name, m);
    }
    if (m.size < MAX_SHAPE_KEYS) shapeInto(m, rec, MAX_SHAPE_KEYS);
  }

  missingKey(key: string): void {
    this.inc('unknownRecordKeys', key);
  }

  hookBadLine(unsupportedVersion: boolean): void {
    this.inc('hookBadLines', unsupportedVersion ? 'unsupportedVersion' : 'invalid');
  }

  statusLineUnparsed(): void {
    this.inc('statusLineUnparsed', 'limits.json');
  }

  // ---------- durum girişleri ----------

  setRegistry(h: RegistryHealth): void {
    this.registry = h;
    this.dirty = true;
  }

  /**
   * Süreç ↔ registry çelişkisi. `claudeProcs` null → süreç tablosu yok/bayat: çelişki kararı verilmez.
   * Registry canlı kayıt sayısı setRegistry ile gelen son sağlık bilgisinden okunur.
   */
  observeProcesses(claudeProcs: number | null): void {
    this.claudeProcs = claudeProcs;
    const live = this.registry?.live ?? 0;
    if (claudeProcs !== null && claudeProcs >= 1 && live === 0) this.contradictionSince ??= this.now();
    else this.contradictionSince = null;
    this.dirty = true;
  }

  setClaudeVersion(v: string | null): void {
    const sv = safeVersion(v);
    if (sv === this.claudeVersion) return;
    this.claudeVersion = sv;
    this.dirty = true;
  }

  // ---------- rapor ----------

  /** Değişmediyse aynı nesneyi döner (snapshot karşılaştırması ucuz kalsın). */
  report(): CompatReport {
    if (this.pendingRecords) this.bucket(); // bekleyen kayıtları güncel kovaya aktar
    const now = this.now();
    const bucketIdx = Math.floor(now / BUCKET_MS);
    if (this.cache && !this.dirty && this.cache.bucket === bucketIdx) return this.cache.report;
    this.dirty = false;
    const r = this.build(now, bucketIdx);
    const key = JSON.stringify({ ...r, at: 0, since: 0 });
    if (this.cache && this.cache.key === key) {
      this.cache.bucket = bucketIdx;
      return this.cache.report;
    }
    this.cache = { report: r, key, bucket: bucketIdx };
    return r;
  }

  private build(now: number, bucketIdx: number): CompatReport {
    const minIdx = bucketIdx - Math.ceil(COMPAT_WINDOW_MS / BUCKET_MS) + 1;
    let records = 0;
    const agg = new Map<EventSignal, Map<string, number>>();
    let since = now;
    for (const b of this.buckets) {
      if (b.idx < minIdx) continue;
      since = Math.min(since, b.idx * BUCKET_MS);
      records += b.records;
      for (const [sig, m] of b.counts) {
        let into = agg.get(sig);
        if (!into) agg.set(sig, (into = new Map()));
        for (const [k, n] of m) into.set(k, (into.get(k) ?? 0) + n);
      }
    }
    since = Math.max(since, now - COMPAT_WINDOW_MS);

    const signals: CompatSignal[] = [];
    const push = (id: CompatSignalId, level: CompatLevel, detail: Map<string, number> | Record<string, number>): void => {
      if (level === 'ok') return;
      const d = detail instanceof Map ? Object.fromEntries(detail) : detail;
      const count = Object.values(d).reduce((a, n) => a + n, 0);
      signals.push({ id, level, count, detail: d });
    };

    const unknown = agg.get('unknownRecordTypes');
    if (unknown) {
      const total = sum(unknown);
      const ratioHit = total >= COMPAT_THRESHOLDS.unknownRatioMin && records > 0 && total / records > COMPAT_THRESHOLDS.unknownRatio;
      const typeHit = [...unknown.values()].some((n) => n >= COMPAT_THRESHOLDS.unknownPerType);
      push('unknownRecordTypes', ratioHit || typeHit ? 'warn' : 'ok', unknown);
    }
    const missing = agg.get('unknownRecordKeys');
    if (missing) push('unknownRecordKeys', sum(missing) >= COMPAT_THRESHOLDS.missingKeys ? 'warn' : 'ok', missing);

    const reg = this.registry;
    if (reg) {
      const errs: Record<string, number> = {};
      if (reg.shapeErrors) errs['eksikZorunluAlan'] = reg.shapeErrors;
      if (reg.jsonErrors) errs['bozukJson'] = reg.jsonErrors;
      if (reg.shapeErrors + reg.jsonErrors >= 1) push('registryParseErrors', 'warn', errs);
      if (Object.keys(reg.unknownStatus).length) push('unknownRegistryStatus', 'warn', reg.unknownStatus);
    }

    if (this.contradictionSince !== null && now - this.contradictionSince >= CONTRADICTION_MS) {
      push('processWithoutSession', 'error', { claudeSureci: this.claudeProcs ?? 0, canliSession: 0 });
    }

    const hook = agg.get('hookBadLines');
    if (hook) push('hookBadLines', sum(hook) >= COMPAT_THRESHOLDS.hookBadLines ? 'warn' : 'ok', hook);
    const sl = agg.get('statusLineUnparsed');
    if (sl) push('statusLineUnparsed', sum(sl) >= COMPAT_THRESHOLDS.statusLineUnparsed ? 'warn' : 'ok', sl);

    const level = signals.reduce<CompatLevel>((l, s) => maxLevel(l, s.level), 'ok');
    const report: CompatReport = {
      level,
      claudeVersion: this.claudeVersion,
      testedMin: this.testedMin,
      testedMax: this.testedMax,
      untestedVersion: this.claudeVersion !== null && compareVersions(this.claudeVersion, this.testedMax) > 0,
      signals,
      since,
      at: now,
      records,
    };
    const unknownSig = signals.find((s) => s.id === 'unknownRecordTypes');
    if (unknownSig) {
      const shapes: Record<string, Record<string, string>> = {};
      for (const t of Object.keys(unknownSig.detail)) {
        const m = this.shapes.get(t);
        if (m) shapes[t] = shapeObject(m);
      }
      if (Object.keys(shapes).length) report.unknownShapes = shapes;
    }
    return report;
  }

  // ---------- iç ----------

  private bucket(): Bucket {
    const idx = Math.floor(this.now() / BUCKET_MS);
    const last = this.buckets[this.buckets.length - 1];
    if (last && last.idx === idx) return this.flushRecords(last);
    const b: Bucket = { idx, records: 0, counts: new Map() };
    this.buckets.push(b);
    const minIdx = idx - Math.ceil(COMPAT_WINDOW_MS / BUCKET_MS) + 1;
    while (this.buckets.length && (this.buckets[0] as Bucket).idx < minIdx) this.buckets.shift();
    return this.flushRecords(b);
  }

  private flushRecords(b: Bucket): Bucket {
    if (this.pendingRecords) {
      b.records += this.pendingRecords;
      this.pendingRecords = 0;
    }
    return b;
  }

  private inc(sig: EventSignal, key: string): void {
    const b = this.bucket();
    let m = b.counts.get(sig);
    if (!m) b.counts.set(sig, (m = new Map()));
    const n = m.get(key);
    if (n === undefined && m.size >= MAX_DETAIL_KEYS) key = '‹diğer›';
    m.set(key, (m.get(key) ?? 0) + 1);
    this.dirty = true;
  }
}

const sum = (m: Map<string, number>): number => {
  let n = 0;
  for (const v of m.values()) n += v;
  return n;
};
