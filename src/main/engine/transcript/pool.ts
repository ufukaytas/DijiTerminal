// Transcript dosya havuzu
//
// - boot: bugün değişmiş jsonl'leri (+ canlı session dosyalarını) en eski oluşturulandan başlayarak okur;
//   böylece kopyalanmış geçmiş onu ilk yazan session'a atanır. Oluşturulma zamanı güvenilmez olabilir
//   (macOS'ta kopyalama/geri yükleme onu taşır); resume/fork zincirlerinde sıra içerikten düzeltilir (orderForBoot).
// - uuid → sahip session haritası ile resume/fork sonrası kopyalanan kayıtları çift saymaz.
// - chokidar + yedek timer'larla yalnızca yeni byte'ları okur.
// Salt okunur: yalnızca open('r'), stat, readdir.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { ClaudePaths } from '../paths';
import { TranscriptCursor, type RawRecord } from './cursor';

export interface RecordsBatch {
  path: string;
  sessionId: string;
  agentId: string | null;
  records: RawRecord[];
}

export interface PoolStats {
  files: number;
  bytesRead: number;
  parseErrors: number;
  lastBootMs: number;
  owners: number;
}

export interface TranscriptPoolOptions {
  now?: () => number;
  /** Dosya başına olay birleştirme süresi (ms). */
  debounceMs?: number;
  /** Aktif dosyaların yedek okuma aralığı (ms). */
  activeIntervalMs?: number;
  /** Tam tarama aralığı (ms). */
  scanIntervalMs?: number;
  /** Boot sıralama anahtarı (test için enjekte edilebilir; varsayılan: oluşturulma zamanı). */
  birthKey?: (file: string) => Promise<number>;
}

const MAX_DEPTH = 6;
const ACTIVE_WINDOW_MS = 30 * 60_000;

/** projects altında gezilmeyecek klasörler: memory ve adında nokta olanlar. */
const skipDir = (name: string): boolean => name === 'memory' || name.includes('.');

export class TranscriptPool extends EventEmitter {
  private readonly paths: ClaudePaths;
  private readonly now: () => number;
  private readonly debounceMs: number;
  private readonly activeIntervalMs: number;
  private readonly scanIntervalMs: number;
  private readonly birthKey: (file: string) => Promise<number>;

  private cursors = new Map<string, TranscriptCursor>();
  /** Registry'de canlı session dosyaları: kayıt zamanı eski olsa da yedek timer'la okunur. */
  private live = new Set<string>();
  private owner = new Map<string, string>(); // uuid → sessionId
  private supersedeSent = new Set<string>();
  private running = new Map<string, Promise<void>>();
  private again = new Set<string>();
  private timers: NodeJS.Timeout[] = [];
  private debounces = new Map<string, NodeJS.Timeout>();
  private watcher: FSWatcher | null = null;
  private dayStart = 0;
  private lastScan = 0;
  private lastBootMs = 0;
  private stopped = false;
  /** Gizli pencere (05/02): yedek timer'lar 3 turda bir çalışır; chokidar olayları aynen işlenir. */
  private slow = false;
  private tickNo = 0;

  constructor(paths: ClaudePaths, opts: TranscriptPoolOptions = {}) {
    super();
    this.paths = paths;
    this.now = opts.now ?? Date.now;
    this.debounceMs = opts.debounceMs ?? 50;
    this.activeIntervalMs = opts.activeIntervalMs ?? 10_000;
    this.scanIntervalMs = opts.scanIntervalMs ?? 60_000;
    this.birthKey = opts.birthKey ?? birthKey;
  }

  /** Bugün değişmiş dosyaları ve verilen canlı session dosyalarını en eskiden yeniye okur. */
  async boot(dayStart: number, extraFiles: string[] = []): Promise<void> {
    const t0 = Date.now();
    this.dayStart = dayStart;
    const files = new Set(await this.collect(dayStart));
    for (const f of extraFiles) if (fs.existsSync(f)) files.add(f);

    for (const file of await orderForBoot([...files], this.paths, this.birthKey)) {
      const c = this.cursorFor(file);
      if (c) await this.pumpCursor(c);
    }
    this.lastScan = this.now();
    this.lastBootMs = Date.now() - t0;
  }

  /** chokidar + yedek timer'lar. */
  watch(): void {
    if (this.watcher || this.stopped) return;
    const projects = this.paths.projects;
    this.watcher = chokidar.watch(projects, {
      ignoreInitial: true,
      followSymlinks: false,
      depth: MAX_DEPTH,
      ignored: (p: string) => {
        const rel = path.relative(projects, p);
        if (!rel || rel.startsWith('..')) return false;
        return rel.split(path.sep).some((seg, i, all) => i < all.length - 1 && skipDir(seg)) || path.basename(p) === 'memory';
      },
    });
    this.watcher
      .on('add', (p: string) => {
        if (!p.endsWith('.jsonl')) return;
        this.emit('file-added', p);
        this.schedule(p);
      })
      .on('change', (p: string) => {
        if (p.endsWith('.jsonl')) this.schedule(p);
      })
      .on('unlink', (p: string) => {
        this.cursors.delete(p);
        this.live.delete(p);
      })
      .on('error', () => undefined);

    const active = setInterval(() => {
      if (this.slow && ++this.tickNo % 3 !== 0) return;
      const now = this.now();
      for (const c of this.cursors.values()) {
        if (now - c.lastRecordTs < ACTIVE_WINDOW_MS || this.live.has(c.path)) void this.pumpCursor(c);
      }
    }, this.activeIntervalMs);
    let scanNo = 0;
    const full = setInterval(() => {
      if (this.slow && ++scanNo % 3 !== 0) return;
      void this.rescan();
    }, this.scanIntervalMs);
    active.unref?.();
    full.unref?.();
    this.timers.push(active, full);
  }

  /** Registry'den yeni canlı session gelince dosyasını izlemeye al ve oku (02/07). */
  async ensure(filePath: string): Promise<void> {
    this.live.add(filePath);
    const had = this.cursors.has(filePath);
    const c = this.cursorFor(filePath);
    if (!c) return;
    if (!had && fs.existsSync(filePath)) this.emit('file-added', filePath);
    await this.pumpCursor(c);
  }

  /** Tüm dosyaları hemen tarar ve yeni byte'ları okur (testler ve elle tetikleme; watcher gerektirmez). */
  async pumpAll(): Promise<void> {
    for (const f of await this.collect(0)) {
      const c = this.cursorFor(f);
      if (c) await this.pumpCursor(c);
    }
    await Promise.allSettled([...this.running.values()]);
  }

  setSlow(slow: boolean): void {
    this.slow = slow;
  }

  /** Gün dönümü: uuid haritası sıfırlanır (bellek sınırı). */
  rollDay(dayStart: number): void {
    this.dayStart = dayStart;
    this.owner.clear();
    this.supersedeSent.clear();
  }

  stats(): PoolStats {
    let bytesRead = 0;
    let parseErrors = 0;
    for (const c of this.cursors.values()) {
      bytesRead += c.bytesRead;
      parseErrors += c.parseErrors;
    }
    return { files: this.cursors.size, bytesRead, parseErrors, lastBootMs: this.lastBootMs, owners: this.owner.size };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const t of this.debounces.values()) clearTimeout(t);
    this.debounces.clear();
    const w = this.watcher;
    this.watcher = null;
    if (w) await w.close();
    await Promise.allSettled([...this.running.values()]);
  }

  override on(ev: 'records', cb: (b: RecordsBatch) => void): this;
  override on(ev: 'supersede', cb: (s: { from: string; to: string }) => void): this;
  override on(ev: 'file-added', cb: (path: string) => void): this;
  override on(ev: string | symbol, cb: (...args: never[]) => void): this;
  override on(ev: string | symbol, cb: (...args: never[]) => void): this {
    return super.on(ev, cb as (...args: unknown[]) => void);
  }

  // ---------- iç ----------

  private cursorFor(filePath: string): TranscriptCursor | null {
    const existing = this.cursors.get(filePath);
    if (existing) return existing;
    const c = TranscriptCursor.fromPath(filePath, this.paths);
    if (c) this.cursors.set(filePath, c);
    return c;
  }

  private schedule(filePath: string): void {
    const t = this.debounces.get(filePath);
    if (t) clearTimeout(t);
    this.debounces.set(
      filePath,
      setTimeout(() => {
        this.debounces.delete(filePath);
        const c = this.cursorFor(filePath);
        if (c) void this.pumpCursor(c);
      }, this.debounceMs),
    );
  }

  /** Dosya başına tek pump; çalışırken gelen istek bittikten sonra bir kez daha çalışır. */
  private pumpCursor(c: TranscriptCursor): Promise<void> {
    const inflight = this.running.get(c.path);
    if (inflight) {
      this.again.add(c.path);
      return inflight;
    }
    const run = (async () => {
      try {
        do {
          this.again.delete(c.path);
          const records = await c.pump({ dayStart: this.dayStart }, (chunk) => this.ingestRecords(c, chunk));
          if (records.length) this.ingestRecords(c, records);
        } while (this.again.has(c.path) && !this.stopped);
      } catch (e) {
        console.warn(`[transcript] ${path.basename(c.path)} okunamadı: ${(e as Error).message}`);
      } finally {
        this.running.delete(c.path);
      }
    })();
    this.running.set(c.path, run);
    return run;
  }

  /** uuid sahipliği: başka session'a ait kayıt atlanır; ana dosyada bu bir resume/fork işaretidir. */
  private ingestRecords(c: TranscriptCursor, records: RawRecord[]): void {
    const kept: RawRecord[] = [];
    for (const rec of records) {
      const uuid = typeof rec['uuid'] === 'string' ? rec['uuid'] : null;
      if (uuid) {
        const owner = this.owner.get(uuid);
        if (owner !== undefined) {
          if (owner !== c.sessionId && c.agentId === null) {
            const key = `${owner}>${c.sessionId}`;
            if (!this.supersedeSent.has(key)) {
              this.supersedeSent.add(key);
              this.emit('supersede', { from: owner, to: c.sessionId });
            }
          }
          continue; // aynı kayıt daha önce sayıldı (kopya ya da yeniden okuma)
        }
        this.owner.set(uuid, c.sessionId);
      }
      kept.push(rec);
    }
    if (kept.length) {
      const batch: RecordsBatch = { path: c.path, sessionId: c.sessionId, agentId: c.agentId, records: kept };
      this.emit('records', batch);
    }
  }

  private async rescan(): Promise<void> {
    const since = this.lastScan - 5000;
    this.lastScan = this.now();
    for (const f of await this.collect(since)) {
      const c = this.cursorFor(f);
      if (c) await this.pumpCursor(c);
    }
  }

  private async collect(sinceMs: number): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isFile() && e.name.endsWith('.jsonl')) {
          try {
            const st = await fs.promises.stat(p);
            if (st.mtimeMs >= sinceMs) out.push(p);
          } catch {
            /* silinmiş olabilir */
          }
        } else if (e.isDirectory() && depth < MAX_DEPTH && !skipDir(e.name)) {
          await walk(p, depth + 1);
        }
      }
    };
    await walk(this.paths.projects, 0);
    return out;
  }
}

const UUID_RE = /"uuid":"([0-9a-fA-F-]{36})"/g;
const HEAD_TAIL = 64 * 1024;

async function readRange(file: string, from: 'head' | 'tail'): Promise<string> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const len = Math.min(size, HEAD_TAIL);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, from === 'head' ? 0 : size - len);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

async function firstUuid(file: string): Promise<string | null> {
  try {
    const m = new RegExp(UUID_RE.source).exec(await readRange(file, 'head'));
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Dosyanın son (en fazla 3) farklı kayıt uuid'si. */
async function tailUuids(file: string): Promise<string[]> {
  try {
    const all = [...(await readRange(file, 'tail')).matchAll(UUID_RE)].map((m) => m[1] as string);
    const out: string[] = [];
    for (let i = all.length - 1; i >= 0 && out.length < 3; i--) {
      const u = all[i] as string;
      if (!out.includes(u)) out.push(u);
    }
    return out;
  } catch {
    return [];
  }
}

/** Dosya içinde iğnelerin hepsi geçiyor mu (parça sınırlarını örterek akışla). */
async function fileContainsAll(file: string, needles: string[]): Promise<boolean> {
  if (needles.length === 0) return false;
  const bufs = needles.map((n) => Buffer.from(`"uuid":"${n}"`));
  const found = new Set<number>();
  const overlap = Math.max(...bufs.map((b) => b.length));
  let fh: fs.promises.FileHandle | null = null;
  try {
    fh = await fs.promises.open(file, 'r');
    const chunk = Buffer.alloc(4 * 1024 * 1024);
    let carry = Buffer.alloc(0);
    let pos = 0;
    for (;;) {
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, pos);
      if (bytesRead === 0) return false;
      pos += bytesRead;
      const hay = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
      bufs.forEach((b, i) => {
        if (!found.has(i) && hay.indexOf(b) !== -1) found.add(i);
      });
      if (found.size === bufs.length) return true;
      carry = hay.subarray(Math.max(0, hay.length - overlap));
    }
  } catch {
    return false;
  } finally {
    await fh?.close();
  }
}

/**
 * Boot okuma sırası. Temel: oluşturulma zamanı. Ancak aynı ilk uuid'yi paylaşan ana session dosyaları
 * (resume/fork zinciri) içerikten sıralanır: X'in son kayıtlarının hepsi Y'nin içinde geçiyorsa X geçmişin asıl sahibidir
 * ve önce okunur. Böylece oluşturulma zamanı ters olsa da (kopyalanmış/geri yüklenmiş dosyalar) sahiplik doğru kalır.
 */
export async function orderForBoot(
  files: string[],
  paths: ClaudePaths,
  keyOf: (file: string) => Promise<number> = birthKey,
): Promise<string[]> {
  const keyed: { file: string; born: number }[] = [];
  for (const file of files) keyed.push({ file, born: await keyOf(file) });
  keyed.sort((a, b) => a.born - b.born || a.file.localeCompare(b.file));

  const groups = new Map<string, number[]>();
  for (let i = 0; i < keyed.length; i++) {
    const k = keyed[i] as { file: string; born: number };
    const c = TranscriptCursor.fromPath(k.file, paths);
    if (!c || c.agentId !== null) continue;
    const fu = await firstUuid(k.file);
    if (!fu) continue;
    const g = groups.get(fu) ?? [];
    g.push(i);
    groups.set(fu, g);
  }

  for (const idx of groups.values()) {
    if (idx.length < 2) continue;
    const members = idx.map((i) => keyed[i] as { file: string; born: number });
    const tails = new Map<string, string[]>();
    for (const m of members) tails.set(m.file, await tailUuids(m.file));
    const rank = new Map<string, number>();
    for (const x of members) {
      let r = 0;
      for (const y of members) {
        if (y === x) continue;
        // x, y'nin son kayıtlarının hepsini içeriyor → y'nin geçmişi x'e kopyalanmış, y önce gelir.
        // (Hepsi: devam eden dosyanın son kayıtları sınırdaki ortak kaydı içerebilir; tek eşleşme yetmez.)
        if (await fileContainsAll(x.file, tails.get(y.file) ?? [])) r++;
      }
      rank.set(x.file, r);
    }
    const sorted = [...members].sort((a, b) => (rank.get(a.file) ?? 0) - (rank.get(b.file) ?? 0) || a.born - b.born);
    idx.forEach((slot, j) => {
      keyed[slot] = sorted[j] as { file: string; born: number };
    });
  }
  return keyed.map((k) => k.file);
}

/** Sıralama anahtarı: oluşturulma zamanı; bazı dosya sistemlerinde 0 → ilk kaydın zaman damgası. */
async function birthKey(file: string): Promise<number> {
  try {
    const st = await fs.promises.stat(file);
    if (st.birthtimeMs > 0) return st.birthtimeMs;
    const fh = await fs.promises.open(file, 'r');
    try {
      const buf = Buffer.alloc(64 * 1024);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      const m = /"timestamp":"([^"]+)"/.exec(buf.subarray(0, bytesRead).toString('utf8'));
      const t = m && m[1] ? Date.parse(m[1]) : NaN;
      return Number.isFinite(t) ? t : st.mtimeMs;
    } finally {
      await fh.close();
    }
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}
