// Süreç denetçisi — 02/06. Tek `ps` çağrısıyla süreç tablosunu örnekler; her Claude pid'i için
// tty'yi ve ata zincirinden terminal uygulamasını (iTerm2/Terminal) bulur, CPU ve belleği raporlar.
// Saf Node: electron importu yok. `ps` execFile ile, shell olmadan çağrılır; komut satırına dış veri girmez.
import { execFile } from 'node:child_process';
import path from 'node:path';
import type { TerminalApp, TerminalRef } from '@shared/types';
import { isAlive as realIsAlive } from './proc-start';

export interface ProcessDescription {
  terminal: TerminalRef | null;
  cpuPct: number | null;
  memMb: number | null;
  alive: boolean;
}

/** SessionEngine'in kullandığı alt küme. */
export interface ProcessInspectorLike {
  start(): void;
  stop(): void;
  sampleNow(): Promise<void>;
  describe(pid: number): ProcessDescription;
  /** Yeni örnek alındığında çağrılır; dönüş: aboneliği kaldır. */
  onSample(cb: () => void): () => void;
  /** Pencere görünmüyorken (05/02) örnekleme seyrekleşir; görünür olunca hemen örnekler. */
  setSlow?(slow: boolean): void;
  /** 09/01: terminale bağlı Claude Code süreç sayısı (son taze örnek); örnek yoksa null. */
  claudeCount?(): number | null;
}

/** Gizliyken örnekleme aralığı ve bayatlık eşiği bu katsayıyla çarpılır (05/02: güvenlik poll'ları 3 kat seyrek). */
export const SLOW_FACTOR = 3;

/** Testler ve DemoEngine için: terminal bilinmiyor, canlılık registry'den. */
export class NoopProcessInspector implements ProcessInspectorLike {
  start(): void {}
  stop(): void {}
  async sampleNow(): Promise<void> {}
  describe(_pid: number): ProcessDescription {
    return { terminal: null, cpuPct: null, memMb: null, alive: true };
  }
  onSample(_cb: () => void): () => void {
    return () => undefined;
  }
}

export interface ProcRow {
  pid: number;
  ppid: number;
  tty: string;
  cpu: number;
  rssKb: number;
  comm: string;
}

export const PS_ARGS = ['-axo', 'pid=,ppid=,tty=,%cpu=,rss=,comm='] as const;
const ROW_RE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d.,]+)\s+(\d+)\s+(.+?)\s*$/;
const MAX_DEPTH = 6;

/** `ps -axo pid=,ppid=,tty=,%cpu=,rss=,comm=` çıktısı → pid tablosu. comm boşluk içerebilir (son sütun). */
export function parsePs(stdout: string): Map<number, ProcRow> {
  const table = new Map<number, ProcRow>();
  for (const line of stdout.split('\n')) {
    const m = ROW_RE.exec(line);
    if (!m) continue;
    const [, pid, ppid, tty, cpu, rss, comm] = m;
    table.set(Number(pid), {
      pid: Number(pid),
      ppid: Number(ppid),
      tty: tty ?? '',
      cpu: Number(String(cpu).replace(',', '.')), // bazı yerel ayarlarda ondalık virgül
      rssKb: Number(rss),
      comm: comm ?? '',
    });
  }
  return table;
}

/** `ttys004` → `/dev/ttys004`; `??`, `?`, `-`, boş → null. */
export function normalizeTty(raw: string): string | null {
  const t = raw.trim();
  if (!t || t === '??' || t === '?' || t === '-') return null;
  return t.startsWith('/dev/') ? t : `/dev/${t}`;
}

/** Süreç adından terminal uygulaması. */
export function classifyComm(comm: string): TerminalApp | null {
  const base = path.basename(comm.trim());
  if (base.startsWith('iTermServer') || base === 'iTerm2' || base === 'iTerm') return 'iterm2';
  if (base === 'Terminal') return 'terminal';
  return null;
}

/** pid'in tty'si + ata zincirinde (en fazla 6 seviye) ilk tanınan terminal uygulaması. */
export function resolveTerminal(pid: number, table: Map<number, ProcRow>): TerminalRef | null {
  const row = table.get(pid);
  if (!row) return null;
  const tty = normalizeTty(row.tty);
  let app: TerminalApp | null = null;
  const seen = new Set<number>([pid]);
  let cur = row.ppid;
  for (let depth = 0; depth < MAX_DEPTH && cur > 1 && !seen.has(cur); depth++) {
    seen.add(cur);
    const r = table.get(cur);
    if (!r) break;
    app = classifyComm(r.comm);
    if (app) break;
    cur = r.ppid;
  }
  return { app: app ?? (tty ? 'other' : 'unknown'), tty, pid };
}

/**
 * Süreç Claude Code'a benziyor mu? Bilgi amaçlı; canlılık kararında KULLANILMAZ.
 * Yerel kurulumda süreç adı sürüm numarası (ör. `2.1.5`), npm kurulumunda `node` olabilir;
 * pid reuse kontrolü registry'nin procStart/startedAt alanlarıyla yapılır (02/01).
 */
export function isClaudeProcess(row: ProcRow): boolean {
  const base = path.basename(row.comm).toLowerCase();
  return base.startsWith('claude') || base === 'node' || base === 'bun' || /^\d+\.\d+\.\d+/.test(base);
}

/**
 * 09/01 çelişki sinyali için katı eşleşme: süreç adı `claude*` ya da sürüm numarası (yerel kurulum) ve terminale bağlı.
 * `node`/`bun` sayılmaz (başka araçlar olabilir); tty'siz süreçler (daemon, arka plan işçisi) registry yazmayabilir.
 */
export function isInteractiveClaude(row: ProcRow): boolean {
  const base = path.basename(row.comm).toLowerCase();
  return (base.startsWith('claude') || /^\d+\.\d+\.\d+/.test(base)) && normalizeTty(row.tty) !== null;
}

export type ExecFn = (cmd: string, args: readonly string[]) => Promise<string>;

const realExec: ExecFn = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, [...args], { timeout: 2000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });

export interface ProcessInspectorOptions {
  intervalMs?: number;
  /** Tablo bu süreden eskiyse terminal bilgisi verilmez. */
  staleMs?: number;
  exec?: ExecFn;
  now?: () => number;
  isAlive?: (pid: number) => boolean;
  /** Yalnızca macOS'ta anlamlı; başka platformda örnekleme yapılmaz, terminal null. */
  platform?: NodeJS.Platform;
}

export class ProcessInspector implements ProcessInspectorLike {
  private table = new Map<number, ProcRow>();
  private refCache = new Map<number, { ppid: number; ref: TerminalRef | null }>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private listeners = new Set<() => void>();
  private _lastOkAt = 0;
  private _lastError: string | null = null;
  private readonly intervalMs: number;
  private readonly staleMs: number;
  private readonly exec: ExecFn;
  private readonly now: () => number;
  private readonly alive: (pid: number) => boolean;
  private readonly supported: boolean;
  private slow = false;

  constructor(opts: ProcessInspectorOptions = {}) {
    this.intervalMs = opts.intervalMs ?? 3000;
    this.staleMs = opts.staleMs ?? 10_000;
    this.exec = opts.exec ?? realExec;
    this.now = opts.now ?? Date.now;
    this.alive = opts.isAlive ?? realIsAlive;
    const platform = opts.platform ?? process.platform;
    this.supported = platform === 'darwin' || platform === 'linux';
  }

  get lastOkAt(): number {
    return this._lastOkAt;
  }
  get lastError(): string | null {
    return this._lastError;
  }

  start(): void {
    if (this.running || !this.supported) return;
    this.running = true;
    void this.loop();
  }

  private async loop(): Promise<void> {
    await this.sampleNow();
    if (this.running) this.timer = setTimeout(() => void this.loop(), this.intervalMs * (this.slow ? SLOW_FACTOR : 1));
  }

  setSlow(slow: boolean): void {
    if (this.slow === slow) return;
    this.slow = slow;
    // Görünür olunca beklemeden taze tablo (cpu/bellek, sekme bilgisi); gizlenince sıradaki tur seyrek kurulur.
    if (!slow && this.running) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      void this.loop();
    }
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async sampleNow(): Promise<void> {
    if (!this.supported) return;
    try {
      const out = await this.exec('/bin/ps', PS_ARGS);
      this.table = parsePs(out);
      for (const pid of [...this.refCache.keys()]) if (!this.table.has(pid)) this.refCache.delete(pid);
      this._lastOkAt = this.now();
      this._lastError = null;
    } catch (e) {
      // Tablo silinmez: describe bayatlık eşiğine kadar eski tabloyu kullanır.
      this._lastError = e instanceof Error ? e.message : String(e);
    }
    for (const cb of this.listeners) cb();
  }

  describe(pid: number): ProcessDescription {
    const alive = this.alive(pid);
    const fresh = this._lastOkAt > 0 && this.now() - this._lastOkAt <= this.staleMs * (this.slow ? SLOW_FACTOR : 1);
    const row = fresh ? this.table.get(pid) : undefined;
    if (!row) return { terminal: null, cpuPct: null, memMb: null, alive };
    let cached = this.refCache.get(pid);
    if (!cached || cached.ppid !== row.ppid) {
      cached = { ppid: row.ppid, ref: resolveTerminal(pid, this.table) };
      this.refCache.set(pid, cached);
    }
    return { terminal: cached.ref, cpuPct: row.cpu, memMb: Math.round(row.rssKb / 1024), alive };
  }

  onSample(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  claudeCount(): number | null {
    const fresh = this._lastOkAt > 0 && this.now() - this._lastOkAt <= this.staleMs * (this.slow ? SLOW_FACTOR : 1);
    if (!fresh) return null;
    let n = 0;
    for (const r of this.table.values()) if (isInteractiveClaude(r)) n++;
    return n;
  }

  childrenOf(pid: number): number[] {
    const out: number[] = [];
    for (const r of this.table.values()) if (r.ppid === pid) out.push(r.pid);
    return out;
  }

  descendantsOf(pid: number, depth = 5): number[] {
    const out: number[] = [];
    let frontier = [pid];
    const seen = new Set<number>([pid]);
    for (let d = 0; d < depth && frontier.length; d++) {
      const next: number[] = [];
      for (const p of frontier) {
        for (const c of this.childrenOf(p)) {
          if (seen.has(c)) continue;
          seen.add(c);
          out.push(c);
          next.push(c);
        }
      }
      frontier = next;
    }
    return out;
  }
}
