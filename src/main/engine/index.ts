// Motor orkestratörü
// Alt bileşenleri kurar (registry, transcript havuzu, normalizer, subagent tracker, proje çözümleyici, süreç denetçisi),
// olayları BoardStore'a akıtır ve iki çıktı üretir: 1 sn throttle'lı BoardSnapshot, 120 ms batch'li BoardEvent[].
// Saf Node: electron importu yok. Main tarafı köprüsü src/main/engine-host.ts.
import path from 'node:path';
import { THRESHOLDS } from '@shared/constants';
import { DEFAULT_SETTINGS } from '@shared/settings';
import type { AppSettings, BackgroundHistoryItem, BoardEvent, BoardSnapshot, UsageLimits } from '@shared/types';
import type { AgentMeta } from './agent-runtime';
import { systemClock, type Clock } from './clock';
import { createNormalizerState, type NormalizerState } from './events';
import type { GitRoots } from './git';
import { HookIngest, type HookFs, type HookTransition } from './hookIngest';
import { normalizeRecord } from './normalize';
import { claudePaths, transcriptPathFor, type ClaudePaths } from './paths';
import type { AgentsPollerLike } from './agents';
import { NoopProcessInspector, type ProcessInspectorLike } from './process';
import { ProjectResolver } from './projects';
import { RegistryWatcher, type RegistryDiff } from './registry';
import { LimitsReader } from './limits';
import { BoardStore } from './store';
import { SubagentTracker } from './subagents';
import { TranscriptPool, type RecordsBatch } from './transcript/pool';

export type Tempo = 'normal' | 'background';

export interface SessionEngineOptions {
  /** Ayardaki claudeConfigDir; null → $DIJI_CLAUDE_DIR → $CLAUDE_CONFIG_DIR → ~/.claude */
  configDir?: string | null;
  clock?: Clock;
  /** 02/09: Faz 1 hook olay dosyası. Verilmezse appDataDir/hook-events.jsonl; ikisi de yoksa hızlı durum kapalı. */
  hookEventsPath?: string | null;
  /** 02/09 testleri: dosya sistemi yüzeyi. */
  hookFs?: HookFs;
  appDataDir?: string; // main: app.getPath('userData')
  /** 02/08: statusLine'ın yazdığı limits.json. Verilmezse appDataDir/limits.json; ikisi de yoksa limitler kapalı. */
  limitsPath?: string | null;
  isAlive?: (pid: number) => boolean;
  processStartMs?: (pid: number) => Promise<number | null>;
  procStartToken?: (pid: number) => Promise<string | null>;
  settings?: () => AppSettings;
  git?: (cwd: string) => Promise<GitRoots | null>;
  home?: string;
  countAgents?: (root: string) => Promise<number>;
  readMeta?: (path: string) => Promise<AgentMeta | null>;
  agentFileExists?: (projectRoot: string, agentType: string) => Promise<boolean>;
  inspector?: ProcessInspectorLike;
  /** 07/01: `claude agents --json` okuyucu (arka plan session'larının state'i). Verilmezse state hep null. */
  agents?: AgentsPollerLike;
  /** 07/01: kullanıcının kapattığı arka plan kimlikleri (açılışta) ve değişince kaydetme. */
  dismissedBackground?: string[];
  onDismissedChange?: (ids: string[]) => void;
  /** true: zamanlayıcı ve dosya izleyici kurulmaz; ilerletme pumpNow() ile (testler). */
  manual?: boolean;
}

/** Main process ve DemoEngine'in paylaştığı yüzey (05/01). */
export interface BoardEngine {
  start(): Promise<void>;
  stop(): Promise<void> | void;
  resume(): void;
  restart(opts: { configDir: string | null }): Promise<void>;
  setTempo(t: Tempo): void;
  getSnapshot(): BoardSnapshot;
  onSnapshot(cb: (s: BoardSnapshot) => void): () => void;
  onEvents(cb: (e: BoardEvent[]) => void): () => void;
  /** Ayarlar değişti (proje rengi/amblemi/gizleme, 00/04): bir sonraki snapshot hemen. */
  settingsChanged?(): void;
  /** 07/01: canlı arka plan session'ının attach kimliği ve klasörü (DemoEngine'de yok). */
  backgroundTarget?(sessionId: string): { bgId: string; cwd: string; running: boolean } | null;
  /** 07/01: "Session'ı kapat" — uyuyan arka plan session'ı haritadan kalkar (kalıcı). */
  dismissBackground?(bgId: string): void;
  /** 07/01: geçmiş tablosu — haritada olmayan arka plan session'ları. */
  backgroundHistory?(): BackgroundHistoryItem[];
  /** 07/01: geçmişten yeniden aktif et; dönüş: session kimliği (listede yoksa null). */
  restoreBackground?(bgId: string): string | null;
  /** 07/01: arka plan listesini hemen yenile (yeni session başlatıldı, attach başarısız oldu…). */
  refreshBackground?(): Promise<void>;
}

/** Ayar > DIJI_CLAUDE_DIR > CLAUDE_CONFIG_DIR > ~/.claude */
export function resolveClaudePaths(configDir: string | null | undefined, home?: string): ClaudePaths {
  const dir = configDir || process.env['DIJI_CLAUDE_DIR'] || null;
  return claudePaths({ configDir: dir, ...(home ? { home } : {}) });
}

const SNAPSHOT_REFRESH_MS = 5000;
const BG_SNAPSHOT_MS = 5000;
const DAY_CHECK_MS = 60_000;
const GC_MS = 10 * 60_000;
const META_RETRY_MS = 3000;
/** Hook kaynaklı durum değişikliğinde iki snapshot arası en az (02/09). */
const URGENT_MIN_GAP_MS = 250;

export class SessionEngine implements BoardEngine {
  private opts: SessionEngineOptions;
  private readonly clock: Clock;
  private paths!: ClaudePaths;
  private registry!: RegistryWatcher;
  private pool!: TranscriptPool;
  private projects!: ProjectResolver;
  private tracker!: SubagentTracker;
  private store!: BoardStore;
  private inspector!: ProcessInspectorLike;
  private ingest: HookIngest | null = null;
  private limits: LimitsReader | null = null;
  private urgentTimer: NodeJS.Timeout | null = null;
  private normState: NormalizerState = createNormalizerState();

  private snapshotCbs = new Set<(s: BoardSnapshot) => void>();
  private eventCbs = new Set<(e: BoardEvent[]) => void>();
  private timers: NodeJS.Timeout[] = [];
  private unsubs: (() => void)[] = [];
  private processing: Promise<void> = Promise.resolve();
  private side = new Set<Promise<unknown>>();
  private last: BoardSnapshot | null = null;
  private lastKey = '';
  private lastPublish = 0;
  private tempo: Tempo = 'normal';
  private running = false;

  constructor(opts: SessionEngineOptions = {}) {
    this.opts = { ...opts };
    this.clock = opts.clock ?? systemClock;
    this.build();
  }

  /** Test ve tanılama: alt bileşenler. */
  get internals(): { store: BoardStore; pool: TranscriptPool; registry: RegistryWatcher; tracker: SubagentTracker; paths: ClaudePaths; normalizer: NormalizerState } {
    return { store: this.store, pool: this.pool, registry: this.registry, tracker: this.tracker, paths: this.paths, normalizer: this.normState };
  }

  private build(): void {
    const o = this.opts;
    const now = () => this.clock.now();
    this.paths = resolveClaudePaths(o.configDir, o.home);
    this.normState = createNormalizerState();
    this.registry = new RegistryWatcher(this.paths, {
      now,
      ...(o.isAlive ? { isAlive: o.isAlive } : {}),
      ...(o.processStartMs ? { processStartMs: o.processStartMs } : {}),
      ...(o.procStartToken ? { procStartToken: o.procStartToken } : {}),
    });
    this.pool = new TranscriptPool(this.paths, { now });
    this.projects = new ProjectResolver({
      settings: o.settings ?? (() => DEFAULT_SETTINGS),
      now,
      ...(o.git ? { git: o.git } : {}),
      ...(o.home ? { home: o.home } : {}),
      ...(o.countAgents ? { countAgents: o.countAgents } : {}),
    });
    let storeRef: BoardStore | null = null;
    this.tracker = new SubagentTracker({
      projectRootOf: (sid) => storeRef?.rootOf(sid) ?? null,
      now,
      onAsyncChange: () => storeRef?.markDirty(),
      ...(o.readMeta ? { readMeta: o.readMeta } : {}),
      ...(o.agentFileExists ? { agentFileExists: o.agentFileExists } : {}),
    });
    this.store = new BoardStore({ clock: this.clock, projects: this.projects, subagents: this.tracker });
    storeRef = this.store;
    this.inspector = o.inspector ?? new NoopProcessInspector();
    const hookFile = o.hookEventsPath !== undefined ? o.hookEventsPath : o.appDataDir ? path.join(o.appDataDir, 'hook-events.jsonl') : null;
    const limitsFile = o.limitsPath !== undefined ? o.limitsPath : o.appDataDir ? path.join(o.appDataDir, 'limits.json') : null;
    this.limits = limitsFile ? new LimitsReader({ filePath: limitsFile, ...(o.manual ? { pollMs: 0, watch: false } : {}) }) : null;
    this.ingest = hookFile
      ? new HookIngest({ filePath: hookFile, now, ...(o.hookFs ? { fs: o.hookFs } : {}), ...(o.manual ? { pollMs: 0, watch: false } : {}) })
      : null;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const store = this.store;
    store.setBooted(false);

    this.pool.on('records', (b: RecordsBatch) => this.enqueue(b));
    this.pool.on('supersede', (s: { from: string; to: string }) => store.supersede(s.from, s.to));
    this.pool.on('file-added', (p: string) => this.onFileAdded(p));
    this.registry.on('change', (d: RegistryDiff) => this.onRegistry(d));

    try {
      if (this.opts.manual) await this.registry.refresh();
      else await this.registry.start();
    } catch (e) {
      console.error('[engine] registry başlatılamadı:', e);
    }
    if (this.opts.dismissedBackground?.length) store.setDismissedBackground(this.opts.dismissedBackground);
    store.applyRegistry(this.registry.list());

    const extra: string[] = [];
    for (const e of this.registry.list()) if (e.cwd) extra.push(transcriptPathFor(e.cwd, e.sessionId, this.paths));
    try {
      await this.pool.boot(store.dayStart(), extra);
      // Canlı session dosyaları yedek timer'la da okunsun (watcher olay kaçırırsa).
      for (const f of extra) await this.pool.ensure(f);
    } catch (e) {
      console.error('[engine] transcript taraması başarısız:', e);
    }
    await this.settle();

    this.inspector.start();
    this.unsubs.push(this.inspector.onSample(() => this.applyProcesses()));
    const agents = this.opts.agents;
    if (agents) {
      this.unsubs.push(
        agents.onUpdate((list) => {
          // Uyuyan arka plan session'ları (işçi kapalı): transcript'leri de okunsun (ad, proje, son istek).
          for (const d of this.store.applyBackgroundList(list)) this.track(this.pool.ensure(transcriptPathFor(d.cwd, d.sessionId, this.paths)));
          agents.setActive(this.store.hasBackground());
          this.persistDismissed();
          if (this.running && this.store.isBooted()) this.publishSnapshot(true);
        }),
      );
      agents.setActive(store.hasBackground());
      if (!this.opts.manual) agents.start();
      // Açılışta bir kez: işçisi kapalı (uyuyan) arka plan session'ları registry'de görünmez.
      this.track(agents.pollNow());
    }
    store.tick();
    store.setBooted(true);
    await this.startIngest();
    await this.startLimits();
    this.publishSnapshot(true);

    if (!this.opts.manual) {
      this.pool.watch();
      this.every(THRESHOLDS.eventBatchMs, () => this.flushEvents());
      this.every(THRESHOLDS.snapshotThrottleMs, () => {
        this.store.tick();
        this.publishSnapshot(false);
      });
      this.every(DAY_CHECK_MS, () => this.checkDay());
      this.every(GC_MS, () => this.store.gc());
      this.every(META_RETRY_MS, () => {
        void this.tracker.refreshPending().then((c) => c && this.store.markDirty());
      });
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.urgentTimer) clearTimeout(this.urgentTimer);
    this.urgentTimer = null;
    this.ingest?.stop();
    this.ingest?.removeAllListeners();
    this.limits?.stop();
    this.limits?.removeAllListeners();
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.inspector.stop();
    this.opts.agents?.stop();
    this.pool.removeAllListeners();
    this.registry.removeAllListeners();
    await Promise.allSettled([this.registry.stop(), this.pool.stop()]);
    await this.settle().catch(() => undefined);
  }

  /** Uykudan uyanınca: registry ve süreç hemen yeniden örneklenir. */
  resume(): void {
    this.track(this.registry.refresh());
    this.track(this.inspector.sampleNow().then(() => this.applyProcesses()));
  }

  /** claudeConfigDir değişti (00/04): her şeyi yeni kökle yeniden kur. Dinleyiciler korunur. */
  async restart(opts: { configDir: string | null }): Promise<void> {
    await this.stop();
    this.opts = { ...this.opts, configDir: opts.configDir };
    this.last = null;
    this.lastKey = '';
    this.build();
    await this.start();
  }

  setTempo(t: Tempo): void {
    if (this.tempo === t) return;
    this.tempo = t;
    // Gizliyken (05/02): ps örneklemesi ve transcript güvenlik poll'u seyrekleşir. Durum geçişleri
    // (registry izleyicisi, hook olayları, saniyelik tick) ve bildirimler için gereken olaylar aynen sürer.
    const slow = t === 'background';
    this.inspector.setSlow?.(slow);
    this.pool.setSlow(slow);
    this.opts.agents?.setSlow(slow);
    // Görünür olunca beklemeden taze snapshot: gizliyken pencereye snapshot gönderilmiyor (engine-host).
    if (!slow && this.running && this.store.isBooted()) this.publishSnapshot(true);
  }

  settingsChanged(): void {
    this.store.markDirty();
    if (this.running && this.store.isBooted()) this.publishSnapshot(true);
  }

  backgroundTarget(sessionId: string): { bgId: string; cwd: string; running: boolean } | null {
    return this.store.backgroundTarget(sessionId);
  }

  backgroundHistory(): BackgroundHistoryItem[] {
    return this.store.backgroundHistory();
  }

  restoreBackground(bgId: string): string | null {
    const r = this.store.restoreBackground(bgId);
    if (!r) return null;
    for (const d of r.added) this.track(this.pool.ensure(transcriptPathFor(d.cwd, d.sessionId, this.paths)));
    this.opts.agents?.setActive(this.store.hasBackground());
    this.persistDismissed();
    if (this.running && this.store.isBooted()) this.publishSnapshot(true);
    return r.sessionId;
  }

  dismissBackground(bgId: string): void {
    this.store.dismissBackground(bgId);
    this.persistDismissed();
    if (this.running && this.store.isBooted()) this.publishSnapshot(true);
  }

  /** Kapatılan kimlikler değiştiyse kalıcı yere yazılır (main: userData/dismissed-background.json). */
  private persistDismissed(): void {
    if (!this.store.takeDismissedChanged()) return;
    const ids = this.store.dismissedBackground();
    this.opts.dismissedBackground = ids; // restart (claudeConfigDir değişimi) yeni store'a taşısın
    try {
      this.opts.onDismissedChange?.(ids);
    } catch (e) {
      console.error('[engine] kapatılan arka plan listesi yazılamadı:', e);
    }
  }

  async refreshBackground(): Promise<void> {
    await this.registry.refresh();
    await this.opts.agents?.pollNow();
  }

  getSnapshot(): BoardSnapshot {
    return this.last ?? this.decorate(this.store.snapshot());
  }

  onSnapshot(cb: (s: BoardSnapshot) => void): () => void {
    this.snapshotCbs.add(cb);
    return () => this.snapshotCbs.delete(cb);
  }

  onEvents(cb: (e: BoardEvent[]) => void): () => void {
    this.eventCbs.add(cb);
    return () => this.eventCbs.delete(cb);
  }

  /**
   * Elle ilerletme (manual mod ve testler): registry'yi tarar, tüm transcript'lerin yeni byte'larını okur,
   * kuyruğu boşaltır, store kurallarını uygular. Snapshot ve olayları da yayınlar.
   */
  async pumpNow(): Promise<BoardSnapshot> {
    await this.registry.refresh();
    await this.settle();
    await this.pool.pumpAll();
    await this.settle();
    await this.ingest?.readNow();
    if (this.limits) {
      await this.limits.readNow();
      this.store.setLimits(this.limits.current());
    }
    if (await this.tracker.refreshPending()) this.store.markDirty();
    this.checkDay();
    this.store.tick();
    this.flushEvents();
    this.publishSnapshot(true);
    return this.last ?? this.store.snapshot();
  }

  // ---------- iç ----------

  // ---------- 02/08 limitler ----------

  private async startLimits(): Promise<void> {
    const lr = this.limits;
    if (!lr) return;
    lr.on('change', (l: UsageLimits | null) => {
      this.store.setLimits(l);
      if (this.running && this.store.isBooted()) this.publishSnapshot(true);
    });
    try {
      if (this.opts.manual) await lr.readNow();
      else await lr.start();
    } catch (e) {
      console.error('[engine] limits.json okunamadı:', e);
    }
    this.store.setLimits(lr.current());
  }

  // ---------- 02/09 hook olayları ----------

  private async startIngest(): Promise<void> {
    const ing = this.ingest;
    if (!ing) return;
    ing.on('transition', (t: HookTransition) => this.onHook(t));
    ing.on('drain', () => this.onHookDrain());
    ing.on('status', () => this.store.markDirty());
    try {
      if (this.opts.manual) await ing.readNow();
      else await ing.start();
    } catch (e) {
      console.error('[engine] hook olayları okunamadı:', e);
    }
  }

  private onHook(t: HookTransition): void {
    const known = this.store.debugSession(t.sessionId) !== null;
    this.store.applyHook(t);
    // Registry'den önce gelen session: transcript'ini de izlemeye başla.
    if (!known && t.seed?.cwd && this.store.isSeeded(t.sessionId)) {
      this.track(this.pool.ensure(transcriptPathFor(t.seed.cwd, t.sessionId, this.paths)));
      this.applyProcesses();
    }
  }

  /** Hook kaynaklı durum değişikliği: olayları hemen, snapshot'ı en az 250 ms arayla yayınla. */
  private onHookDrain(): void {
    if (!this.store.takeUrgent() || !this.store.isBooted()) return;
    this.flushEvents();
    if (this.opts.manual) {
      this.publishSnapshot(true);
      return;
    }
    if (this.urgentTimer) return;
    const wait = Math.max(0, this.lastPublish + URGENT_MIN_GAP_MS - this.clock.now());
    if (wait === 0) {
      this.publishSnapshot(true);
      return;
    }
    this.urgentTimer = setTimeout(() => {
      this.urgentTimer = null;
      this.flushEvents();
      this.publishSnapshot(true);
    }, wait);
    this.urgentTimer.unref?.();
  }

  private decorate(s: BoardSnapshot): BoardSnapshot {
    s.fastStatus = this.ingest ? this.ingest.status() : 'off';
    return s;
  }

  private every(ms: number, fn: () => void): void {
    const t = setInterval(() => {
      try {
        fn();
      } catch (e) {
        console.error('[engine] zamanlayıcı hatası:', e);
      }
    }, ms);
    t.unref?.();
    this.timers.push(t);
  }

  private track<T>(p: Promise<T>): void {
    const q = p.catch((e: unknown) => console.error('[engine]', e));
    this.side.add(q);
    void q.finally(() => this.side.delete(q));
  }

  /** Kuyruk ve yan işler (ensure, meta okuma) bitene kadar bekler. */
  private async settle(): Promise<void> {
    for (let i = 0; i < 5; i++) {
      await this.processing;
      if (this.side.size === 0) break;
      await Promise.allSettled([...this.side]);
    }
    await this.processing;
  }

  private enqueue(b: RecordsBatch): void {
    this.processing = this.processing.then(() => this.handleBatch(b)).catch((e: unknown) => console.error('[engine] kayıt işlenemedi:', e));
  }

  private async handleBatch(b: RecordsBatch): Promise<void> {
    if (b.agentId && !this.tracker.get(b.sessionId, b.agentId)) {
      // Subagent dosyası ilk kez görülüyor (boot'ta 'file-added' yayınlanmaz): önce meta'yı oku.
      this.store.ensureSession(b.sessionId);
      this.store.applyTrackerChanges(await this.tracker.onFileAdded(b.path, b.sessionId, b.agentId));
    }
    for (const rec of b.records) {
      let evs;
      try {
        evs = normalizeRecord(rec, { sessionId: b.sessionId, agentId: b.agentId, state: this.normState });
      } catch (e) {
        console.error('[engine] normalize hatası:', e);
        continue;
      }
      for (const ev of evs) this.store.apply(ev);
    }
  }

  private onFileAdded(p: string): void {
    const c = this.pathIdentity(p);
    if (!c || !c.agentId) return;
    const { sessionId, agentId } = c;
    this.processing = this.processing
      .then(async () => {
        this.store.ensureSession(sessionId);
        this.store.applyTrackerChanges(await this.tracker.onFileAdded(p, sessionId, agentId));
      })
      .catch((e: unknown) => console.error('[engine] subagent dosyası:', e));
  }

  private pathIdentity(p: string): { sessionId: string; agentId: string | null } | null {
    const rel = p.startsWith(this.paths.projects) ? p.slice(this.paths.projects.length).split(/[/\\]/).filter(Boolean) : [];
    if (rel.length < 3 || !rel[1]) return null;
    const base = (rel[rel.length - 1] ?? '').replace(/\.jsonl$/, '');
    return { sessionId: rel[1], agentId: base.startsWith('agent-') ? base.slice(6) : base };
  }

  private onRegistry(d: RegistryDiff): void {
    for (const s of d.superseded) this.store.supersede(s.from, s.to);
    this.store.applyRegistry(this.registry.list());
    this.persistDismissed();
    const agents = this.opts.agents;
    if (agents) {
      agents.setActive(this.store.hasBackground());
      // Arka plan session'ı eklendi/çıktı: state'i hemen oku (bitti/başarısız bilgisi registry'de yok).
      const bgChanged = [...d.added, ...d.updated].some((e) => e.jobId) || d.removed.length > 0;
      if (bgChanged) this.track(agents.pollNow());
    }
    for (const e of [...d.added, ...d.updated]) {
      if (e.cwd) this.track(this.pool.ensure(transcriptPathFor(e.cwd, e.sessionId, this.paths)));
    }
    this.applyProcesses();
  }

  private applyProcesses(): void {
    for (const s of this.store.liveSessions()) {
      if (s.pid !== null) this.store.applyProcess(s.sessionId, this.inspector.describe(s.pid));
    }
  }

  private checkDay(): void {
    if (this.store.tickDay()) {
      this.pool.rollDay(this.store.dayStart());
      this.normState.seenMsgIds.clear();
    }
  }

  private flushEvents(): void {
    if (!this.store.isBooted()) return;
    const evs = this.store.drainEvents();
    if (evs.length === 0) return;
    for (const cb of this.eventCbs) {
      try {
        cb(evs);
      } catch (e) {
        console.error('[engine] onEvents dinleyicisi:', e);
      }
    }
  }

  /** dirty ya da 5 sn geçtiyse üretir; `at` dışında değişiklik yoksa ve tazeleme zamanı gelmediyse yayınlamaz. */
  private publishSnapshot(force: boolean): void {
    const now = this.clock.now();
    const refresh = now - this.lastPublish >= (this.tempo === 'background' ? BG_SNAPSHOT_MS : SNAPSHOT_REFRESH_MS);
    if (!force && !this.store.dirty && !refresh) return;
    if (!force && this.tempo === 'background' && !refresh) return;
    const snap = this.decorate(this.store.snapshot());
    const key = JSON.stringify({ ...snap, at: 0 });
    this.last = snap;
    if (!force && key === this.lastKey && !refresh) return;
    this.lastKey = key;
    this.lastPublish = now;
    for (const cb of this.snapshotCbs) {
      try {
        cb(snap);
      } catch (e) {
        console.error('[engine] onSnapshot dinleyicisi:', e);
      }
    }
  }
}
