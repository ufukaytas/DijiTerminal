// Kullanım limitleri
// Faz 1 statusLine betiği (hooks/statusline.sh) Claude Code'un status JSON'unu, "rate_limits" içeriyorsa,
// app data klasörüne limits.json olarak atomik yazar. Burada yalnızca rate_limits parse edilir; dosyadaki
// model/cwd/session gibi diğer alanlar belleğe alınmaz. Kimlik bilgisi okunmaz, ağ isteği yok. Saf Node.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { LimitWindow, UsageLimits } from '@shared/types';

export const LIMITS_STALE_MS = 6 * 3_600_000;
const DEBOUNCE_MS = 150;

function window(raw: unknown): LimitWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const pct = r['used_percentage'];
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return null;
  let resets = typeof r['resets_at'] === 'number' && Number.isFinite(r['resets_at']) ? (r['resets_at'] as number) : 0;
  if (resets > 0 && resets < 1e12) resets *= 1000; // saniye → ms
  return { pct: Math.min(100, Math.max(0, pct)), resetsAt: resets };
}

/** statusLine JSON'u → UsageLimits. `rate_limits` yoksa ya da iki pencere de geçersizse null. */
export function parseLimits(json: unknown, mtimeMs: number): UsageLimits | null {
  if (!json || typeof json !== 'object') return null;
  const rl = (json as Record<string, unknown>)['rate_limits'];
  if (!rl || typeof rl !== 'object') return null;
  const r = rl as Record<string, unknown>;
  const fiveHour = window(r['five_hour']);
  const week = window(r['seven_day']);
  if (!fiveHour && !week) return null;
  return { fiveHour, week, at: mtimeMs };
}

export function isStale(l: UsageLimits, now: number): boolean {
  return now - l.at > LIMITS_STALE_MS;
}

/** statusLine JSON'unda `rate_limits` nesnesi var mı (09/01: çözümlenemeyen statusLine ayrımı). */
export function hasRateLimits(json: unknown): boolean {
  if (!json || typeof json !== 'object') return false;
  const rl = (json as Record<string, unknown>)['rate_limits'];
  return !!rl && typeof rl === 'object';
}

export function sameLimits(a: UsageLimits | null, b: UsageLimits | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const w = (x: LimitWindow | null, y: LimitWindow | null) => (x === null || y === null ? x === y : x.pct === y.pct && x.resetsAt === y.resetsAt);
  return a.at === b.at && w(a.fiveHour, b.fiveHour) && w(a.week, b.week);
}

export interface LimitsReaderOptions {
  filePath: string;
  /** mtime yoklama aralığı; 0 → zamanlayıcı yok (testler). Varsayılan 15 sn. */
  pollMs?: number;
  /** false → fs.watch kurulmaz (testler). */
  watch?: boolean;
  readFile?: (p: string) => Promise<string>;
  /** Dosya yoksa null. */
  statMtime?: (p: string) => Promise<number | null>;
}

const defaultStat = async (p: string): Promise<number | null> => {
  try {
    return (await fs.promises.stat(p)).mtimeMs;
  } catch {
    return null;
  }
};

/** limits.json izleyici. 'change' olayı: UsageLimits | null (yalnızca değer değiştiğinde). */
export class LimitsReader extends EventEmitter {
  private readonly file: string;
  private readonly pollMs: number;
  private readonly useWatch: boolean;
  private readonly readFile: (p: string) => Promise<string>;
  private readonly statMtime: (p: string) => Promise<number | null>;
  private value: UsageLimits | null = null;
  private lastMtime: number | null = null;
  private watcher: fs.FSWatcher | null = null;
  private poll: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private reading: Promise<void> | null = null;
  private stopped = true;

  constructor(opts: LimitsReaderOptions) {
    super();
    this.file = opts.filePath;
    this.pollMs = opts.pollMs ?? 15_000;
    this.useWatch = opts.watch ?? true;
    this.readFile = opts.readFile ?? ((p) => fs.promises.readFile(p, 'utf8'));
    this.statMtime = opts.statMtime ?? defaultStat;
  }

  current(): UsageLimits | null {
    return this.value;
  }

  /** İlk okumayı bekler; sonra dizin izleme + yoklama. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.readNow();
    if (this.stopped) return;
    if (this.useWatch) {
      try {
        // Atomik mv dosyanın inode'unu değiştirir: dosyayı değil dizini izle.
        this.watcher = fs.watch(path.dirname(this.file), { persistent: false }, (_ev, f) => {
          if (f && String(f) !== path.basename(this.file)) return;
          this.schedule();
        });
        this.watcher.on('error', () => {
          this.watcher?.close();
          this.watcher = null;
        });
      } catch {
        this.watcher = null; // dizin yok: yoklama yakalar
      }
    }
    if (this.pollMs > 0) {
      this.poll = setInterval(() => void this.checkMtime(), this.pollMs);
      this.poll.unref?.();
    }
  }

  stop(): void {
    this.stopped = true;
    this.watcher?.close();
    this.watcher = null;
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
  }

  /** Dosyayı şimdi oku (uyanış, testler). Eşzamanlı çağrılar tek okumada birleşir. */
  readNow(): Promise<void> {
    this.reading ??= this.read().finally(() => {
      this.reading = null;
    });
    return this.reading;
  }

  private schedule(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.readNow();
    }, DEBOUNCE_MS);
  }

  private async checkMtime(): Promise<void> {
    const m = await this.statMtime(this.file);
    if (m !== this.lastMtime) await this.readNow();
  }

  private async read(): Promise<void> {
    const mtime = await this.statMtime(this.file);
    this.lastMtime = mtime;
    if (mtime === null) {
      this.set(null); // dosya yok (statusLine kurulmamış ya da silinmiş)
      return;
    }
    let text: string;
    try {
      text = await this.readFile(this.file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') this.set(null);
      return; // diğer okuma hataları: önceki değer korunur
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      this.emit('unparsed'); // 09/01 uyumluluk sinyali (manual modda da: motor dinleyicileri stop'ta kaldırır)
      return; // bozuk/yarım JSON: önceki değer korunur
    }
    const v = parseLimits(json, mtime);
    // rate_limits hiç yoksa normal (API anahtarı kullanıcısı); var ama okunamıyorsa format değişmiş olabilir.
    if (v === null && hasRateLimits(json)) this.emit('unparsed');
    this.set(v);
  }

  private set(v: UsageLimits | null): void {
    if (sameLimits(this.value, v)) return;
    this.value = v;
    if (!this.stopped) this.emit('change', v);
  }
}
