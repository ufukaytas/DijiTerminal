// Demo motoru (DIJI_DEMO=1)
// Dosya sistemi okumadan, Session Board 3D prototipindeki simülasyona benzer sentetik bir pano üretir:
// 4 proje, 5 session, takım ajanları, araç çağrıları, onay beklemeleri, ara sıra çakışma.
// Gerçek BoardStore kullanılır; böylece demo ile canlı motorun çıktısı aynı kurallardan geçer.
import { THRESHOLDS } from '@shared/constants';
import { DEFAULT_SETTINGS } from '@shared/settings';
import type { AppSettings, BoardEvent, BoardSnapshot, ToolCategory } from '@shared/types';
import type { AgentMeta } from './agent-runtime';
import { systemClock, type Clock } from './clock';
import type { EngineEvent } from './events';
import type { BoardEngine, Tempo } from './index';
import { ProjectResolver } from './projects';
import type { RegistryEntry } from './registry';
import { BoardStore } from './store';
import { SubagentTracker } from './subagents';

const HOME = '/Users/demo';
const P = (name: string): string => `${HOME}/Projects/${name}`;

interface DemoProject {
  name: string;
  color: string;
  emblem: AppSettings['projects'][string]['emblem'];
  team?: string[]; // agentType'lar
}

const PROJECTS: DemoProject[] = [
  { name: 'platform', color: '#F0A6CA', emblem: 'team', team: ['test-runner', 'code-reviewer', 'docs-writer', 'perf-profiler'] },
  { name: 'billing-api', color: '#7DD3C0', emblem: 'ring' },
  { name: 'storefront', color: '#A5B4FC', emblem: 'stack' },
  { name: 'voice-agent', color: '#C4E17F', emblem: 'wave' },
];

interface SessionSeed {
  project: string;
  cwd: string;
  name: string;
  title: string;
  model: string;
}

const SESSIONS: SessionSeed[] = [
  { project: 'platform', cwd: P('platform'), name: 'core', title: 'Monorepo bağımlılık yükseltmesi', model: 'claude-opus-5-5' },
  { project: 'billing-api', cwd: P('billing-api'), name: 'invoices', title: 'Fatura API refaktörü', model: 'claude-opus-5-5' },
  { project: 'storefront', cwd: P('storefront'), name: 'storefront', title: 'Ürün sayfası önbelleği', model: 'claude-sonnet-5-5' },
  { project: 'storefront', cwd: `${P('storefront')}/.claude/worktrees/ui`, name: 'ui', title: 'Kart bileşenleri', model: 'claude-sonnet-5-5' },
  { project: 'voice-agent', cwd: P('voice-agent'), name: 'voice', title: 'VAD eşik ayarı', model: 'claude-opus-5-5' },
];

const AGENT_DESC: Record<string, string[]> = {
  'test-runner': ['birim testleri', 'entegrasyon testleri'],
  'code-reviewer': ['PR incelemesi', 'güvenlik taraması'],
  'docs-writer': ['API dokümantasyonu'],
  'perf-profiler': ['bundle boyutu analizi'],
  Explore: ['kod tabanı keşfi', 'test kapsamı incelemesi'],
};

interface ToolTpl {
  name: string;
  category: ToolCategory;
  label: (file: string) => string;
  file?: boolean;
  write?: boolean;
  ms: [number, number];
}

const TOOLS: ToolTpl[] = [
  { name: 'Read', category: 'read', label: (f) => f, file: true, ms: [300, 1500] },
  { name: 'Read', category: 'read', label: (f) => f, file: true, ms: [300, 1500] },
  { name: 'Grep', category: 'search', label: () => '"useCache" src/', ms: [400, 2000] },
  { name: 'Glob', category: 'search', label: () => '**/*.test.ts', ms: [200, 800] },
  { name: 'Edit', category: 'edit', label: (f) => f, file: true, write: true, ms: [500, 2500] },
  { name: 'Write', category: 'edit', label: (f) => f, file: true, write: true, ms: [500, 2000] },
  { name: 'Bash', category: 'bash', label: () => 'npm test -- --run', ms: [3000, 12000] },
  { name: 'Bash', category: 'bash', label: () => 'git status', ms: [300, 900] },
  { name: 'WebSearch', category: 'web', label: () => '"vector cache invalidation"', ms: [2000, 6000] },
  { name: 'WebFetch', category: 'web', label: () => 'docs.example.com/guide', ms: [1500, 5000] },
  { name: 'mcp__context7__query-docs', category: 'mcp', label: () => 'context7 · query-docs', ms: [1500, 4000] },
];

const FILES: Record<string, string[]> = {
  platform: ['package.json', 'packages/ui/package.json', 'pnpm-lock.yaml', 'turbo.json'],
  'billing-api': ['src/api/invoices.ts', 'src/api/invoices.test.ts', 'src/lib/cache.ts', 'prisma/schema.prisma'],
  storefront: ['lib/types.ts', 'components/Card.tsx', 'components/Block.tsx', 'lib/cache.ts'],
  'voice-agent': ['agent/vad.py', 'agent/config.yaml', 'tests/test_vad.py'],
};

/** Deterministik küçük RNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Pending {
  id: string;
  agentId: string | null;
  endAt: number;
  ok: boolean;
  name: string;
}

interface SimAgent {
  id: string;
  hintId: string;
  endAt: number;
  nextCallAt: number;
}

interface SimSession {
  seed: SessionSeed;
  id: string;
  pid: number;
  status: 'busy' | 'idle' | 'waiting';
  statusSince: number;
  next: number;
  pending: Pending[];
  agents: SimAgent[];
  startedAt: number;
}

export interface DemoEngineOptions {
  clock?: Clock;
  seed?: number;
  /** true: zamanlayıcı yok, ilerletme step() ile (testler). */
  manual?: boolean;
  stepMs?: number;
}

export class DemoEngine implements BoardEngine {
  private readonly clock: Clock;
  private readonly rand: () => number;
  private readonly opts: DemoEngineOptions;
  private store: BoardStore;
  private tracker: SubagentTracker;
  private metas = new Map<string, AgentMeta>();
  private sims: SimSession[] = [];
  private seq = 0;
  private timers: NodeJS.Timeout[] = [];
  private snapshotCbs = new Set<(s: BoardSnapshot) => void>();
  private eventCbs = new Set<(e: BoardEvent[]) => void>();
  private last: BoardSnapshot | null = null;
  private lastPublish = 0;
  private tempo: Tempo = 'normal';

  constructor(opts: DemoEngineOptions = {}) {
    this.opts = opts;
    this.clock = opts.clock ?? systemClock;
    this.rand = rng(opts.seed ?? 20260101);
    const settings: AppSettings = {
      ...DEFAULT_SETTINGS,
      projects: Object.fromEntries(PROJECTS.map((p) => [P(p.name), { color: p.color, ...(p.emblem ? { emblem: p.emblem } : {}) }])),
    };
    const projects = new ProjectResolver({
      git: async () => null,
      settings: () => settings,
      home: HOME,
      countAgents: async (root) => PROJECTS.find((p) => P(p.name) === root)?.team?.length ?? 0,
      now: () => this.clock.now(),
    });
    let storeRef: BoardStore | null = null;
    this.tracker = new SubagentTracker({
      projectRootOf: (sid) => storeRef?.rootOf(sid) ?? null,
      now: () => this.clock.now(),
      readMeta: async (p) => this.metas.get(p) ?? null,
      agentFileExists: async (root, type) => PROJECTS.some((p) => P(p.name) === root && p.team?.includes(type)),
      onAsyncChange: () => storeRef?.markDirty(),
    });
    this.store = new BoardStore({ clock: this.clock, projects, subagents: this.tracker });
    storeRef = this.store;
  }

  private demoStart = 0;

  /** 02/08 sahte limitler: 5 saatlik pencere dakikada ~%0.4 dolar (2 sa sonra sıfırlanır), haftalık sabit. */
  private updateLimits(now: number): void {
    const min = (now - this.demoStart) / 60_000;
    const resetAt = this.demoStart + 2 * 3_600_000;
    this.store.setLimits({
      fiveHour: { pct: Math.min(99, Math.round((47 + min * 0.4) * 10) / 10), resetsAt: resetAt },
      week: { pct: 63, resetsAt: this.demoStart + 3 * 86_400_000 + 4 * 3_600_000 },
      at: Math.floor(now / 15_000) * 15_000, // statusLine yaklaşık 15 sn'de bir tazelenir gibi
    });
  }

  async start(): Promise<void> {
    const now = this.clock.now();
    this.store.setBooted(false);
    this.sims = SESSIONS.map((seed, i) => ({
      seed,
      id: `de${String(i).padStart(6, '0')}-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
      pid: 90001 + i,
      status: i === 2 ? 'idle' : 'busy',
      statusSince: now - 30_000 * (i + 1),
      next: now + 5000 + i * 7000,
      pending: [],
      agents: [],
      startedAt: now - 3600_000 + i * 600_000,
    }));
    this.pushRegistry();
    // Biraz geçmiş: her session'da birkaç tamamlanmış araç ve maliyet.
    for (const s of this.sims) {
      this.ev({ type: 'session-meta', sessionId: s.id, agentId: null, ts: now - 600_000, title: s.seed.title, cwd: s.seed.cwd, model: s.seed.model, branch: 'main' });
      this.ev({ type: 'prompt', sessionId: s.id, agentId: null, ts: now - 590_000, variant: 'user', text: s.seed.title.toLowerCase() });
      for (let k = 0; k < 4; k++) {
        const id = this.callId();
        const tpl = this.pickTool();
        const file = this.pickFile(s);
        this.ev(this.startEv(s, id, tpl, file, null, now - 500_000 + k * 60_000));
        this.ev({ type: 'tool-end', sessionId: s.id, agentId: null, ts: now - 495_000 + k * 60_000, toolUseId: id, ok: true });
        this.usage(s, null, now - 494_000 + k * 60_000);
      }
    }
    this.demoStart = now;
    this.updateLimits(now);
    this.store.tick();
    this.store.setBooted(true);
    this.publish(true);
    if (!this.opts.manual) {
      this.every(this.opts.stepMs ?? 500, () => void this.step());
      this.every(THRESHOLDS.eventBatchMs, () => this.flush());
      this.every(THRESHOLDS.snapshotThrottleMs, () => {
        this.store.tick();
        this.publish(false);
      });
    }
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  resume(): void {
    this.store.markDirty();
  }

  async restart(_opts: { configDir: string | null }): Promise<void> {
    // Demo modunda config dizini kullanılmaz.
  }

  setTempo(t: Tempo): void {
    this.tempo = t;
  }

  getSnapshot(): BoardSnapshot {
    return this.last ?? { ...this.store.snapshot(), fastStatus: 'off' };
  }

  onSnapshot(cb: (s: BoardSnapshot) => void): () => void {
    this.snapshotCbs.add(cb);
    return () => this.snapshotCbs.delete(cb);
  }

  onEvents(cb: (e: BoardEvent[]) => void): () => void {
    this.eventCbs.add(cb);
    return () => this.eventCbs.delete(cb);
  }

  /** Bir simülasyon adımı (manual modda testler çağırır). */
  async step(): Promise<void> {
    const now = this.clock.now();
    let regChanged = false;
    for (const s of this.sims) {
      // Biten çağrılar
      for (const p of [...s.pending]) {
        if (p.endAt > now || (s.status === 'waiting' && p.agentId === null && p.name === 'Bash')) continue;
        s.pending.splice(s.pending.indexOf(p), 1);
        this.ev({ type: 'tool-end', sessionId: s.id, agentId: p.agentId, ts: now, toolUseId: p.id, ok: p.ok });
        this.usage(s, p.agentId, now);
      }
      // Subagent'lar
      for (const a of [...s.agents]) {
        if (now >= a.endAt && !s.pending.some((p) => p.agentId === a.id)) {
          s.agents.splice(s.agents.indexOf(a), 1);
          this.ev({ type: 'stop', sessionId: s.id, agentId: a.id, ts: now, reason: 'end_turn' });
          this.ev({ type: 'tool-end', sessionId: s.id, agentId: null, ts: now, toolUseId: a.hintId, ok: this.rand() > 0.08, linkedAgentId: a.id, meta: 'completed' });
        } else if (now >= a.nextCallAt && !s.pending.some((p) => p.agentId === a.id)) {
          this.call(s, a.id, now);
          a.nextCallAt = now + 1500 + this.rand() * 4000;
        }
      }

      switch (s.status) {
        case 'idle':
          if (now >= s.next) {
            this.ev({ type: 'prompt', sessionId: s.id, agentId: null, ts: now, variant: 'user', text: this.pick(['devam et', 'testleri düzelt', 'özetle', 'şunu da ekle']) });
            this.setStatus(s, 'busy', now, 25_000 + this.rand() * 50_000);
            regChanged = true;
          }
          break;
        case 'waiting':
          if (now >= s.next) {
            this.setStatus(s, 'busy', now, 10_000 + this.rand() * 20_000);
            for (const p of s.pending) if (p.agentId === null) p.endAt = now + 2000;
            regChanged = true;
          }
          break;
        case 'busy': {
          const mainBusy = s.pending.some((p) => p.agentId === null);
          if (now >= s.next && !mainBusy && s.agents.length === 0) {
            this.ev({ type: 'assistant-text', sessionId: s.id, agentId: null, ts: now, text: 'Tamamlandı, değişiklikleri özetledim.' });
            this.ev({ type: 'stop', sessionId: s.id, agentId: null, ts: now, reason: 'end_turn' });
            this.setStatus(s, 'idle', now, 12_000 + this.rand() * 30_000);
            regChanged = true;
            break;
          }
          if (mainBusy || now >= s.next) break;
          const team = PROJECTS.find((p) => p.name === s.seed.project)?.team;
          if (team && s.agents.length < 3 && this.rand() < 0.25) {
            await this.spawn(s, team, now);
          } else if (this.rand() < 0.08 && s.seed.project !== 'platform') {
            // Onay bekleyen Bash
            const id = this.callId();
            const tpl = TOOLS.find((t) => t.name === 'Bash') as ToolTpl;
            this.ev({ ...this.startEv(s, id, tpl, '', null, now), label: 'npm run db:migrate' });
            s.pending.push({ id, agentId: null, endAt: Number.MAX_SAFE_INTEGER, ok: true, name: 'Bash' });
            this.setStatus(s, 'waiting', now, 8000 + this.rand() * 12_000, 'permission:Bash');
            regChanged = true;
          } else if (this.rand() < 0.7) {
            this.call(s, null, now);
          }
          break;
        }
      }
    }
    if (regChanged) this.pushRegistry();
    this.updateLimits(now);
    this.store.tick();
    if (this.opts.manual) {
      this.flush();
      this.publish(false);
    }
  }

  // ---------- iç ----------

  private every(ms: number, fn: () => void): void {
    const t = setInterval(() => {
      try {
        fn();
      } catch (e) {
        console.error('[demo]', e);
      }
    }, ms);
    t.unref?.();
    this.timers.push(t);
  }

  private flush(): void {
    const evs = this.store.drainEvents();
    if (evs.length) for (const cb of this.eventCbs) cb(evs);
  }

  private publish(force: boolean): void {
    const now = this.clock.now();
    const period = this.tempo === 'background' ? 5000 : 0;
    if (!force && !this.store.dirty && now - this.lastPublish < 5000) return;
    if (!force && now - this.lastPublish < period) return;
    this.last = { ...this.store.snapshot(), fastStatus: 'off' };
    this.lastPublish = now;
    for (const cb of this.snapshotCbs) cb(this.last);
  }

  private ev(e: EngineEvent): void {
    this.store.apply(e);
  }

  private pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.rand() * xs.length) % xs.length] as T;
  }

  private callId(): string {
    return `toolu_demo_${(++this.seq).toString(36).padStart(6, '0')}`;
  }

  private pickTool(): ToolTpl {
    return this.pick(TOOLS);
  }

  private pickFile(s: SimSession): string {
    const list = FILES[s.seed.project] ?? ['README.md'];
    // storefront: iki session aynı dosyayı düzenleyebilir → ara sıra çakışma.
    return `${P(s.seed.project)}/${this.pick(list)}`;
  }

  private startEv(s: SimSession, id: string, tpl: ToolTpl, file: string, agentId: string | null, ts: number): Extract<EngineEvent, { type: 'tool-start' }> {
    const rel = file.startsWith(P(s.seed.project) + '/') ? file.slice(P(s.seed.project).length + 1) : file;
    const ev: Extract<EngineEvent, { type: 'tool-start' }> = {
      type: 'tool-start',
      sessionId: s.id,
      agentId,
      ts,
      toolUseId: id,
      name: tpl.name,
      category: tpl.category,
      label: tpl.label(rel),
    };
    if (tpl.file && file) ev.file = file;
    return ev;
  }

  private call(s: SimSession, agentId: string | null, now: number): void {
    const tpl = this.pickTool();
    const id = this.callId();
    const file = tpl.file ? this.pickFile(s) : '';
    this.ev(this.startEv(s, id, tpl, file, agentId, now));
    const [lo, hi] = tpl.ms;
    const slow = tpl.name === 'Bash' && this.rand() < 0.03 ? 200_000 : 0;
    s.pending.push({ id, agentId, endAt: now + lo + this.rand() * (hi - lo) + slow, ok: this.rand() > 0.06, name: tpl.name });
  }

  private async spawn(s: SimSession, team: string[], now: number): Promise<void> {
    const type = this.pick(team.concat('Explore'));
    const desc = this.pick(AGENT_DESC[type] ?? ['alt görev']);
    const hintId = this.callId();
    const agentId = `a${(++this.seq).toString(16).padStart(15, '0')}`;
    this.ev({ type: 'tool-start', sessionId: s.id, agentId: null, ts: now, toolUseId: hintId, name: 'Agent', category: 'agent', label: desc });
    this.ev({ type: 'subagent-hint', sessionId: s.id, agentId: null, ts: now, toolUseId: hintId, description: desc, subagentType: type, background: false });
    const metaPath = `/demo/agent-${agentId}.meta.json`;
    this.metas.set(metaPath, { description: desc, agentType: type, model: this.rand() < 0.5 ? 'claude-haiku-5-5' : 'inherit' });
    this.store.ensureSession(s.id);
    this.store.applyTrackerChanges(await this.tracker.onFileAdded(`/demo/agent-${agentId}.jsonl`, s.id, agentId));
    s.agents.push({ id: agentId, hintId, endAt: now + 20_000 + this.rand() * 60_000, nextCallAt: now + 500 });
  }

  private usage(s: SimSession, agentId: string | null, ts: number): void {
    const model = agentId ? 'claude-haiku-5-5' : s.seed.model;
    this.ev({
      type: 'usage',
      sessionId: s.id,
      agentId,
      ts,
      msgId: `msg_demo_${++this.seq}`,
      model,
      input: Math.round(500 + this.rand() * 3000),
      output: Math.round(100 + this.rand() * 1200),
      cacheRead: Math.round(20_000 + this.rand() * 180_000),
      cacheWrite: Math.round(this.rand() * 4000),
      cacheWrite1h: 0,
      speed: 'standard',
    });
  }

  private setStatus(s: SimSession, st: SimSession['status'], now: number, nextIn: number, waitingFor: string | null = null): void {
    s.status = st;
    s.statusSince = now;
    s.next = now + nextIn;
    this.waiting.set(s.id, waitingFor);
  }

  private waiting = new Map<string, string | null>();

  private pushRegistry(): void {
    const now = this.clock.now();
    const entries: RegistryEntry[] = this.sims.map((s) => ({
      sessionId: s.id,
      pid: s.pid,
      status: s.status,
      rawStatus: s.status,
      waitingForRaw: this.waiting.get(s.id) ?? null,
      name: s.seed.name,
      cwd: s.seed.cwd,
      entrypoint: 'cli',
      startedAt: s.startedAt,
      updatedAt: now,
      statusSince: s.statusSince,
      procStart: null,
      file: `demo:${s.pid}`,
    }));
    this.store.applyRegistry(entries);
  }
}
