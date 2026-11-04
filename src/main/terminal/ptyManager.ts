// Gömülü terminal sekmeleri
// Her sekme kendi pty'sinde `claude attach <id>` çalıştırır. Session Claude Code'un arka plan servisinde yaşar;
// sekmeyi kapatmak yalnızca bu attach istemcisini kapatır. Son bağlanan devralır (Mac'te doğrulandı): başka bir
// terminal aynı session'a bağlanınca buradaki istemci çıkar → 'taken-over', otomatik yeniden bağlanma yok.
// Saf Node: electron ve node-pty importu yok (spawner enjekte edilir). pty çıktısı ve girdi hiçbir yere loglanmaz.
import { randomBytes } from 'node:crypto';
import type { TermExitReason } from '@shared/ipc';

export interface PtyProcess {
  readonly pid: number;
  onData(cb: (data: string) => void): { dispose(): void };
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}
export interface PtySpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
}
export type PtySpawn = (file: string, args: string[], opts: PtySpawnOptions) => Promise<PtyProcess>;

export interface OpenRequest {
  sessionId: string;
  bgId: string;
  cwd: string;
  cols: number;
  rows: number;
  claudePath: string;
  env: NodeJS.ProcessEnv;
}

export type OpenResult =
  { ok: true; termId: string; reused: boolean } | { ok: false; error: 'limit' | 'spawn-failed'; message: string };

export interface PtyManagerOptions {
  spawn: PtySpawn;
  maxOpen?: number;
  flushMs?: number;
  /** Gizliyken sekme başına tutulan en fazla çıktı (byte, yaklaşık: UTF-16 uzunluğu). */
  bufferBytes?: number;
  closeGraceMs?: number;
  resizeDebounceMs?: number;
  /** İstemci kullanıcı kapatmadan çıktığında session hâlâ arka planda mı (→ 'taken-over'). */
  stillBackground?: (sessionId: string) => boolean;
  newId?: () => string;
  onData: (termId: string, data: string) => void;
  onExit: (termId: string, reason: TermExitReason, code: number | null) => void;
}

interface Tab {
  termId: string;
  sessionId: string;
  bgId: string;
  proc: PtyProcess | null;
  subs: { dispose(): void }[];
  /** Kullanıcı kapattı (exit 'closed' sayılır). */
  closing: boolean;
  exited: boolean;
  pending: string;
  flushTimer: NodeJS.Timeout | null;
  hidden: string[];
  hiddenLen: number;
  overflow: boolean;
  /** Son ≈2 KB çıktı (yalnızca çıkış sınıflandırması için, ANSI temizlenmiş; dışarı verilmez). */
  tail: string;
  cols: number;
  rows: number;
  resizeTimer: NodeJS.Timeout | null;
  killTimer: NodeJS.Timeout | null;
  lastRedraw: number;
}

const TAIL_MAX = 2048;
const REDRAW_MIN_MS = 1000;
const FLUSH_MAX = 64 * 1024;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const NOT_FOUND_RE = /no (?:background )?session|ENOJOB|not found|no such (?:session|job)/i;

/** Çıkış nedeni: kullanıcı kapattı > session yok > başka terminal devraldı > diğer. */
export function classifyExit(t: { closing: boolean; tail: string }, stillBackground: boolean): TermExitReason {
  if (t.closing) return 'closed';
  if (NOT_FOUND_RE.test(t.tail)) return 'not-found';
  if (stillBackground) return 'taken-over';
  return 'exited';
}

export class PtyManager {
  private readonly o: Required<Omit<PtyManagerOptions, 'stillBackground'>> & Pick<PtyManagerOptions, 'stillBackground'>;
  private tabs = new Map<string, Tab>();
  private visible = true;

  constructor(opts: PtyManagerOptions) {
    this.o = {
      maxOpen: 6,
      flushMs: 16,
      bufferBytes: 256 * 1024,
      closeGraceMs: 2000,
      resizeDebounceMs: 50,
      newId: () => `t-${randomBytes(4).toString('hex')}`,
      ...opts,
    };
  }

  /** Canlı (çıkmamış) sekme sayısı. */
  openCount(): number {
    let n = 0;
    for (const t of this.tabs.values()) if (!t.exited) n++;
    return n;
  }

  has(termId: string): boolean {
    return this.tabs.has(termId);
  }

  /** Session'ın sekmesi (açık ya da çıkmış). */
  tabOf(sessionId: string): string | null {
    for (const t of this.tabs.values()) if (t.sessionId === sessionId) return t.termId;
    return null;
  }

  /**
   * Session için sekme açar. Açık sekme varsa onu döndürür; çıkmış sekme varsa aynı kimlikle yeniden bağlanır
   * ("buraya geri al" / "yeniden bağlan").
   */
  async open(req: OpenRequest): Promise<OpenResult> {
    const existingId = this.tabOf(req.sessionId);
    const existing = existingId ? this.tabs.get(existingId) : undefined;
    if (existing && !existing.exited) return { ok: true, termId: existing.termId, reused: true };
    if (!existing && this.openCount() >= this.o.maxOpen) {
      return { ok: false, error: 'limit', message: `En fazla ${this.o.maxOpen} terminal açık olabilir.` };
    }
    const tab: Tab = existing ?? {
      termId: this.o.newId(),
      sessionId: req.sessionId,
      bgId: req.bgId,
      proc: null,
      subs: [],
      closing: false,
      exited: false,
      pending: '',
      flushTimer: null,
      hidden: [],
      hiddenLen: 0,
      overflow: false,
      tail: '',
      cols: req.cols,
      rows: req.rows,
      resizeTimer: null,
      killTimer: null,
      lastRedraw: 0,
    };
    tab.bgId = req.bgId;
    tab.closing = false;
    tab.exited = false;
    tab.tail = '';
    tab.cols = req.cols;
    tab.rows = req.rows;
    this.tabs.set(tab.termId, tab);

    let proc: PtyProcess;
    try {
      proc = await this.o.spawn(req.claudePath, ['attach', req.bgId], {
        name: 'xterm-256color',
        cols: req.cols,
        rows: req.rows,
        cwd: req.cwd,
        env: req.env,
      });
    } catch (e) {
      tab.exited = true;
      // Ayrıntı yalnızca bir kez, mesajla (yol/izin sorunları); pty içeriği değil.
      console.error('[terminal] pty başlatılamadı:', e instanceof Error ? e.message : String(e));
      if (!existing) this.tabs.delete(tab.termId);
      return { ok: false, error: 'spawn-failed', message: 'Terminal başlatılamadı.' };
    }
    if (!this.tabs.has(tab.termId) || tab.closing) {
      // Spawn sürerken sekme kapatıldı.
      proc.kill('SIGHUP');
      return { ok: false, error: 'spawn-failed', message: 'Sekme kapatıldı.' };
    }
    tab.proc = proc;
    tab.subs = [proc.onData((d) => this.onData(tab, d)), proc.onExit((e) => this.onExit(tab, proc, e.exitCode))];
    return { ok: true, termId: tab.termId, reused: Boolean(existing) };
  }

  write(termId: string, data: string): boolean {
    const t = this.tabs.get(termId);
    if (!t || t.exited || !t.proc) return false;
    t.proc.write(data);
    return true;
  }

  resize(termId: string, cols: number, rows: number): boolean {
    const t = this.tabs.get(termId);
    if (!t) return false;
    t.cols = cols;
    t.rows = rows;
    if (t.resizeTimer) clearTimeout(t.resizeTimer);
    t.resizeTimer = setTimeout(() => {
      t.resizeTimer = null;
      if (!t.exited && t.proc) t.proc.resize(t.cols, t.rows);
    }, this.o.resizeDebounceMs);
    t.resizeTimer.unref?.();
    return true;
  }

  /** Yalnızca istemciyi kapatır (SIGHUP → süre dolunca SIGKILL); session çalışmaya devam eder. */
  close(termId: string): boolean {
    const t = this.tabs.get(termId);
    if (!t) return false;
    t.closing = true;
    this.tabs.delete(termId);
    this.clearTimers(t);
    if (!t.exited && t.proc) {
      const p = t.proc;
      try {
        p.kill('SIGHUP');
      } catch {
        // süreç zaten gitmiş
      }
      t.killTimer = setTimeout(() => {
        if (!t.exited) {
          try {
            p.kill('SIGKILL');
          } catch {
            // yok
          }
        }
      }, this.o.closeGraceMs);
      t.killTimer.unref?.();
    } else {
      this.dispose(t);
    }
    return true;
  }

  /** Uygulama kapanıyor: bütün istemcilere SIGHUP (session'lar yaşamaya devam eder). */
  closeAll(): void {
    for (const id of [...this.tabs.keys()]) this.close(id);
  }

  /**
   * Pencere görünürlüğü (05/02 ilkesi): gizliyken çıktı sekme başına tampona alınır, görünür olunca tek parça
   * gönderilir. Tampon taşarsa atılır, ekran sıfırlanır ve TUI'ye yeniden çizim yaptırılır (resize dürtmesi).
   */
  setVisible(v: boolean): void {
    if (this.visible === v) return;
    this.visible = v;
    if (!v) return;
    for (const t of this.tabs.values()) {
      if (t.overflow) {
        t.hidden = [];
        t.hiddenLen = 0;
        t.overflow = false;
        this.o.onData(t.termId, '\x1bc');
        this.nudgeRedraw(t);
      } else if (t.hiddenLen > 0) {
        const data = t.hidden.join('');
        t.hidden = [];
        t.hiddenLen = 0;
        this.o.onData(t.termId, data);
      }
    }
  }

  /**
   * Kullanıcı sekmeye döndü (odak, sekme seçimi): session'ı bu sekmenin boyutuyla yeniden çizdir.
   * Aynı session'a başka bir terminal de bağlıysa (iTerm2'de `claude attach`) ekran onun boyutunda çizilmiş olabilir.
   * Sekme başına saniyede en fazla bir kez.
   */
  redraw(termId: string): boolean {
    const t = this.tabs.get(termId);
    if (!t || t.exited || !t.proc) return false;
    const now = Date.now();
    if (now - t.lastRedraw < REDRAW_MIN_MS) return true;
    t.lastRedraw = now;
    this.nudgeRedraw(t);
    return true;
  }

  /** SIGWINCH ile TUI'nin ekranı yeniden çizmesini sağlar (cols-1 → cols). */
  nudgeRedraw(t: Tab): void {
    const p = t.proc;
    if (!p || t.exited) return;
    const cols = t.cols;
    const rows = t.rows;
    p.resize(Math.max(2, cols - 1), rows);
    // attach istemcisi yeni boyutu servise iletsin diye kısa bir ara (çok kısa olursa iki SIGWINCH birleşir).
    const timer = setTimeout(() => {
      if (!t.exited && t.proc === p) p.resize(cols, rows);
    }, 80);
    timer.unref?.();
  }

  private onData(t: Tab, d: string): void {
    t.tail = (t.tail + d.replace(ANSI_RE, '')).slice(-TAIL_MAX);
    if (!this.visible) {
      if (t.overflow) return;
      t.hidden.push(d);
      t.hiddenLen += d.length;
      if (t.hiddenLen > this.o.bufferBytes) t.overflow = true;
      return;
    }
    t.pending += d;
    if (t.pending.length >= FLUSH_MAX) {
      this.flush(t);
      return;
    }
    if (!t.flushTimer) {
      t.flushTimer = setTimeout(() => this.flush(t), this.o.flushMs);
      t.flushTimer.unref?.();
    }
  }

  private flush(t: Tab): void {
    if (t.flushTimer) clearTimeout(t.flushTimer);
    t.flushTimer = null;
    if (!t.pending) return;
    const data = t.pending;
    t.pending = '';
    if (this.visible) this.o.onData(t.termId, data);
    else {
      t.hidden.push(data);
      t.hiddenLen += data.length;
      if (t.hiddenLen > this.o.bufferBytes) t.overflow = true;
    }
  }

  private onExit(t: Tab, proc: PtyProcess, code: number): void {
    if (t.proc !== proc) return; // yeniden bağlanmadan önceki eski süreç
    this.flush(t);
    t.exited = true;
    for (const s of t.subs) s.dispose();
    t.subs = [];
    if (t.killTimer) clearTimeout(t.killTimer);
    t.killTimer = null;
    const reason = classifyExit(t, !t.closing && (this.o.stillBackground?.(t.sessionId) ?? false));
    t.tail = '';
    this.o.onExit(t.termId, reason, Number.isFinite(code) ? code : null);
  }

  private clearTimers(t: Tab): void {
    if (t.flushTimer) clearTimeout(t.flushTimer);
    if (t.resizeTimer) clearTimeout(t.resizeTimer);
    t.flushTimer = null;
    t.resizeTimer = null;
    t.pending = '';
    t.hidden = [];
    t.hiddenLen = 0;
  }

  private dispose(t: Tab): void {
    for (const s of t.subs) s.dispose();
    t.subs = [];
  }
}
