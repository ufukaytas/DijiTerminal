// Pano durum deposu
// Saf mantık: I/O yok, electron yok. Registry + transcript olayları + süreç bilgisi tek bir tutarlı görünüme
// (BoardSnapshot) ve anlık olay akışına (BoardEvent) dönüşür. Durum kuralları yalnızca burada uygulanır.
import path from 'node:path';
import { THRESHOLDS } from '@shared/constants';
import { SESSION_ID_RE } from '@shared/ipc';
import type {
  AgentView,
  BoardEvent,
  BoardSnapshot,
  FileConflict,
  FileHeat,
  LogEntry,
  ProjectView,
  SessionFlag,
  SessionStatus,
  SessionView,
  TerminalRef,
  ToolCall,
  UsageLimits,
  WaitingInfo,
} from '@shared/types';
import type { Clock } from './clock';
import type { EngineEvent } from './events';
import { TTY_RE, type HookTransition } from './hookIngest';
import { HotkeyPool } from './hotkeys';
import { sameLimits } from './limits';
import { costOf, ctxMaxFor, usageOf } from './pricing';
import type { ProcessDescription } from './process';
import type { ProjectResolver, ResolvedProject } from './projects';
import type { RegistryEntry } from './registry';
import type { SubagentTracker, TrackerChange } from './subagents';
import { shortModel } from './summarize';

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const RECENT_ACTIVITY_MS = 90_000;
/** 07/01: işçisi kapalı arka plan session'ı son etkinlikten bu kadar sonra haritadan kalkar. */
const DORMANT_VISIBLE_MS = 24 * 60 * 60_000;

/** Geçmiş tablosundaki arka plan session'ı (07/01). */
export type BackgroundHistoryItem = import('@shared/types').BackgroundHistoryItem;

/** `claude agents --json` arka plan öğesinin store'un kullandığı alanları. */
export interface BackgroundListItem {
  id: string;
  sessionId: string | null;
  cwd: string | null;
  name: string | null;
  state: string | null;
  startedAt: number | null;
}
const GC_AGE_MS = 24 * 3600_000;
const MAX_FILES = 500;
const MAX_EDITORS = 20;
const MINUTES_KEPT = 90;
const HOT_FILES = 8;
const STATUS_ORDER: Record<SessionStatus, number> = { waiting: 0, busy: 1, idle: 2, ended: 3 };
const SAY_MAX = 160;
/** Registry'de statusUpdatedAt yoksa hook durumu en fazla bu kadar geçerli (02/09). */
export const PROV_TTL_MS = 15_000;
/** Hiçbir kaynak doğrulamazsa bile hook durumu bundan uzun yaşamaz. */
export const PROV_MAX_MS = 10 * 60_000;
/** Hook ile kart açabilen olaylar (registry gelmeden). */
const SEED_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop']);

/** Hook'tan gelen geçici durum (02/09): registry daha yeni bir durum yazana kadar geçerli. */
interface Provisional {
  status: SessionStatus;
  at: number;
  waitingFor: { tool: string; label: string; since: number } | null;
}

interface SessionState {
  id: string;
  pid: number | null;
  live: boolean;
  reg: RegistryEntry | null;
  name: string;
  title: string;
  lastPrompt: string;
  cwd: string;
  project: ResolvedProject | null;
  branch: string | null;
  model: string;
  effort: string | null;
  startedAt: number;
  firstTs: number;
  lastTs: number;
  endedAt: number | null;
  /** Süreç kesin kapandı (registry'den düştü ya da pid öldü): son aktivite ne kadar yakın olursa olsun 'ended'. */
  closedAt: number | null;
  supersededBy: string | null;
  status: SessionStatus | null;
  statusSince: number;
  costUsd: number;
  toolCount: number;
  errorCount: number;
  prompts: number;
  ctxTokens: number;
  ctxMax: number | null;
  turnMs: number | null;
  terminal: TerminalRef | null;
  cpuPct: number | null;
  memMb: number | null;
  writes: Set<string>;
  agentCost: Map<string, number>;
  /** 02/09: hook'tan gelen geçici durum. */
  prov: Provisional | null;
  /** 02/09: registry'den önce hook'la açılan canlı session (registry görülene kadar). */
  seeded: boolean;
  /** 02/09: hook satırındaki tty (ProcessInspector bulamazsa sekmeye gitme için). */
  hookTty: string | null;
  /**
   * 07/01: işçisi kapalı arka plan session'ı (`claude agents --json`, `pid: null`): registry'de yok ama
   * `claude attach` ile açılabilir. Durumu 'idle' sayılır; işçi başlayınca registry kaydı devralır.
   */
  dormantBg: { id: string; state: string | null } | null;
}

interface MinuteBucket {
  tools: number;
  tokens: number;
  cost: number;
}

export interface BoardStoreDeps {
  clock: Clock;
  projects: ProjectResolver;
  subagents: SubagentTracker;
  /** Hata günlüğü (varsayılan console.error). */
  onError?: (where: string, e: unknown) => void;
}

/** Store'un dışarıdan sorgulanabilen (test, orkestratör) iç durumu. */
export interface SessionDebug {
  live: boolean;
  supersededBy: string | null;
  status: SessionStatus | null;
  projectRoot: string | null;
  toolCount: number;
}

export class BoardStore {
  private readonly clock: Clock;
  private readonly projects: ProjectResolver;
  private readonly tracker: SubagentTracker;
  private readonly onError: (where: string, e: unknown) => void;

  private sessions = new Map<string, SessionState>();
  private files = new Map<string, FileHeat>();
  private log: LogEntry[] = []; // eskiden yeniye
  private logById = new Map<string, LogEntry>();
  private minutes = new Map<number, MinuteBucket>();
  private seenUsage = new Set<string>();
  private seenRoots = new Set<string>();
  private hotkeys = new HotkeyPool();
  private limits: UsageLimits | null = null;
  private pidOwner = new Map<number, string>();
  private queue: BoardEvent[] = [];
  private costToday = 0;
  private booted = false;
  private day0: number;
  private logSeq = 0;
  /** Dosyası kayıtlarından önce görülen ajanların 'başladı' satırı: ilk kayıt gelince zamanı düzeltilir. */
  private spawnLogPending = new Map<string, string>();
  private _dirty = true;
  /** Durum hook'la değişti: snapshot throttle beklenmeden yayınlanmalı (02/09). */
  private _urgent = false;
  /** 07/01: `claude agents --json`'dan arka plan kimliği → state (done/failed…). Kimlik registry'den gelir. */
  private bgStates = new Map<string, string | null>();
  /** Son `claude agents --json` arka plan listesi: registry'den düşen session uyuyan olarak hemen yerine geçsin. */
  private bgList: BackgroundListItem[] = [];
  /**
   * 07/01: kullanıcının "kapat" dediği arka plan kimlikleri: uyurken haritada gösterilmez. Session yeniden çalışırsa
   * (registry'de canlı) listeden çıkar; `agents --json` listesinde artık olmayanlar budanır.
   */
  private dismissed = new Set<string>();
  private dismissedChanged = false;
  /**
   * Geçmişten "Aktif et" denen kimlikler: durdurulmuş, başarısız ya da 24 saatten eski olsa da uyuyan olarak gösterilir
   * (bellekte; yeniden kapatılınca ya da listeden düşünce çıkar).
   */
  private restored = new Set<string>();

  constructor(deps: BoardStoreDeps) {
    this.clock = deps.clock;
    this.projects = deps.projects;
    this.tracker = deps.subagents;
    this.onError = deps.onError ?? ((where, e) => console.error(`[store] ${where}:`, e));
    this.day0 = this.clock.dayStart();
  }

  get dirty(): boolean {
    return this._dirty;
  }

  markDirty(): void {
    this._dirty = true;
  }

  /** 02/08: statusLine'dan gelen kullanım limitleri (null → veri yok, UI çubukları gizler). */
  setLimits(l: UsageLimits | null): void {
    if (sameLimits(this.limits, l)) return;
    this.limits = l;
    this._dirty = true;
  }

  /** Son çağrıdan beri hook kaynaklı bir durum değişikliği oldu mu? (okununca sıfırlanır) */
  takeUrgent(): boolean {
    const u = this._urgent;
    this._urgent = false;
    return u;
  }

  setBooted(v: boolean): void {
    this.booted = v;
    if (!v) this.queue = [];
    this._dirty = true;
  }

  isBooted(): boolean {
    return this.booted;
  }

  dayStart(): number {
    return this.day0;
  }

  /** Subagent tracker'ın takım çözümü için. */
  rootOf(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.project?.root ?? null;
  }

  debugSession(sessionId: string): SessionDebug | null {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    return { live: s.live, supersededBy: s.supersededBy, status: s.status, projectRoot: s.project?.root ?? null, toolCount: s.toolCount };
  }

  /** Olay gelmeden önce session kaydı açar (subagent meta değişiklikleri için). */
  ensureSession(id: string): void {
    this.ensure(id);
  }

  liveSessions(): { sessionId: string; pid: number | null; cwd: string }[] {
    return [...this.sessions.values()].filter((s) => s.live).map((s) => ({ sessionId: s.id, pid: s.pid, cwd: s.cwd }));
  }

  // ---------- 07/01 arka plan session'ları ----------

  /**
   * `claude agents --json` arka plan listesi. Canlı (registry'de) session'ların yalnızca görüntülenen `state`'i
   * değişir. İşçisi kapalı olanlar (`done`, `pid: null`) son 24 saatte etkinse "uyuyan" olarak gösterilir;
   * başarısız ve durdurulmuşlar gösterilmez. Dönüş: transcript'i okunması gereken yeni uyuyan session'lar.
   */
  applyBackgroundList(list: BackgroundListItem[]): { sessionId: string; cwd: string }[] {
    this.bgList = list;
    const added = this.markDormant();
    this.updateStatuses();
    this._dirty = true;
    return added;
  }

  /** Kalıcı listeden (açılış) yükle. */
  setDismissedBackground(ids: Iterable<string>): void {
    this.dismissed = new Set([...ids].map((x) => x.toLowerCase()));
    if (this.bgList.length > 0) this.markDormant();
    this.updateStatuses();
    this._dirty = true;
  }

  /** "Session'ı kapat": uyuyan session haritadan kalkar (konuşma silinmez; `claude attach` ile dönülebilir). */
  dismissBackground(bgId: string): void {
    const id = bgId.toLowerCase();
    this.restored.delete(id);
    if (!this.dismissed.has(id)) {
      this.dismissed.add(id);
      this.dismissedChanged = true;
    }
    this.markDormant();
    this.updateStatuses();
    this._dirty = true;
  }

  /**
   * Geçmişten yeniden aktif et: kapatılanlardan çıkar ve gösterilmeye zorla. Dönüş: session kimliği ve transcript'i
   * okunacak yeni uyuyan session'lar (motor okur). Listede yoksa null.
   */
  restoreBackground(bgId: string): { sessionId: string; added: { sessionId: string; cwd: string }[] } | null {
    const id = bgId.toLowerCase();
    const e = this.bgList.find((x) => x.id === id);
    if (!e || !e.sessionId || !e.cwd || !SESSION_ID_RE.test(e.sessionId)) return null;
    if (this.dismissed.delete(id)) this.dismissedChanged = true;
    this.restored.add(id);
    const added = this.markDormant();
    this.updateStatuses();
    this._dirty = true;
    return { sessionId: e.sessionId, added };
  }

  /**
   * Haritada olmayan arka plan session'ları (kapatılan, durdurulan, başarısız, 24 saatten eski bitmiş) — en yeni üstte.
   * Ad: kullanıcının verdiği ad > Claude'un başlığı > klasör adı.
   */
  backgroundHistory(): BackgroundHistoryItem[] {
    const out: BackgroundHistoryItem[] = [];
    for (const e of this.bgList) {
      if (!e.sessionId) continue;
      const s = this.sessions.get(e.sessionId);
      const shown = Boolean(s && ((s.live && s.reg?.jobId) || s.dormantBg));
      if (shown) continue;
      const reason: BackgroundHistoryItem['reason'] = this.dismissed.has(e.id)
        ? 'closed'
        : e.state === 'stopped'
          ? 'stopped'
          : e.state === 'failed'
            ? 'failed'
            : 'old';
      const cwd = e.cwd ?? s?.cwd ?? '';
      out.push({
        id: e.id,
        sessionId: e.sessionId,
        name: e.name || (s ? displayName(s) : '') || (cwd ? path.basename(cwd) : e.id),
        title: s?.title || s?.lastPrompt || '',
        cwd,
        projectId: s?.project?.id ?? null,
        state: e.state,
        reason,
        startedAt: e.startedAt ?? s?.startedAt ?? null,
        lastTs: s?.lastTs || null,
        restorable: Boolean(e.cwd && SESSION_ID_RE.test(e.sessionId)),
      });
    }
    return out.sort((a, b) => (b.lastTs ?? b.startedAt ?? 0) - (a.lastTs ?? a.startedAt ?? 0));
  }

  dismissedBackground(): string[] {
    return [...this.dismissed].sort();
  }

  /** Kapatılan kimlikler değişti mi (okununca sıfırlanır; motor kalıcı dosyayı günceller). */
  takeDismissedChanged(): boolean {
    const c = this.dismissedChanged;
    this.dismissedChanged = false;
    return c;
  }

  private markDormant(): { sessionId: string; cwd: string }[] {
    const list = this.bgList;
    const now = this.clock.now();
    this.bgStates = new Map(list.map((e) => [e.id, e.state]));
    if (list.length > 0) {
      const ids = new Set(list.map((e) => e.id));
      for (const d of [...this.dismissed]) {
        if (!ids.has(d)) {
          this.dismissed.delete(d); // claude rm ile silinmiş ya da listeden düşmüş
          this.dismissedChanged = true;
        }
      }
      for (const r of [...this.restored]) if (!ids.has(r)) this.restored.delete(r);
    }
    const keep = new Set<string>();
    const added: { sessionId: string; cwd: string }[] = [];
    for (const e of list) {
      if (!e.sessionId || !e.cwd || !SESSION_ID_RE.test(e.sessionId)) continue;
      const forced = this.restored.has(e.id);
      if ((e.state === 'failed' || e.state === 'stopped') && !forced) continue;
      if (this.dismissed.has(e.id)) continue;
      const known = this.sessions.get(e.sessionId);
      if (known?.live && known.reg) continue; // işçi çalışıyor: registry yeterli
      if (known?.supersededBy && !forced) continue;
      const recent = Math.max(known?.lastTs ?? 0, e.startedAt ?? 0);
      if (now - recent > DORMANT_VISIBLE_MS && !forced) continue;
      const s = this.ensure(e.sessionId);
      const wasDormant = s.dormantBg !== null;
      s.dormantBg = { id: e.id, state: e.state };
      if (!s.cwd) this.setCwd(s, e.cwd);
      if (e.name && !s.name) s.name = e.name;
      if (!s.startedAt && e.startedAt) s.startedAt = e.startedAt;
      keep.add(s.id);
      if (!wasDormant) added.push({ sessionId: s.id, cwd: s.cwd });
    }
    for (const s of this.sessions.values()) if (s.dormantBg && !keep.has(s.id)) s.dormantBg = null;
    return added;
  }

  /** "App'te aç" hedefi: arka plan session'ının attach kimliği ve klasörü (canlı ya da uyuyan; yoksa null). */
  backgroundTarget(sessionId: string): { bgId: string; cwd: string; running: boolean } | null {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    const running = Boolean(s.live && s.reg?.jobId);
    const bgId = running ? (s.reg?.jobId ?? null) : !s.live || !s.reg ? (s.dormantBg?.id ?? null) : null;
    if (!bgId) return null;
    return { bgId, cwd: s.cwd, running };
  }

  /** Arka plan session'ı var mı — canlı ya da uyuyan (agents poller aralığı için). */
  hasBackground(): boolean {
    for (const s of this.sessions.values()) if ((s.live && s.reg?.jobId) || s.dormantBg) return true;
    return false;
  }

  // ---------- registry / süreç ----------

  /** Canlı kayıtların tam listesi (RegistryWatcher.list()). */
  applyRegistry(entries: RegistryEntry[]): void {
    const now = this.clock.now();
    const seen = new Set<string>();
    for (const e of entries) {
      seen.add(e.sessionId);
      const s = this.ensure(e.sessionId);
      const prevOwner = this.pidOwner.get(e.pid);
      if (prevOwner && prevOwner !== e.sessionId) this.supersede(prevOwner, e.sessionId);
      this.pidOwner.set(e.pid, e.sessionId);
      s.reg = e;
      s.live = true;
      // 07/01: kapatılmış arka plan session'ı yeniden çalışıyor (ör. iTerm2'den attach): yeniden gösterilir.
      if (e.jobId && this.dismissed.delete(e.jobId.toLowerCase())) this.dismissedChanged = true;
      s.seeded = false;
      s.endedAt = null;
      s.closedAt = null;
      s.pid = e.pid;
      if (e.name) s.name = e.name;
      if (e.startedAt) s.startedAt = e.startedAt;
      if (e.cwd && e.cwd !== s.cwd) this.setCwd(s, e.cwd);
      const regTs = Math.max(e.updatedAt ?? 0, e.statusSince ?? 0);
      if (regTs > s.lastTs) s.lastTs = regTs;
    }
    for (const s of this.sessions.values()) {
      // Hook'la açılmış ve registry'de hiç görülmemiş session canlı kalır (pid ölünce ProcessInspector kapatır).
      if (s.live && !seen.has(s.id) && !(s.seeded && !s.reg)) {
        s.live = false;
        s.reg = null;
        s.seeded = false;
        s.endedAt = now;
        // Claude Code registry dosyasını süreç kapanınca siler (terminal kapandı, /exit): kesin bitiş, 90 sn
        // "yakın aktivite" beklemesi yok. Aynı süreçte yeni sessionId (compact, /clear) ayrıca supersede ile gizlenir.
        s.closedAt = now;
      }
    }
    // 07/01: işçisi kapanan arka plan session'ı son bilinen listede varsa "sona erdi"ye düşmeden uyuyana geçer.
    if (this.bgList.length > 0) this.markDormant();
    this.assignHotkeys();
    this.updateStatuses();
    this._dirty = true;
  }

  applyProcess(sessionId: string, d: ProcessDescription): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.terminal = d.terminal;
    if (s.hookTty && !d.terminal?.tty) {
      // ps tty bulamadı (ya da süreç denetçisi yok): hook satırındaki tty ile sekmeye gidilebilsin.
      s.terminal = { app: d.terminal?.app ?? 'unknown', tty: s.hookTty, pid: d.terminal?.pid ?? s.pid ?? 0 };
    }
    s.cpuPct = d.cpuPct;
    s.memMb = d.memMb;
    if (!d.alive && s.live) {
      s.live = false;
      s.reg = null;
      s.seeded = false;
      s.prov = null;
      s.endedAt = this.clock.now();
      s.closedAt = s.endedAt;
      this.assignHotkeys();
      this.updateStatuses();
    }
    this._dirty = true;
  }

  /**
   * Hook olayı (02/09): registry'den saniyeler önce gelen geçici durum. Registry daha yeni bir durum yazınca
   * (statusUpdatedAt ≥ olay anı) ya da aynı durumu söyleyince silinir; registry statusUpdatedAt yazmıyorsa
   * en fazla PROV_TTL_MS yaşar.
   */
  applyHook(t: HookTransition): void {
    let s = this.sessions.get(t.sessionId);
    if (!s) {
      if (!t.seed || !SEED_EVENTS.has(t.event)) return;
      s = this.ensure(t.sessionId);
    }
    if (s.supersededBy && !s.live) return;
    const before = s.status;

    if (t.seed && SEED_EVENTS.has(t.event)) this.seedFromHook(s, t);
    if (t.at > s.lastTs) s.lastTs = t.at;

    switch (t.event) {
      case 'SubagentStop':
        this.applyTrackerChanges(this.tracker.hintStop(s.id, t.at));
        break;
      case 'PreCompact':
        this.pushLog({ ts: t.at, sessionId: s.id, agentId: null, kind: 'sys', label: 'context sıkıştırılıyor', state: 'run' });
        break;
      case 'SessionEnd':
        // Registry'de kayıtlı session'ın bitişini registry/ps doğrular; yalnızca hook'la açılanı kapat.
        if (s.seeded && !s.reg) {
          s.live = false;
          s.seeded = false;
          s.prov = null;
          s.endedAt = t.at;
          s.closedAt = t.at;
          this.assignHotkeys();
        }
        break;
      default:
        break;
    }

    if (t.to && t.to !== 'ended' && s.live && !(s.prov && t.at < s.prov.at)) {
      const current = s.status ?? this.computeStatus(s, this.clock.now());
      if (!(t.soft && current === 'waiting')) {
        s.prov = { status: t.to, at: t.at, waitingFor: t.to === 'waiting' ? (t.waitingFor ?? null) : null };
      }
    }
    this.updateStatuses();
    if (s.status !== before) this._urgent = true;
    this._dirty = true;
  }

  private seedFromHook(s: SessionState, t: HookTransition): void {
    const seed = t.seed;
    if (!seed) return;
    if (!s.live && !s.reg) {
      s.live = true;
      s.seeded = true;
      s.endedAt = null;
      s.closedAt = null;
      if (!s.startedAt) s.startedAt = t.at;
      if (seed.claudePid > 0) {
        s.pid = seed.claudePid;
        this.pidOwner.set(seed.claudePid, s.id);
      }
      this.assignHotkeys();
    }
    if (seed.cwd && !s.cwd) this.setCwd(s, seed.cwd);
    if (seed.tty && TTY_RE.test(seed.tty)) {
      s.hookTty = seed.tty;
      if (!s.terminal?.tty) s.terminal = { app: s.terminal?.app ?? 'unknown', tty: seed.tty, pid: s.pid ?? seed.claudePid };
    }
  }

  /** Hook ile açılmış canlı session'lar ve transcript yolları için (orkestratör). */
  isSeeded(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.seeded ?? false;
  }

  /** Aynı sohbet yeni bir sessionId ile sürüyor (compact, resume, aynı pid'de yeni id). */
  supersede(from: string, to: string): void {
    if (from === to) return;
    const old = this.ensure(from);
    old.supersededBy = to;
    if (!old.live) this.tracker.dropSession(from);
    this._dirty = true;
  }

  // ---------- transcript olayları ----------

  apply(ev: EngineEvent): void {
    try {
      this.applyInner(ev);
    } catch (e) {
      this.onError(`apply(${ev.type})`, e);
      this.pushLog({ ts: ev.ts || this.clock.now(), sessionId: ev.sessionId, agentId: ev.agentId, kind: 'sys', label: 'olay işlenemedi', state: 'err' });
    }
    this._dirty = true;
  }

  /** Subagent tracker'ın asenkron (meta dosyası) değişiklikleri. */
  applyTrackerChanges(changes: TrackerChange[]): void {
    for (const c of changes) this.onTrackerChange(c, this.clock.now(), true);
    if (changes.length) this._dirty = true;
  }

  private applyInner(ev: EngineEvent): void {
    if (ev.type === 'usage') {
      if (this.seenUsage.has(ev.msgId)) return;
      this.seenUsage.add(ev.msgId);
    }
    const s = this.ensure(ev.sessionId);
    const today = ev.ts === 0 || ev.ts >= this.day0;
    if (ev.ts > 0) {
      if (!s.firstTs || ev.ts < s.firstTs) s.firstTs = ev.ts;
      if (ev.ts > s.lastTs) s.lastTs = ev.ts;
      if (ev.agentId) this.fixSpawnLog(ev.sessionId, ev.agentId, ev.ts);
    }

    // tool-end için çağrıyı tracker pending'den çıkarmadan önce al.
    let endedCall: ToolCall | undefined;
    if (ev.type === 'tool-end') {
      const owner = this.tracker.get(ev.sessionId, ev.agentId ?? 'main');
      endedCall = owner?.pending.get(ev.toolUseId) ?? this.tracker.get(ev.sessionId, 'main')?.pending.get(ev.toolUseId);
    }

    const changes = this.tracker.apply(ev);

    switch (ev.type) {
      case 'session-meta':
        if (ev.title) s.title = ev.title;
        if (ev.lastPrompt) s.lastPrompt = ev.lastPrompt;
        if (ev.cwd && (!s.cwd || !s.live)) this.setCwd(s, ev.cwd);
        if (ev.branch) s.branch = ev.branch;
        if (ev.model) {
          s.model = ev.model;
          s.ctxMax = ctxMaxFor(ev.model);
        }
        if (ev.effort) s.effort = ev.effort;
        break;
      case 'prompt':
        if (today && ev.agentId === null) {
          s.prompts++;
          this.pushLog({ ts: ev.ts, sessionId: s.id, agentId: null, kind: 'prompt', label: ev.text, state: 'ok' });
          this.emit({ type: 'prompt', sessionId: s.id, label: ev.text, at: ev.ts });
        }
        break;
      case 'tool-start':
        if (today) {
          s.toolCount++;
          this.bucket(ev.ts).tools++;
          const call = this.tracker.get(s.id, ev.agentId ?? 'main')?.pending.get(ev.toolUseId);
          this.pushLog({
            id: ev.toolUseId,
            ts: ev.ts,
            sessionId: s.id,
            agentId: ev.agentId,
            kind: 'tool',
            category: ev.category,
            toolName: ev.name,
            label: ev.label,
            state: 'run',
          });
          if (call) this.emit({ type: 'tool-start', call: { ...call } });
          if (ev.file) this.touchFile(s, ev.agentId, ev.file, WRITE_TOOLS.has(ev.name), ev.ts);
        }
        break;
      case 'tool-end': {
        const entry = this.logById.get(ev.toolUseId);
        const started = endedCall?.startedAt ?? entry?.ts ?? ev.ts;
        const durationMs = ev.ts && started ? Math.max(0, ev.ts - started) : null;
        if (entry) {
          entry.state = ev.ok ? 'ok' : 'err';
          entry.durationMs = durationMs;
        }
        if (today && !ev.ok) s.errorCount++;
        if (endedCall && today) {
          const call: ToolCall = { ...endedCall, endedAt: ev.ts, ok: ev.ok };
          if (durationMs !== null) call.durationMs = durationMs;
          if (ev.meta) call.meta = ev.meta;
          this.emit({ type: 'tool-end', call });
        }
        break;
      }
      case 'turn-duration':
        s.turnMs = ev.durationMs;
        break;
      case 'assistant-text':
        if (today) this.pushLog({ ts: ev.ts, sessionId: s.id, agentId: ev.agentId, kind: 'say', label: ev.text.slice(0, SAY_MAX), state: 'ok' });
        break;
      case 'compact':
        if (today) this.pushLog({ ts: ev.ts, sessionId: s.id, agentId: ev.agentId, kind: 'sys', label: 'context sıkıştırıldı', state: 'ok' });
        break;
      case 'api-error':
        if (today) {
          s.errorCount++;
          this.pushLog({ ts: ev.ts, sessionId: s.id, agentId: ev.agentId, kind: 'sys', label: ev.message, state: 'err' });
        }
        break;
      case 'interrupted':
        if (today) this.pushLog({ ts: ev.ts, sessionId: s.id, agentId: ev.agentId, kind: 'sys', label: 'kullanıcı kesti', state: 'ok' });
        break;
      default:
        break;
    }

    for (const c of changes) this.onTrackerChange(c, ev.ts, today);
  }

  private onTrackerChange(c: TrackerChange, ts: number, today: boolean): void {
    const s = this.sessions.get(c.sessionId);
    if (!s) return;
    switch (c.kind) {
      case 'usage': {
        if (c.agentId === 'main') {
          s.ctxTokens = c.input + c.cacheRead + c.cacheWrite;
          const max = ctxMaxFor(c.model || s.model);
          if (max) s.ctxMax = max;
        }
        if (!today) break;
        const cost = costOf(c.model || s.model, usageOf(c));
        s.costUsd += cost;
        s.agentCost.set(c.agentId, (s.agentCost.get(c.agentId) ?? 0) + cost);
        this.costToday += cost;
        const b = this.bucket(ts || this.clock.now());
        b.cost += cost;
        b.tokens += c.input + c.output + c.cacheRead + c.cacheWrite;
        break;
      }
      case 'spawned': {
        const rt = this.tracker.get(c.sessionId, c.agentId);
        if (!rt) break;
        // Boot'ta ajan dosyası kayıtlarından önce görülür; o an 'şimdi' değil, ajanın ilk kaydı başlangıçtır.
        const at = rt.firstTs > 0 ? rt.firstTs : ts || this.clock.now();
        const logId = `spawn:${s.id}:${c.agentId}`;
        if (today) this.pushLog({ id: logId, ts: at, sessionId: s.id, agentId: c.agentId, kind: 'agent', label: `ajan başladı · ${rt.desc || rt.agentType || c.agentId.slice(0, 8)}`, state: 'run' });
        if (rt.firstTs <= 0) this.spawnLogPending.set(`${s.id}/${c.agentId}`, logId);
        this.emit({ type: 'agent-spawn', sessionId: s.id, agent: this.agentView(s, rt.id) ?? this.fallbackAgent(s.id, c.agentId), parentAgentId: c.parentAgentId });
        break;
      }
      case 'done': {
        const rt = this.tracker.get(c.sessionId, c.agentId);
        // Boşta kalma kuralıyla (tick) biten ajanın bitişi son kaydıdır, tick anı değil.
        const at = rt && rt.lastTs > 0 ? Math.min(ts || this.clock.now(), rt.lastTs) : ts || this.clock.now();
        if (today) this.pushLog({ ts: at, sessionId: s.id, agentId: c.agentId, kind: 'agent', label: `ajan bitti · ${rt?.desc || rt?.agentType || c.agentId.slice(0, 8)}`, state: c.ok ? 'ok' : 'err' });
        this.emit({ type: 'agent-done', sessionId: s.id, agentId: c.agentId });
        break;
      }
      default:
        break;
    }
  }

  // ---------- zaman ----------

  /** Her saniye: tracker kuralları ve durumlar. */
  tick(): void {
    const changes = this.tracker.tick((sid) => this.sessions.get(sid)?.status ?? null);
    if (changes.length) {
      for (const c of changes) this.onTrackerChange(c, this.clock.now(), true);
      this._dirty = true;
    }
    this.updateStatuses();
  }

  tickDay(): boolean {
    const d = this.clock.dayStart();
    if (d === this.day0) return false;
    this.day0 = d;
    for (const s of this.sessions.values()) {
      s.costUsd = 0;
      s.toolCount = 0;
      s.errorCount = 0;
      s.prompts = 0;
      s.agentCost.clear();
      s.writes.clear();
    }
    this.minutes.clear();
    this.seenUsage.clear();
    this.costToday = 0;
    this.tracker.rollDay();
    this._dirty = true;
    return true;
  }

  /** Bellek sınırı: 24 saatten eski, canlı olmayan session'lar; en fazla 500 dosya. */
  gc(): void {
    const now = this.clock.now();
    for (const s of [...this.sessions.values()]) {
      if (!s.live && now - (s.lastTs || s.endedAt || 0) > GC_AGE_MS) {
        this.sessions.delete(s.id);
        this.tracker.dropSession(s.id);
        this.hotkeys.delete(s.id);
      }
    }
    if (this.files.size > MAX_FILES) {
      const sorted = [...this.files.values()].sort((a, b) => a.lastTs - b.lastTs);
      for (const f of sorted.slice(0, this.files.size - MAX_FILES)) this.files.delete(f.path);
    }
    const minMinute = Math.floor(now / 60_000) - MINUTES_KEPT;
    for (const k of this.minutes.keys()) if (k < minMinute) this.minutes.delete(k);
    // Silinen session'lara ait yan kayıtlar (05/02: günlerce açık kalan uygulamada sınırsız büyümesin).
    for (const [pid, sid] of this.pidOwner) if (!this.sessions.has(sid)) this.pidOwner.delete(pid);
    for (const key of this.spawnLogPending.keys()) {
      const sid = key.slice(0, key.indexOf('/'));
      if (!this.sessions.has(sid)) this.spawnLogPending.delete(key);
    }
    this._dirty = true;
  }

  drainEvents(): BoardEvent[] {
    const out = this.queue;
    this.queue = [];
    return out;
  }

  // ---------- projeksiyon ----------

  snapshot(): BoardSnapshot {
    const now = this.clock.now();
    this.updateStatuses();
    this._dirty = false;

    const visible = [...this.sessions.values()].filter((s) => this.isVisible(s, now));
    const roots = new Map<string, ResolvedProject>();
    for (const s of this.sessions.values()) if (s.project) roots.set(s.project.id, s.project);
    const rootList = [...roots.values()].sort((a, b) => b.root.length - a.root.length);
    const fileProject = (f: FileHeat): string => {
      for (const p of rootList) if (f.path === p.root || f.path.startsWith(p.root + path.sep)) return p.id;
      return f.projectId;
    };

    const conflicts = this.conflicts(now, fileProject);
    const conflictPaths = new Set(conflicts.map((c) => c.path));

    const sessions: SessionView[] = visible.map((s) => this.sessionView(s, now, conflictPaths));
    sessions.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.lastTs - a.lastTs);

    const projectIds = new Set(sessions.map((s) => s.projectId));
    const visibleRoots = [...this.seenRoots];
    const projects: ProjectView[] = [];
    for (const id of projectIds) {
      const p = roots.get(id);
      if (!p) continue;
      const ident = this.projects.identity(p.root, visibleRoots);
      let cost = 0;
      for (const s of this.sessions.values()) if (s.project?.id === id) cost += s.costUsd;
      const hot = [...this.files.values()]
        .filter((f) => fileProject(f) === id)
        .sort((a, b) => b.writes * 3 + b.reads - (a.writes * 3 + a.reads) || b.lastTs - a.lastTs)
        .slice(0, HOT_FILES)
        .map((f) => ({ ...f, projectId: id, editors: f.editors.slice(-5) }));
      projects.push({
        id,
        root: p.root,
        name: ident.name,
        displayPath: p.displayPath,
        color: ident.color,
        emblem: ident.emblem,
        tag: this.projects.peekTag(p.root),
        sessionIds: sessions.filter((s) => s.projectId === id).map((s) => s.id),
        costUsd: round(cost),
        conflicts: conflicts.filter((c) => c.projectId === id),
        hotFiles: hot,
      });
    }
    projects.sort((a, b) => a.name.localeCompare(b.name));

    let runningAgents = 0;
    let slowTools = 0;
    for (const s of sessions) {
      for (const a of s.agents) if (!a.isMain && a.running) runningAgents++;
      if (s.status === 'busy') slowTools += this.slowCount(s.id, now);
    }

    const nowMin = Math.floor(now / 60_000);
    let tools5 = 0;
    for (let m = nowMin - 4; m <= nowMin; m++) tools5 += this.minutes.get(m)?.tools ?? 0;

    return {
      at: now,
      booted: this.booted,
      dayStart: this.day0,
      projects,
      sessions,
      log: this.log.slice().reverse().map((e) => ({ ...e })),
      limits: this.limits ? { ...this.limits } : null,
      totals: {
        projects: projects.length,
        liveSessions: sessions.filter((s) => s.live || (s.background !== null && s.status !== 'ended')).length, // 07/01: uyuyan arka plan session'ları da
        waiting: sessions.filter((s) => s.status === 'waiting').length,
        runningAgents,
        conflicts: conflicts.length,
        slowTools,
        toolsPerMin: Math.round((tools5 / 5) * 10) / 10,
        costTodayUsd: round(this.costToday),
      },
    };
  }

  // ---------- iç ----------

  private ensure(id: string): SessionState {
    let s = this.sessions.get(id);
    if (s) return s;
    s = {
      id,
      pid: null,
      live: false,
      reg: null,
      name: '',
      title: '',
      lastPrompt: '',
      cwd: '',
      project: null,
      branch: null,
      model: '',
      effort: null,
      startedAt: 0,
      firstTs: 0,
      lastTs: 0,
      endedAt: null,
      closedAt: null,
      supersededBy: null,
      status: null,
      statusSince: this.clock.now(),
      costUsd: 0,
      toolCount: 0,
      errorCount: 0,
      prompts: 0,
      ctxTokens: 0,
      ctxMax: null,
      turnMs: null,
      terminal: null,
      cpuPct: null,
      memMb: null,
      writes: new Set(),
      agentCost: new Map(),
      prov: null,
      seeded: false,
      hookTty: null,
      dormantBg: null,
    };
    this.sessions.set(id, s);
    this.tracker.ensureMain(id);
    return s;
  }

  private setCwd(s: SessionState, cwd: string): void {
    s.cwd = cwd;
    s.project = this.projects.peek(cwd);
    this.seenRoots.add(s.project.root);
    this.projects
      .resolve(cwd)
      .then(async (p) => {
        if (s.cwd !== cwd) return;
        s.project = p;
        this.seenRoots.add(p.root);
        this._dirty = true;
        await this.projects.tagOf(p.root);
        this._dirty = true;
      })
      .catch((e: unknown) => this.onError('project.resolve', e));
  }

  private isVisible(s: SessionState, now: number): boolean {
    if (s.supersededBy && !s.live) return false;
    if (s.project && this.projects.isHidden(s.project.root)) return false;
    if (!s.cwd && !s.live) return false; // yalnızca başlık/özet kaydı olan, hiç konuşmamış dosya
    const st = s.status ?? this.computeStatus(s, now);
    if (st === 'ended' && now - (s.lastTs || s.endedAt || 0) >= THRESHOLDS.endedVisibleMs) return false;
    return true;
  }

  /** 02/09 öncelik kuralı: registry hook'tan daha yeni ya da aynı fikirdeyse geçici durum silinir. */
  private resolveProv(s: SessionState, now: number): void {
    const p = s.prov;
    if (!p) return;
    const reg = s.live ? s.reg : null;
    let drop = false;
    if (!s.live) drop = true;
    else if (now - p.at > PROV_MAX_MS) drop = true;
    else if (reg) {
      const changedAt = reg.statusUpdatedAt ?? null;
      if (reg.status === p.status) drop = true; // aynı fikirde: registry yeterli
      else if (changedAt !== null) drop = changedAt >= p.at; // registry hook'tan sonra durum yazdı
      else drop = now - p.at > PROV_TTL_MS; // registry zaman yazmıyor: kısa ömür
    }
    if (drop) s.prov = null;
  }

  private computeStatus(s: SessionState, now: number): SessionStatus {
    if (s.live && s.prov) {
      const st = s.prov.status;
      if (st === 'idle' && this.tracker.hasActiveBackground(s.id, now)) return 'busy';
      return st;
    }
    if (s.live && s.reg) {
      const st = s.reg.status;
      if (st === 'idle' && this.tracker.hasActiveBackground(s.id, now)) return 'busy';
      return st;
    }
    if (s.live && s.seeded) return 'idle';
    // 07/01: işçisi kapalı arka plan session'ı: bağlanılabilir, boşta.
    if (s.dormantBg) return 'idle';
    if (s.closedAt) return 'ended';
    // Registry'de hiç görülmemiş session (registry yazmayan sürüm, headless): yakın aktivite → busy.
    if (s.lastTs && now - s.lastTs < RECENT_ACTIVITY_MS) return 'busy';
    return 'ended';
  }

  private updateStatuses(): void {
    const now = this.clock.now();
    for (const s of this.sessions.values()) {
      this.resolveProv(s, now);
      const st = this.computeStatus(s, now);
      if (st === s.status) continue;
      const from = s.status;
      s.status = st;
      const fromReg = s.live && s.reg && s.reg.status === st && s.reg.statusSince;
      const fromHook = s.live && s.prov && s.prov.status === st;
      s.statusSince = fromHook ? (s.prov?.at ?? now) : fromReg ? (s.reg?.statusSince ?? now) : now;
      if (st === 'idle' || st === 'ended') this.tracker.clearMainPending(s.id);
      this.emit({ type: 'status', sessionId: s.id, from, to: st, at: now });
      this._dirty = true;
    }
  }

  /** Canlı session numarasını yaşadığı sürece korur; yeni canlı session en küçük boş numarayı alır (04/03, hotkeys.ts). */
  private assignHotkeys(): void {
    const prevOf = new Map<string, string>();
    for (const s of this.sessions.values()) if (s.supersededBy) prevOf.set(s.supersededBy, s.id);
    this.hotkeys.assign(
      [...this.sessions.values()]
        .filter((s) => s.live)
        .map((s) => ({ id: s.id, startedAt: s.startedAt || s.firstTs, supersedes: prevOf.get(s.id) ?? null })),
    );
  }

  private emit(ev: BoardEvent): void {
    if (this.booted) this.queue.push(ev);
  }

  /** Ajanın ilk kaydı geldi: önceden 'şimdi' zamanıyla yazılmış 'başladı' satırını gerçek zamanına taşı. */
  private fixSpawnLog(sessionId: string, agentId: string, ts: number): void {
    const key = `${sessionId}/${agentId}`;
    const id = this.spawnLogPending.get(key);
    if (!id) return;
    this.spawnLogPending.delete(key);
    const entry = this.logById.get(id);
    if (!entry || ts >= entry.ts) return;
    const i = this.log.indexOf(entry);
    if (i >= 0) this.log.splice(i, 1);
    this.logById.delete(id);
    if (ts < this.day0) return; // ajan dün başlamış: bugünün log'una girmez
    this.pushLog({ ...entry, ts });
  }

  private pushLog(e: Omit<LogEntry, 'id' | 'category' | 'toolName' | 'durationMs'> & Partial<Pick<LogEntry, 'id' | 'category' | 'toolName' | 'durationMs'>>): void {
    const entry: LogEntry = {
      id: e.id ?? `l${++this.logSeq}`,
      ts: e.ts,
      sessionId: e.sessionId,
      agentId: e.agentId,
      kind: e.kind,
      category: e.category ?? null,
      toolName: e.toolName ?? null,
      label: e.label,
      state: e.state,
      durationMs: e.durationMs ?? null,
    };
    if (this.logById.has(entry.id)) return; // aynı araç çağrısı iki kez gelmesin
    // Halka doluysa ve kayıt en eskisinden de eskiyse eklense de hemen düşerdi: açılışta on binlerce
    // kaydın sıralı ekleme + shift maliyetini atla (05/02). Sonuç birebir aynı.
    const oldest = this.log[0];
    if (this.log.length >= THRESHOLDS.logRingSize && oldest && entry.ts < oldest.ts) return;
    // Zaman sırası: geç okunan eski kayıt araya girer (ring küçük, ekleme sıralı aramayla).
    let i = this.log.length;
    while (i > 0 && (this.log[i - 1]?.ts ?? 0) > entry.ts) i--;
    this.log.splice(i, 0, entry);
    this.logById.set(entry.id, entry);
    while (this.log.length > THRESHOLDS.logRingSize) {
      const old = this.log.shift();
      if (old) this.logById.delete(old.id);
    }
  }

  private bucket(ts: number): MinuteBucket {
    const k = Math.floor(ts / 60_000);
    let b = this.minutes.get(k);
    if (!b) {
      b = { tools: 0, tokens: 0, cost: 0 };
      this.minutes.set(k, b);
    }
    return b;
  }

  private touchFile(s: SessionState, agentId: string | null, file: string, write: boolean, ts: number): void {
    let f = this.files.get(file);
    if (!f) {
      f = { path: file, projectId: s.project?.id ?? '', reads: 0, writes: 0, lastTs: 0, editors: [] };
      this.files.set(file, f);
    }
    if (ts > f.lastTs) f.lastTs = ts;
    if (write) {
      const before = this.editorsWithin(f, ts);
      f.writes++;
      f.editors.push({ sessionId: s.id, agentId, ts });
      if (f.editors.length > MAX_EDITORS) f.editors.splice(0, f.editors.length - MAX_EDITORS);
      s.writes.add(file);
      const after = this.editorsWithin(f, ts);
      if (before.size < 2 && after.size >= 2) {
        this.emit({ type: 'conflict', conflict: { path: file, projectId: f.projectId, sessionIds: [...after], lastTs: ts } });
      }
    } else {
      f.reads++;
    }
    this.emit({ type: 'file-touch', projectId: f.projectId, path: file, sessionId: s.id, agentId, write, at: ts });
  }

  private editorsWithin(f: FileHeat, now: number): Set<string> {
    const set = new Set<string>();
    for (const e of f.editors) if (now - e.ts <= THRESHOLDS.conflictWindowMs) set.add(e.sessionId);
    return set;
  }

  private conflicts(now: number, projectOf: (f: FileHeat) => string): FileConflict[] {
    const out: FileConflict[] = [];
    for (const f of this.files.values()) {
      const ids = this.editorsWithin(f, now);
      if (ids.size < 2) continue;
      // Gizli ya da 24 saat temizliğiyle silinmiş session'lar sayılmasın.
      const live = [...ids].filter((id) => this.sessions.has(id));
      if (live.length < 2) continue;
      out.push({ path: f.path, projectId: projectOf(f), sessionIds: live, lastTs: f.lastTs });
    }
    return out.sort((a, b) => b.lastTs - a.lastTs);
  }

  private slowCount(sessionId: string, now: number): number {
    let n = 0;
    for (const rt of this.tracker.agents(sessionId)) {
      // Agent/Task çağrısı alt ajan çalıştığı sürece açık kalır; bu "yavaş araç" değildir.
      for (const c of rt.pending.values()) if (c.category !== 'agent' && now - c.startedAt > THRESHOLDS.slowToolMs) n++;
    }
    return n;
  }

  private waitingInfo(s: SessionState): WaitingInfo | null {
    if (s.status !== 'waiting') return null;
    const hook = s.prov?.status === 'waiting' ? s.prov.waitingFor : null;
    const raw = hook ? null : (s.reg?.waitingForRaw ?? null);
    const main = this.tracker.get(s.id, 'main');
    let tool = hook?.tool ?? '';
    if (raw) {
      const m = /^[a-z_-]+:(.+)$/i.exec(raw);
      tool = (m?.[1] ?? raw).trim();
    }
    const pending = main ? [...main.pending.values()].sort((a, b) => b.startedAt - a.startedAt) : [];
    const call = (tool ? pending.find((c) => c.name === tool) : undefined) ?? pending[0] ?? main?.current ?? null;
    if (!tool && call) tool = call.name;
    return { tool: tool || '?', label: call?.label || hook?.label || '', since: s.statusSince };
  }

  private agentView(s: SessionState, agentId: string): AgentView | null {
    const rt = this.tracker.get(s.id, agentId);
    if (!rt) return null;
    return this.tracker.toView(rt, {
      sessionModel: s.model,
      sessionStatus: s.status ?? 'idle',
      costUsd: round(s.agentCost.get(agentId) ?? 0),
    });
  }

  private fallbackAgent(sessionId: string, agentId: string): AgentView {
    return {
      id: agentId,
      sessionId,
      isMain: agentId === 'main',
      name: agentId.slice(0, 8),
      agentType: '',
      team: null,
      model: '',
      background: false,
      running: true,
      done: false,
      current: null,
      toolCount: 0,
      errorCount: 0,
      costUsd: 0,
      firstTs: 0,
      lastTs: 0,
      doneAt: null,
      loopSuspect: false,
    };
  }

  private sessionView(s: SessionState, now: number, conflictPaths: Set<string>): SessionView {
    const status = s.status ?? this.computeStatus(s, now);
    const ctx = { sessionModel: s.model, sessionStatus: status, costUsd: 0 };
    const agents: AgentView[] = [];
    for (const rt of this.tracker.agents(s.id, status)) {
      const running = this.tracker.isRunning(rt, status);
      if (!rt.isMain && !running && now - rt.lastTs > THRESHOLDS.subagentVisibleMs && !(rt.doneAt && now - rt.doneAt <= THRESHOLDS.subagentVisibleMs)) continue;
      agents.push(this.tracker.toView(rt, { ...ctx, costUsd: round(s.agentCost.get(rt.id) ?? 0) }));
    }

    const flags: SessionFlag[] = [];
    if (status === 'busy' && this.slowCount(s.id, now) > 0) flags.push('slow-tool');
    const ctxRatio = s.ctxMax ? Math.min(1, s.ctxTokens / s.ctxMax) : 0;
    if (ctxRatio >= THRESHOLDS.ctxWarnRatio) flags.push('ctx-80');
    if (this.tracker.agents(s.id).some((rt) => !rt.done && this.tracker.isLoop(rt))) flags.push('loop-suspect');
    for (const p of s.writes) {
      if (conflictPaths.has(p)) {
        flags.push('conflict');
        break;
      }
    }

    return {
      id: s.id,
      pid: s.pid,
      live: s.live,
      name: displayName(s),
      title: s.title,
      lastPrompt: s.lastPrompt,
      cwd: s.cwd,
      projectId: s.project?.id ?? '',
      branch: s.branch,
      worktree: s.project?.worktree ?? null,
      model: shortModel(s.model),
      effort: s.effort,
      status,
      statusSince: s.statusSince,
      waitingFor: this.waitingInfo(s),
      ctxTokens: s.ctxTokens,
      ctxMax: s.ctxMax ?? 0,
      ctxRatio,
      costUsd: round(s.costUsd),
      toolCount: s.toolCount,
      errorCount: s.errorCount,
      flags,
      agents,
      terminal: s.terminal,
      background:
        s.live && s.reg?.jobId
          ? { id: s.reg.jobId, state: this.bgStates.get(s.reg.jobId.toLowerCase()) ?? null }
          : s.dormantBg
            ? { id: s.dormantBg.id, state: s.dormantBg.state }
            : null,
      hotkey: s.live ? this.hotkeys.get(s.id) : null,
      startedAt: s.reg?.startedAt || s.startedAt || s.firstTs,
      lastTs: s.lastTs,
      cpuPct: s.cpuPct,
      memMb: s.memMb,
    };
  }
}

/** Mikro-dolar gürültüsü snapshot JSON'unu her saniye değiştirmesin. */
const round = (v: number): number => Math.round(v * 1e6) / 1e6;

/**
 * Görünen ad: kullanıcının verdiği ad (/rename) > Claude'un başlığı (ai-title) >
 * Claude Code'un otomatik adı (nameSource 'derived', ör. claude-18) > klasör adı > kimlik.
 */
function displayName(s: SessionState): string {
  const auto = s.reg?.nameSource === 'derived';
  if (s.name && !auto) return s.name;
  return s.title || s.name || (s.cwd ? path.basename(s.cwd) : '') || s.id.slice(0, 8);
}
