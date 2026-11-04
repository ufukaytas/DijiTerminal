// `claude agents --json` okuyucu
// Arka plan session'larının kimliği ve canlı durumu registry'den gelir (kind "bg", jobId). Bu modül yalnızca
// registry'de olmayan `state` bilgisini (done/failed…) seyrek okur. Çağrı başına ≈0,15 sn CPU (Mac, 2.1.312):
// arka plan session'ı yokken 5 dk, varken görünürken 30 sn / gizliyken 90 sn; registry değişince hemen.
// Saf Node: electron importu yok.
import { BG_ID_RE } from '@shared/ipc';
import type { CliExec, ResolvedClaude } from './claudeCli';
import { realExec } from './claudeCli';

export interface AgentsEntry {
  id: string;
  sessionId: string | null;
  kind: string;
  pid: number | null;
  cwd: string | null;
  name: string | null;
  state: string | null;
  status: string | null;
  startedAt: number | null;
}

const warned = new Set<string>();
const KNOWN_KIND = new Set(['interactive', 'background']);
// 'blocked': girdi/onay bekliyor (Mac'te görüldü, 2.1.312).
const KNOWN_STATE = new Set(['running', 'blocked', 'done', 'failed', 'stopped']);

const s = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/**
 * Savunmacı ayrıştırma: dizi değilse boş liste; bozuk öğe atlanır; bilinmeyen `kind`/`state` ham tutulur ve bir kez
 * uyarılır (değer yazılır, içerik değil). `name` ve `cwd` yalnızca UI için taşınır, loglanmaz.
 */
export function parseAgentsJson(stdout: string): AgentsEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: AgentsEntry[] = [];
  for (const it of raw) {
    if (typeof it !== 'object' || it === null || Array.isArray(it)) continue;
    const j = it as Record<string, unknown>;
    const id = s(j['id']);
    const kind = s(j['kind']);
    if (!id || !kind) continue;
    if (!KNOWN_KIND.has(kind)) warnOnce(`kind:${kind}`, `[agents] bilinmeyen kind değeri "${kind}"`);
    const state = s(j['state']);
    if (state && !KNOWN_STATE.has(state)) warnOnce(`state:${state}`, `[agents] bilinmeyen state değeri "${state}"`);
    const pid = j['pid'];
    const started = j['startedAt'];
    out.push({
      id,
      sessionId: s(j['sessionId']),
      kind,
      pid: typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : null,
      cwd: s(j['cwd']),
      name: s(j['name']),
      state,
      status: s(j['status']),
      startedAt:
        typeof started === 'number' && Number.isFinite(started)
          ? started < 1e12
            ? started * 1000
            : started
          : typeof started === 'string'
            ? Date.parse(started) || null
            : null,
    });
  }
  return out;
}

function warnOnce(key: string, msg: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(msg);
}

/** Yalnızca BG_ID_RE'ye uyan arka plan kayıtları; kimlik küçük harfe çevrilir. */
export function backgroundEntries(entries: AgentsEntry[]): AgentsEntry[] {
  return entries.filter((e) => e.kind === 'background' && BG_ID_RE.test(e.id)).map((e) => ({ ...e, id: e.id.toLowerCase() }));
}

/** Arka plan kimliği → state (yalnızca BG_ID_RE'ye uyan arka plan kayıtları). */
export function backgroundStates(entries: AgentsEntry[]): Map<string, string | null> {
  const m = new Map<string, string | null>();
  for (const e of backgroundEntries(entries)) m.set(e.id, e.state);
  return m;
}

export type AgentsStatus = 'idle' | 'ok' | 'error' | 'unavailable';

export interface AgentsPollerLike {
  start(): void;
  stop(): void;
  /** Hemen bir okuma (aynı anda tek çağrı; çağrı sürerken gelen istek bir sonrakine birleşir). */
  pollNow(): Promise<void>;
  setSlow(slow: boolean): void;
  /** Registry'de arka plan session'ı var mı (aralık seçimi). */
  setActive(active: boolean): void;
  /**
   * Arka plan session listesi değişti. İşçisi kapalı (`pid: null`, ör. `done`) session'lar registry'de yoktur ama
   * `claude attach` onları yeniden başlatır; motor bunları da gösterir.
   */
  onUpdate(cb: (background: AgentsEntry[]) => void): () => void;
  status(): AgentsStatus;
}

export interface AgentsPollerOptions {
  cli: () => Promise<ResolvedClaude | null>;
  exec?: CliExec;
  /** ms; testler için. */
  activeMs?: number;
  inactiveMs?: number;
  slowFactor?: number;
  backoffMs?: number;
  now?: () => number;
}

export class AgentsPoller implements AgentsPollerLike {
  private readonly o: Required<Omit<AgentsPollerOptions, 'exec'>> & { exec: CliExec };
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private slow = false;
  private active = false;
  /** start() çağrıldı: zamanlayıcı kurulur. */
  private started = false;
  /** stop() çağrıldı: süren döngü yeniden çağırmaz. */
  private disposed = false;
  private failures = 0;
  private backoffUntil = 0;
  private st: AgentsStatus = 'idle';
  private cbs = new Set<(list: AgentsEntry[]) => void>();
  private lastKey = '';

  constructor(opts: AgentsPollerOptions) {
    this.o = {
      cli: opts.cli,
      exec: opts.exec ?? realExec,
      activeMs: opts.activeMs ?? 30_000,
      inactiveMs: opts.inactiveMs ?? 5 * 60_000,
      slowFactor: opts.slowFactor ?? 3,
      backoffMs: opts.backoffMs ?? 5 * 60_000,
      now: opts.now ?? Date.now,
    };
  }

  start(): void {
    this.started = true;
    this.disposed = false;
    this.schedule();
  }

  stop(): void {
    this.started = false;
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  status(): AgentsStatus {
    return this.st;
  }

  setSlow(slow: boolean): void {
    if (this.slow === slow) return;
    this.slow = slow;
    this.schedule();
  }

  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    this.schedule();
  }

  onUpdate(cb: (list: AgentsEntry[]) => void): () => void {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }

  /** Şu anki aralık (ms). */
  interval(): number {
    const base = this.active ? this.o.activeMs : this.o.inactiveMs;
    return this.active && this.slow ? base * this.o.slowFactor : base;
  }

  pollNow(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.once();
        } while (this.again && !this.disposed);
      } finally {
        this.running = null;
        this.schedule();
      }
    })();
    return this.running;
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.started) return;
    const wait = Math.max(this.interval(), this.backoffUntil - this.o.now());
    this.timer = setTimeout(() => void this.pollNow(), wait);
    this.timer.unref?.();
  }

  private async once(): Promise<void> {
    if (this.o.now() < this.backoffUntil) return;
    const cli = await this.o.cli();
    if (!cli) {
      this.st = 'unavailable';
      return;
    }
    const r = await this.o.exec(cli.path, ['agents', '--json', '--all'], {
      timeoutMs: 8000,
      env: cli.env,
      maxBuffer: 2 * 1024 * 1024,
    });
    if (!r.ok) {
      this.failures++;
      this.st = 'error';
      if (this.failures >= 3) {
        this.backoffUntil = this.o.now() + this.o.backoffMs;
        this.failures = 0;
        console.warn(
          `[agents] claude agents --json art arda başarısız (kod ${String(r.code)}); ${Math.round(this.o.backoffMs / 1000)} sn ara verildi`,
        );
      }
      return;
    }
    this.failures = 0;
    this.st = 'ok';
    const list = backgroundEntries(parseAgentsJson(r.stdout));
    const key = JSON.stringify(list.map((e) => [e.id, e.state, e.sessionId, e.cwd, e.name, e.pid]).sort());
    if (key === this.lastKey) return;
    this.lastKey = key;
    for (const cb of this.cbs) {
      try {
        cb(list);
      } catch (e) {
        console.error('[agents] dinleyici:', e);
      }
    }
  }
}
