// Canlı session registry'si
//
// Claude Code her çalışan süreç için ~/.claude/sessions/<pid>.json yazar. Bu modül:
//  - yalnızca kullanıcının sohbetlerini döndürür: etkileşimli kayıtlar ve `jobId` taşıyan arka plan session'ları
//    (`kind: "bg"`, 07/01); spare, hosted ve kimliksiz arka plan kayıtları elenir,
//  - pid canlılığını ve pid yeniden kullanımını doğrular,
//  - aynı pid'de sessionId değişimini (compact/resume) `superseded` olarak bildirir,
//  - değişmeyen dosyayı yeniden okumaz (mtime cache).
// Yalnızca readdir/stat/readFile kullanır; ~/.claude'a asla yazmaz.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { BG_ID_RE } from '@shared/ipc';
import type { ClaudePaths } from './paths';
import { isAlive as realIsAlive, processStartMs as realProcessStartMs, procStartToken as realProcStartToken, sameProcessStart } from './proc-start';

export interface RegistryEntry {
  sessionId: string;
  pid: number;
  status: 'busy' | 'idle' | 'waiting'; // SessionStatus'un canlı alt kümesi; 'shell' → 'idle'
  rawStatus: string; // dosyadaki ham değer ('shell' dahil)
  waitingForRaw: string | null;
  name: string | null;
  /** 'derived' → Claude Code'un otomatik verdiği ad (ör. claude-18); kullanıcı /rename ile verdiyse başka değer. */
  nameSource?: string | null;
  cwd: string | null;
  entrypoint: string | null;
  startedAt: number | null; // ms
  updatedAt: number | null;
  statusSince: number | null; // statusUpdatedAt ?? updatedAt
  /** Dosyadaki ham statusUpdatedAt (yoksa null): hook durumu ile öncelik kuralı (02/09) buna bakar. */
  statusUpdatedAt?: number | null;
  /** Claude Code'un yazdığı opak süreç başlangıç belirteci (yeni sürümler); pid reuse kontrolünde ps yerine. */
  procStart: string | null;
  /** Arka plan session'ının `claude attach` kimliği (registry `jobId`, 8 hex); etkileşimli session'da null (07/01). */
  jobId?: string | null;
  file: string; // registry dosyasının yolu
}

export interface RegistryDiff {
  added: RegistryEntry[];
  updated: RegistryEntry[];
  removed: { sessionId: string; pid: number; endedAt: number }[];
  superseded: { from: string; to: string }[];
}

export interface RegistryWatcherOptions {
  pollMs?: number;
  now?: () => number;
  isAlive?: (pid: number) => boolean;
  processStartMs?: (pid: number) => Promise<number | null>;
  /** `procStart` ile karşılaştırılacak canlı süreç belirteci; null → ps lstart yoluna düşülür. */
  procStartToken?: (pid: number) => Promise<string | null>;
}

/** Bir dosyanın son okunmuş hali. */
interface CacheItem {
  mtimeMs: number;
  /** Filtreyi geçmeyen ya da bozuk dosyada null. */
  entry: RegistryEntry | null;
  pid: number | null;
  sessionId: string | null;
  interactive: boolean;
  /** pid reuse tespit edildi: dosya değişene kadar ölü say. */
  reuseDead: boolean;
  /** pid reuse kontrolü bu pid için yapıldı mı. */
  startChecked: boolean;
  /** Dosyadaki ham status (09/01 uyumluluk: bilinmeyen değer sayımı); parse edilemediyse null. */
  rawStatus: string | null;
}

/** 09/01: registry'nin format sağlığı (CompatMonitor girdisi). Yalnızca sayılar ve enum benzeri status adları. */
export interface RegistryHealth {
  /** sessions/ altındaki <pid>.json dosyaları. */
  files: number;
  /** pid + sessionId okunabilen kayıtlar (tür ayırmadan). */
  parsed: number;
  /** Okunabilen ve süreci canlı kayıtlar (tür ayırmadan; spare/hosted dahil). */
  live: number;
  /** JSON geçerli ama zorunlu alanlar (sessionId, pid) yok. */
  shapeErrors: number;
  /** En az JSON_STABLE_MS'dir değişmeyen ve yine de JSON olarak okunamayan dosyalar (yarım yazım değil). */
  jsonErrors: number;
  /** Bilinmeyen status değeri → dosya sayısı (enum biçiminde değilse ‹değer›). */
  unknownStatus: Record<string, number>;
}

/** Ham status'un bilinen değerleri (Claude Code 2.1.318). */
export const KNOWN_REGISTRY_STATUSES: ReadonlySet<string> = new Set(['busy', 'idle', 'waiting', 'shell']);

/**
 * Registry dosyalarında görülen ve bilinçli olarak tanınan anahtarlar (09/01 kapsama testi).
 * Okunanlar parseEntry'de; geri kalanı UI'ın kullanmadığı ama varlığı bilinen alanlar.
 */
export const KNOWN_REGISTRY_KEYS: ReadonlySet<string> = new Set([
  // okunan
  'sessionId', 'pid', 'kind', 'jobId', 'spare', 'hostSessionId', 'status', 'waitingFor', 'name', 'nameSource', 'cwd',
  'entrypoint', 'startedAt', 'updatedAt', 'statusUpdatedAt', 'procStart',
  // bilinen, kullanılmayan
  'version', 'nameSince', 'formerNames', 'pidDomain', 'peerProtocol', 'peerFeatures', 'messagingSocketPath',
  'asksForConvertedSkills',
]);

/** Bozuk JSON bu kadar süre değişmeden kalırsa yarım yazım değil, format sorunu sayılır. */
const JSON_STABLE_MS = 2000;

const FILE_RE = /^\d+\.json$/;
const PID_REUSE_TOLERANCE_MS = 5000;
const warnedStatuses = new Set<string>();

/** Saniye cinsinden gelen zamanları ms'ye çevirir (< 1e12 → saniye kabul). */
function toMs(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  return v < 1e12 ? Math.round(v * 1000) : v;
}
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
/** Status değeri rapora yalnızca kısa enum biçimindeyse girer. */
const statusName = (v: string): string => (v.length <= 32 && /^[a-z_][a-z0-9_-]*$/i.test(v) ? v : '‹değer›');

/**
 * Tüm alan erişimleri burada (format değişirse tek nokta).
 * Zorunlu alanlar yoksa null döner.
 */
export function parseEntry(
  raw: unknown,
  file: string,
): { entry: RegistryEntry; interactive: boolean } | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const j = raw as Record<string, unknown>;
  const sessionId = str(j['sessionId']);
  const pid = j['pid'];
  if (!sessionId || typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;

  const kind = j['kind'];
  // 07/01: arka plan session'ları registry'de `kind: "bg"` + `jobId` (= attach kimliği) ile yazılır (Claude Code 2.1.312).
  // Kimliği olmayan arka plan kaydı uygulamada açılamaz; eskisi gibi elenir.
  const jobId = str(j['jobId']);
  const background = (kind === 'bg' || kind === 'background') && jobId !== null && BG_ID_RE.test(jobId);
  const interactive =
    (kind === undefined || kind === null || kind === 'interactive' || background) &&
    j['spare'] !== true &&
    !str(j['hostSessionId']);

  const rawStatus = typeof j['status'] === 'string' ? (j['status'] as string) : 'busy';
  let status: RegistryEntry['status'];
  if (rawStatus === 'busy' || rawStatus === 'idle' || rawStatus === 'waiting') status = rawStatus;
  else if (rawStatus === 'shell') status = 'idle'; // turu bitti, yalnızca arka plan shell'i çalışıyor
  else {
    status = 'busy';
    if (!warnedStatuses.has(rawStatus)) {
      warnedStatuses.add(rawStatus);
      console.warn(`[registry] bilinmeyen status değeri "${rawStatus}" busy sayıldı`);
    }
  }

  const wf = j['waitingFor'];
  const waitingForRaw =
    typeof wf === 'string' ? wf : wf !== undefined && wf !== null ? JSON.stringify(wf) : null;
  const updatedAt = toMs(j['updatedAt']);

  return {
    interactive,
    entry: {
      sessionId,
      pid,
      status,
      rawStatus,
      waitingForRaw,
      name: str(j['name']),
      nameSource: str(j['nameSource']),
      cwd: str(j['cwd']),
      entrypoint: str(j['entrypoint']),
      startedAt: toMs(j['startedAt']),
      updatedAt,
      statusSince: toMs(j['statusUpdatedAt']) ?? updatedAt,
      statusUpdatedAt: toMs(j['statusUpdatedAt']),
      procStart: typeof j['procStart'] === 'string' || typeof j['procStart'] === 'number' ? String(j['procStart']) : null,
      jobId: background ? jobId : null,
      file,
    },
  };
}

const sameEntry = (a: RegistryEntry, b: RegistryEntry): boolean =>
  a.pid === b.pid &&
  a.status === b.status &&
  a.rawStatus === b.rawStatus &&
  a.waitingForRaw === b.waitingForRaw &&
  a.name === b.name &&
  a.nameSource === b.nameSource &&
  a.cwd === b.cwd &&
  a.entrypoint === b.entrypoint &&
  a.startedAt === b.startedAt &&
  a.updatedAt === b.updatedAt &&
  a.statusSince === b.statusSince &&
  a.procStart === b.procStart &&
  (a.jobId ?? null) === (b.jobId ?? null) &&
  a.file === b.file;

export class RegistryWatcher extends EventEmitter {
  private readonly paths: ClaudePaths;
  private readonly pollMs: number;
  private readonly now: () => number;
  private readonly isAlive: (pid: number) => boolean;
  private readonly processStartMs: (pid: number) => Promise<number | null>;
  private readonly procStartToken: (pid: number) => Promise<string | null>;

  private cache = new Map<string, CacheItem>();
  /** JSON olarak okunamayan dosyalar → mtime (cache'e yazılmazlar; her taramada yeniden denenir). */
  private badJson = new Map<string, number>();
  private current = new Map<string, RegistryEntry>();
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private scanning: Promise<void> | null = null;
  private rescan = false;
  private stopped = true;

  constructor(paths: ClaudePaths, opts: RegistryWatcherOptions = {}) {
    super();
    this.paths = paths;
    this.pollMs = opts.pollMs ?? 5000;
    this.now = opts.now ?? Date.now;
    this.isAlive = opts.isAlive ?? realIsAlive;
    this.processStartMs = opts.processStartMs ?? realProcessStartMs;
    // processStartMs enjekte edilip procStartToken edilmediyse (eski testler, fixture'lar) gerçek /proc okunmasın.
    this.procStartToken = opts.procStartToken ?? (opts.processStartMs ? async () => null : realProcStartToken);
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.refresh();
    this.ensureWatcher();
    // Yedek poll: FSEvents olay kaçırabilir; klasör yoksa oluşmasını da bu timer yakalar.
    this.timer = setInterval(() => {
      this.ensureWatcher();
      void this.refresh();
    }, this.pollMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.timer = null;
    this.debounce = null;
    const w = this.watcher;
    this.watcher = null;
    if (w) await w.close();
    if (this.scanning) await this.scanning.catch(() => undefined);
  }

  list(): RegistryEntry[] {
    return [...this.current.values()];
  }

  /** 09/01: format sağlığı (son taramaya göre; canlılık anlık). */
  health(): RegistryHealth {
    const h: RegistryHealth = { files: this.cache.size, parsed: 0, live: 0, shapeErrors: 0, jsonErrors: 0, unknownStatus: {} };
    for (const item of this.cache.values()) {
      if (item.pid === null) {
        h.shapeErrors++;
        continue;
      }
      h.parsed++;
      if (!item.reuseDead && this.isAlive(item.pid)) h.live++;
      if (item.rawStatus !== null && !KNOWN_REGISTRY_STATUSES.has(item.rawStatus)) {
        const k = statusName(item.rawStatus);
        h.unknownStatus[k] = (h.unknownStatus[k] ?? 0) + 1;
      }
    }
    // mtime dosya sisteminin saati: motorun (testte sahte) saatiyle değil, duvar saatiyle karşılaştırılır.
    const wall = Date.now();
    for (const [name, mtime] of this.badJson) {
      if (!this.cache.has(name)) h.files++;
      if (wall - mtime >= JSON_STABLE_MS) h.jsonErrors++;
    }
    return h;
  }

  get(sessionId: string): RegistryEntry | undefined {
    return this.current.get(sessionId);
  }

  /** Hemen bir tarama yapar (aynı anda tek tarama; sırada bekleyen varsa bir kez daha). */
  refresh(): Promise<void> {
    if (this.scanning) {
      this.rescan = true;
      return this.scanning;
    }
    this.scanning = (async () => {
      try {
        do {
          this.rescan = false;
          await this.scan();
        } while (this.rescan && !this.stopped);
      } finally {
        this.scanning = null;
      }
    })();
    return this.scanning;
  }

  private ensureWatcher(): void {
    if (this.watcher || this.stopped || !fs.existsSync(this.paths.sessions)) return;
    this.watcher = chokidar.watch(this.paths.sessions, {
      depth: 0,
      ignoreInitial: true,
      followSymlinks: false,
      awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 20 },
    });
    const kick = () => {
      if (this.debounce) clearTimeout(this.debounce);
      this.debounce = setTimeout(() => void this.refresh(), 30);
    };
    this.watcher.on('add', kick).on('change', kick).on('unlink', kick).on('error', () => undefined);
  }

  private async scan(): Promise<void> {
    let names: string[];
    try {
      names = (await fs.promises.readdir(this.paths.sessions)).filter((n) => FILE_RE.test(n));
    } catch {
      names = [];
    }

    const superseded: RegistryDiff['superseded'] = [];
    const present = new Set(names);

    for (const name of names) {
      const file = path.join(this.paths.sessions, name);
      let st: fs.Stats;
      try {
        st = await fs.promises.stat(file);
      } catch {
        present.delete(name);
        continue;
      }
      const prev = this.cache.get(name);
      if (prev && prev.mtimeMs === st.mtimeMs) continue; // değişmemiş: okuma yok

      let parsed: ReturnType<typeof parseEntry>;
      try {
        parsed = parseEntry(JSON.parse(await fs.promises.readFile(file, 'utf8')), file);
      } catch {
        // Yarım yazılmış dosya: cache'e yazma, sonraki taramada tekrar dene.
        this.badJson.set(name, st.mtimeMs);
        continue;
      }
      this.badJson.delete(name);
      const item: CacheItem = {
        mtimeMs: st.mtimeMs,
        entry: parsed && parsed.interactive ? parsed.entry : null,
        pid: parsed ? parsed.entry.pid : null,
        sessionId: parsed ? parsed.entry.sessionId : null,
        interactive: parsed ? parsed.interactive : false,
        reuseDead: false,
        startChecked: false,
        rawStatus: parsed ? parsed.entry.rawStatus : null,
      };
      if (prev && prev.pid === item.pid) {
        // Aynı süreç: pid reuse kararı geçerliliğini korur.
        item.startChecked = prev.startChecked;
        item.reuseDead = prev.reuseDead;
      }
      // Aynı süreç, yeni session id: compact/resume sonrası aynı sohbet devam ediyor.
      if (
        prev &&
        prev.pid !== null &&
        prev.pid === item.pid &&
        prev.sessionId &&
        item.sessionId &&
        prev.sessionId !== item.sessionId &&
        item.interactive
      ) {
        superseded.push({ from: prev.sessionId, to: item.sessionId });
      }
      this.cache.set(name, item);
    }
    for (const name of [...this.cache.keys()]) if (!present.has(name)) this.cache.delete(name);
    for (const name of [...this.badJson.keys()]) if (!present.has(name)) this.badJson.delete(name);

    // Canlı ve filtreyi geçen kayıtlar; aynı sessionId için updatedAt büyük olan kazanır.
    const next = new Map<string, RegistryEntry>();
    for (const item of this.cache.values()) {
      const e = item.entry;
      if (!e || item.reuseDead) continue;
      if (!this.isAlive(e.pid)) continue;
      if (!item.startChecked) {
        item.startChecked = true;
        const token = e.procStart !== null ? await this.procStartToken(e.pid) : null;
        // Kesin yol: süreç belirteci registry'dekiyle uyuşmuyorsa pid başka bir sürece geçmiş.
        const same = token !== null && e.procStart !== null ? sameProcessStart(token, e.procStart) : null;
        if (same === false) {
          item.reuseDead = true;
          continue;
        }
        if (same === null && e.startedAt !== null) {
          const started = await this.processStartMs(e.pid);
          if (started !== null && Math.abs(started - e.startedAt) > PID_REUSE_TOLERANCE_MS) {
            item.reuseDead = true; // eski dosya, yeni ve alakasız süreç
            continue;
          }
        }
      }
      const other = next.get(e.sessionId);
      if (!other || (e.updatedAt ?? 0) > (other.updatedAt ?? 0)) next.set(e.sessionId, e);
    }

    const diff: RegistryDiff = { added: [], updated: [], removed: [], superseded };
    for (const [sid, e] of next) {
      const old = this.current.get(sid);
      if (!old) diff.added.push(e);
      else if (!sameEntry(old, e)) diff.updated.push(e);
    }
    const endedAt = this.now();
    for (const [sid, old] of this.current) {
      if (!next.has(sid)) diff.removed.push({ sessionId: sid, pid: old.pid, endedAt });
    }
    this.current = next;

    if (diff.added.length || diff.updated.length || diff.removed.length || diff.superseded.length) {
      this.emit('change', diff);
    }
  }

  override on(ev: 'change', cb: (d: RegistryDiff) => void): this;
  override on(ev: string | symbol, cb: (...args: never[]) => void): this;
  override on(ev: string | symbol, cb: (...args: never[]) => void): this {
    return super.on(ev, cb as (...args: unknown[]) => void);
  }
}
