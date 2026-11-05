// Hook olaylarını okuma
// Faz 1 hook betiğinin (hooks/dijiterminal-hook.sh) yazdığı hook-events.jsonl'i tail eder ve her satırı
// BoardStore'a uygulanacak geçici (provizyonel) bir durum geçişine çevirir. Saf Node: electron yok.
//
// Rotasyon: betik dosyayı 5 MB'ta kendisi `hook-events.jsonl.1`'e taşıyor (01/01). Uygulama ayrıca döndürmez;
// iki ayrı süreç döndürürse yarış olur. Okuyucu ino değişimini görünce eski dosyanın okunmamış kuyruğunu
// `.1`'den tamamlar, sonra yeni dosyaya geçer.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { HookEventLine, SessionStatus } from '@shared/types';

export type HookEventName =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Notification'
  | 'Stop'
  | 'SubagentStop'
  | 'PreCompact'
  | 'SessionEnd';

const EVENT_NAMES = new Set<string>([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SubagentStop',
  'PreCompact',
  'SessionEnd',
]);

export type ParsedHookLine = HookEventLine & { event: HookEventName };

export interface HookTransition {
  sessionId: string;
  at: number;
  /** null = durum değiştirmeyen olay (SessionStart, SubagentStop, PreCompact). */
  to: SessionStatus | null;
  event: HookEventName;
  /** true: mevcut durum waiting ise uygulanmaz (PreToolUse izin beklemeden önce de gelir). */
  soft?: boolean;
  waitingFor?: { tool: string; label: string; since: number };
  /** Registry'den önce gelen olaylar için ön kayıt. */
  seed?: { cwd: string; tty: string | null; claudePid: number };
}

export type HookIngestStatus = 'active' | 'missing' | 'error';

/** Gelen dosya güvenilmez: her alan doğrulanır. */
const SESSION_RE = /^[0-9a-f-]{36}$/i;
export const TTY_RE = /^\/dev\/ttys\d{3,4}$/;
const MESSAGE_MAX = 200;
const TOOL_MAX = 100;
/** Bu kadar eski satırlar durum için anlamsız (uygulama kapalıyken ya da uykuda birikenler). */
export const STALE_LINE_MS = 120_000;
/** İlk açılışta dosya sonundan geriye bu kadar okunur. */
export const BACKFILL_BYTES = 64 * 1024;
const READ_CHUNK = 1024 * 1024;
const REST_MAX = 64 * 1024;
const BAD_WARN_EVERY = 100;

/** Claude Code'un `notification_type` değerleri; yoksa mesaj kalıplarına bakılır. */
const NOTIFY_TYPE: Record<string, 'waiting' | 'idle' | null> = {
  permission_prompt: 'waiting',
  elicitation_dialog: 'waiting',
  idle_prompt: 'idle',
  auth_success: null,
};
const WAIT_PATTERNS = ['permission', 'izin', 'approve', 'onay', 'needs your'];
const IDLE_PATTERNS = ['waiting for your input', 'girdinizi bekliyor'];

/** Bekleme anlamına gelen araçlar: kullanıcı yanıt verene kadar Claude durur (01/01 ile aynı kural). */
const WAITING_TOOLS: Record<string, string> = { ExitPlanMode: 'plan onayı', AskUserQuestion: 'soru' };

const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : undefined);

export interface ParseResult {
  line: ParsedHookLine | null;
  /** v !== 1: betik biçimi değişmiş. */
  unsupportedVersion?: boolean;
}

export function parseHookLineDetailed(line: string): ParseResult {
  const t = line.trim();
  if (!t) return { line: null };
  let j: unknown;
  try {
    j = JSON.parse(t);
  } catch {
    return { line: null };
  }
  if (typeof j !== 'object' || j === null || Array.isArray(j)) return { line: null };
  const o = j as Record<string, unknown>;
  if (o['v'] !== 1) return { line: null, unsupportedVersion: typeof o['v'] === 'number' };
  const ts = o['ts'];
  const event = o['event'];
  const sessionId = o['sessionId'];
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return { line: null };
  if (typeof event !== 'string' || !EVENT_NAMES.has(event)) return { line: null };
  if (typeof sessionId !== 'string' || !SESSION_RE.test(sessionId)) return { line: null };
  const cwd = typeof o['cwd'] === 'string' ? o['cwd'] : '';
  const ttyRaw = o['tty'];
  const tty = typeof ttyRaw === 'string' && TTY_RE.test(ttyRaw) ? ttyRaw : null;
  const pidRaw = o['claudePid'];
  const claudePid = typeof pidRaw === 'number' && Number.isInteger(pidRaw) && pidRaw > 0 ? pidRaw : 0;
  const out: ParsedHookLine = { v: 1, ts, event: event as HookEventName, sessionId: sessionId.toLowerCase(), cwd, tty, claudePid };
  const tool = str(o['tool'], TOOL_MAX);
  const message = str(o['message'], MESSAGE_MAX);
  const notificationType = str(o['notificationType'], 40);
  if (tool) out.tool = tool;
  if (message) out.message = message;
  if (notificationType) out.notificationType = notificationType;
  return { line: out };
}

export function parseHookLine(line: string): ParsedHookLine | null {
  return parseHookLineDetailed(line).line;
}

/**
 * Notification olayı ne anlama geliyor? `notification_type` varsa o; yoksa mesaj kalıpları.
 * Bilinmeyen mesaj → waiting: kullanıcıyı gereksiz uyarmak, beklediğini kaçırmaktan iyidir.
 */
export function classifyNotification(message?: string, type?: string): 'waiting' | 'idle' | null {
  if (type && type in NOTIFY_TYPE) return NOTIFY_TYPE[type] ?? null;
  const m = (message ?? '').toLocaleLowerCase('en');
  if (IDLE_PATTERNS.some((p) => m.includes(p))) return 'idle';
  if (WAIT_PATTERNS.some((p) => m.includes(p))) return 'waiting';
  return 'waiting';
}

/** "Claude needs your permission to use Bash" → "Bash". */
function toolFromMessage(message?: string): string {
  const m = /\buse\s+([A-Za-z_][\w.-]{0,60})/.exec(message ?? '');
  return m?.[1] ?? '';
}

export function toTransition(h: ParsedHookLine): HookTransition | null {
  const seed = { cwd: h.cwd, tty: h.tty, claudePid: h.claudePid };
  const base = { sessionId: h.sessionId, at: h.ts, event: h.event, seed };
  switch (h.event) {
    case 'SessionStart':
      // Yeni session da, compact/resume sonrası açılış da SessionStart üretir; ikincisinde Claude çalışıyor
      // olabilir. Durumu registry'ye bırak, yalnızca kartı erkenden göster.
      return { ...base, to: null };
    case 'UserPromptSubmit':
      return { ...base, to: 'busy' };
    case 'PreToolUse': {
      const label = h.tool ? WAITING_TOOLS[h.tool] : undefined;
      if (h.tool && label) return { ...base, to: 'waiting', waitingFor: { tool: h.tool, label, since: h.ts } };
      return { ...base, to: 'busy', soft: true };
    }
    case 'PostToolUse':
      return { ...base, to: 'busy' };
    case 'Notification': {
      const c = classifyNotification(h.message, h.notificationType);
      if (c === null) return null;
      if (c === 'idle') return { ...base, to: 'idle' };
      return { ...base, to: 'waiting', waitingFor: { tool: h.tool ?? toolFromMessage(h.message), label: h.message ?? '', since: h.ts } };
    }
    case 'Stop':
      return { ...base, to: 'idle' };
    case 'SubagentStop':
    case 'PreCompact':
      return { ...base, to: null };
    case 'SessionEnd':
      return { ...base, to: 'ended' };
    default:
      return null;
  }
}

/** Test edilebilirlik için dosya sistemi yüzeyi. */
export interface HookFs {
  stat(p: string): Promise<{ ino: number; size: number }>;
  read(p: string, start: number, length: number): Promise<Buffer>;
  watch?(dir: string, cb: (filename: string | null) => void): { close(): void };
}

export const nodeHookFs: HookFs = {
  async stat(p) {
    const st = await fs.promises.stat(p);
    return { ino: st.ino, size: st.size };
  },
  async read(p, start, length) {
    const fh = await fs.promises.open(p, 'r');
    try {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, start);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  },
  watch(dir, cb) {
    const w = fs.watch(dir, { persistent: false }, (_ev, f) => cb(f ? String(f) : null));
    w.on('error', () => undefined);
    return w;
  },
};

export interface HookIngestOptions {
  filePath: string;
  now?: () => number;
  fs?: HookFs;
  /** Emniyet ağı yoklaması (fs.watch macOS'ta rename sonrası kopabilir). 0 → zamanlayıcı yok (testler). */
  pollMs?: number;
  /** false → fs.watch kurulmaz (testler). */
  watch?: boolean;
}

/**
 * Olaylar: 'transition' (t: HookTransition), 'drain' (bir okuma turu bitti, n geçiş), 'status' (s: HookIngestStatus).
 */
export class HookIngest extends EventEmitter {
  private readonly file: string;
  private readonly now: () => number;
  private readonly fs: HookFs;
  private readonly pollMs: number;
  private readonly useWatch: boolean;
  private ino = -1;
  private offset = 0;
  private rest = '';
  /** Dosya kaybolduğunda (betik döndürdü, yenisi henüz yazılmadı) eski dosyanın konumu. */
  private lost: { ino: number; offset: number } | null = null;
  private st: HookIngestStatus = 'missing';
  private timer: NodeJS.Timeout | null = null;
  private watcher: { close(): void } | null = null;
  private reading: Promise<void> | null = null;
  private again = false;
  private running = false;
  private bad = 0;
  private versionWarned = false;
  /** Sayaçlar (tanılama, testler). */
  readonly counters = { lines: 0, transitions: 0, bad: 0, stale: 0 };

  constructor(opts: HookIngestOptions) {
    super();
    this.file = opts.filePath;
    this.now = opts.now ?? Date.now;
    this.fs = opts.fs ?? nodeHookFs;
    this.pollMs = opts.pollMs ?? 1000;
    this.useWatch = opts.watch ?? true;
  }

  status(): HookIngestStatus {
    return this.st;
  }

  /** İlk okumayı bekler; sonra fs.watch + yoklama. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.readNow();
    this.ensureWatch();
    if (this.pollMs > 0) {
      this.timer = setInterval(() => {
        this.ensureWatch();
        void this.readNow();
      }, this.pollMs);
      this.timer.unref?.();
    }
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.watcher?.close();
    this.watcher = null;
  }

  /** Yeni byte'ları oku. Eşzamanlı çağrılar tek okumada birleşir. */
  readNow(): Promise<void> {
    if (this.reading) {
      this.again = true;
      return this.reading;
    }
    this.reading = (async () => {
      try {
        do {
          this.again = false;
          await this.readOnce();
        } while (this.again);
      } finally {
        this.reading = null;
      }
    })();
    return this.reading;
  }

  private ensureWatch(): void {
    if (!this.useWatch || this.watcher || !this.fs.watch) return;
    const dir = path.dirname(this.file);
    const base = path.basename(this.file);
    try {
      this.watcher = this.fs.watch(dir, (f) => {
        if (f === null || f === base || f === `${base}.1`) void this.readNow();
      });
    } catch {
      this.watcher = null; // dizin henüz yok: yoklama dizin oluşunca yeniden dener
    }
  }

  private setStatus(s: HookIngestStatus): void {
    if (s === this.st) return;
    this.st = s;
    this.emit('status', s);
  }

  private async readOnce(): Promise<void> {
    let st: { ino: number; size: number };
    try {
      st = await this.fs.stat(this.file);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        // Silindi ya da hiç kurulmadı. Betik yeniden oluşturunca baştan okunur.
        if (this.ino > 0) {
          // "Vardı, kayboldu": yeni dosya baştan okunur (geri doldurma yok); eski kuyruk .1'den tamamlanır.
          this.lost = { ino: this.ino, offset: this.offset };
          this.ino = 0;
          this.offset = 0;
        }
        this.setStatus('missing');
        return;
      }
      this.setStatus('error');
      return;
    }

    let n = 0;
    if (this.ino === -1) {
      // İlk açılış: son 64 KB; ilk (muhtemelen yarım) satır atılır.
      this.ino = st.ino;
      this.offset = Math.max(0, st.size - BACKFILL_BYTES);
      if (this.offset > 0) {
        const head = await this.safeRead(this.file, this.offset, Math.min(st.size - this.offset, BACKFILL_BYTES));
        const nl = head ? head.indexOf(0x0a) : -1;
        this.offset = nl >= 0 ? this.offset + nl + 1 : st.size;
      }
    } else if (st.ino !== this.ino) {
      // Betik döndürdü (mv → .1) ya da dosya yeniden oluştu: eski dosyanın okunmamış kuyruğunu tamamla.
      const old = this.ino > 0 ? { ino: this.ino, offset: this.offset } : this.lost;
      if (old) n += await this.drainRotated(old.ino, old.offset);
      this.lost = null;
      this.ino = st.ino;
      this.offset = 0;
      this.rest = '';
    } else if (st.size < this.offset) {
      // Kesildi (truncate): baştan.
      this.offset = 0;
      this.rest = '';
    }
    this.setStatus('active');
    n += await this.readRange(this.file, st.size);
    this.emit('drain', n);
  }

  /** `.1` dosyası eski ino'muzsa kalan byte'ları oku. */
  private async drainRotated(ino: number, offset: number): Promise<number> {
    const old = `${this.file}.1`;
    try {
      const st = await this.fs.stat(old);
      if (st.ino !== ino || st.size <= offset) return 0;
      this.offset = offset;
      return await this.readRange(old, st.size);
    } catch {
      return 0;
    }
  }

  private async safeRead(p: string, start: number, length: number): Promise<Buffer | null> {
    try {
      return await this.fs.read(p, start, length);
    } catch {
      return null;
    }
  }

  private async readRange(p: string, end: number): Promise<number> {
    let n = 0;
    while (this.offset < end) {
      const len = Math.min(READ_CHUNK, end - this.offset);
      const buf = await this.safeRead(p, this.offset, len);
      if (!buf || buf.length === 0) break;
      this.offset += buf.length;
      n += this.consume(buf.toString('utf8'));
    }
    return n;
  }

  private consume(text: string): number {
    const parts = (this.rest + text).split('\n');
    this.rest = parts.pop() ?? '';
    if (this.rest.length > REST_MAX) this.rest = ''; // satır sonu olmayan çöp
    let n = 0;
    const cutoff = this.now() - STALE_LINE_MS;
    for (const raw of parts) {
      if (!raw.trim()) continue;
      this.counters.lines++;
      const r = parseHookLineDetailed(raw);
      if (!r.line) {
        if (r.unsupportedVersion && !this.versionWarned) {
          this.versionWarned = true;
          console.warn('[hookIngest] desteklenmeyen satır sürümü; bu satırlar atlanıyor');
        }
        this.counters.bad++;
        // 09/01: CompatMonitor sayar (geçersiz satır / desteklenmeyen satır sürümü).
        this.emit('bad', { unsupportedVersion: r.unsupportedVersion === true });
        if (++this.bad % BAD_WARN_EVERY === 0) console.warn(`[hookIngest] ${this.bad} geçersiz satır atlandı`);
        continue;
      }
      if (r.line.ts < cutoff) {
        this.counters.stale++;
        continue;
      }
      const t = toTransition(r.line);
      if (!t) continue;
      this.counters.transitions++;
      n++;
      this.emit('transition', t);
    }
    return n;
  }
}
