// Subagent takibi
// Ana ajan ve subagent'ların durum makinesi. apply() değişiklik listesi döndürür; store BoardEvent'e çevirir.
// Dosya erişimi yalnızca enjekte edilen readMeta / agentFileExists üzerinden (varsayılanlar salt okunur).
import fs from 'node:fs';
import path from 'node:path';
import { THRESHOLDS } from '@shared/constants';
import type { AgentView, SessionStatus, ToolCall } from '@shared/types';
import { createRuntime, latestPending, pushSig, type AgentMeta, type AgentRuntime } from './agent-runtime';
import type { EngineEvent } from './events';
import { redact } from './redact';
import { clip, shortModel } from './summarize';

export type TrackerChange =
  | { kind: 'spawned'; sessionId: string; agentId: string; parentAgentId: string | null }
  | { kind: 'done'; sessionId: string; agentId: string; ok: boolean }
  | { kind: 'removed'; sessionId: string; agentId: string }
  | {
      kind: 'usage';
      sessionId: string;
      agentId: string;
      model: string;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      cacheWrite1h: number;
      speed: 'fast' | 'standard';
    }
  | { kind: 'current'; sessionId: string; agentId: string; call: ToolCall | null };

interface Hint {
  toolUseId: string;
  sessionId: string;
  description: string;
  subagentType: string;
  background: boolean;
  ts: number;
  agentId: string | null; // eşlendiyse
}

export interface SubagentTrackerDeps {
  readMeta?: (path: string) => Promise<AgentMeta | null>;
  agentFileExists?: (projectRoot: string, agentType: string) => Promise<boolean>;
  projectRootOf: (sessionId: string) => string | null;
  now?: () => number;
  /** Asenkron güncelleme (meta, takım) geldiğinde store'u kirletmek için. */
  onAsyncChange?: () => void;
}

const BUSY_LIMIT_MS = 15 * 60_000;
const IDLE_LIMIT_MS = 3 * 60_000;
const BG_QUIET_MS = 20_000;
/** Bu kadar sessiz kalmış ajanın bitişi son kaydına çekilir (canlı bitişlerde tespit anı kalır). */
const STALE_FINISH_MS = 3 * BG_QUIET_MS;
const META_RETRY_MS = 60_000;
const DESC_MAX = 70;

async function defaultReadMeta(p: string): Promise<AgentMeta | null> {
  try {
    const j: unknown = JSON.parse(await fs.promises.readFile(p, 'utf8'));
    if (typeof j !== 'object' || j === null || Array.isArray(j)) return null;
    const o = j as Record<string, unknown>;
    const s = (k: string): string | undefined => (typeof o[k] === 'string' ? (o[k] as string) : undefined);
    const meta: AgentMeta = {};
    const description = s('description');
    const agentType = s('agentType');
    const model = s('model');
    const requestShape = s('requestShape');
    if (description !== undefined) meta.description = description;
    if (agentType !== undefined) meta.agentType = agentType;
    if (model !== undefined) meta.model = model;
    if (requestShape !== undefined) meta.requestShape = requestShape;
    return meta;
  } catch {
    return null;
  }
}

const SAFE_TYPE = /^[A-Za-z0-9_.-]{1,100}$/;

function makeAgentFileExists(): (root: string, agentType: string) => Promise<boolean> {
  const cache = new Map<string, boolean>();
  return async (root, agentType) => {
    if (!SAFE_TYPE.test(agentType) || agentType.startsWith('.')) return false;
    const p = path.join(root, '.claude', 'agents', `${agentType}.md`);
    const hit = cache.get(p);
    if (hit !== undefined) return hit;
    const ok = await fs.promises.access(p).then(
      () => true,
      () => false,
    );
    cache.set(p, ok);
    return ok;
  };
}

/** agent-<id>.jsonl → agent-<id>.meta.json */
export function metaPathFor(jsonl: string): string {
  return jsonl.replace(/\.jsonl$/, '.meta.json');
}

export class SubagentTracker {
  private readonly readMeta: (path: string) => Promise<AgentMeta | null>;
  private readonly agentFileExists: (projectRoot: string, agentType: string) => Promise<boolean>;
  private readonly projectRootOf: (sessionId: string) => string | null;
  private readonly now: () => number;
  private readonly onAsyncChange: () => void;

  private sessions = new Map<string, Map<string, AgentRuntime>>();
  private hints = new Map<string, Hint>(); // toolUseId → ipucu
  /** tool-end linkedAgentId geldi ama ajan henüz bilinmiyor: agentId → toolUseId */
  private links = new Map<string, string>();
  /** 02/09 SubagentStop adayları: agentId → ipucu zamanı */
  private stopHints = new Map<string, number>();

  constructor(deps: SubagentTrackerDeps) {
    this.readMeta = deps.readMeta ?? defaultReadMeta;
    this.agentFileExists = deps.agentFileExists ?? makeAgentFileExists();
    this.projectRootOf = deps.projectRootOf;
    this.now = deps.now ?? Date.now;
    this.onAsyncChange = deps.onAsyncChange ?? (() => undefined);
  }

  // ---------- erişim ----------

  ensureMain(sessionId: string): AgentRuntime {
    return this.ensure(sessionId, 'main').rt;
  }

  get(sessionId: string, agentId: string): AgentRuntime | undefined {
    return this.sessions.get(sessionId)?.get(agentId);
  }

  /** main ilk, sonra çalışanlar (lastTs desc), sonra bitenler. */
  agents(sessionId: string, statusOf?: SessionStatus | null): AgentRuntime[] {
    const m = this.sessions.get(sessionId);
    if (!m) return [];
    const main = m.get('main');
    const rest = [...m.values()].filter((a) => !a.isMain);
    const st = statusOf ?? null;
    const running = rest.filter((a) => !a.done && this.isRunning(a, st)).sort((a, b) => b.lastTs - a.lastTs);
    const others = rest.filter((a) => !running.includes(a)).sort((a, b) => b.lastTs - a.lastTs);
    return [...(main ? [main] : []), ...running, ...others];
  }

  sessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  // ---------- dosya / meta ----------

  async onFileAdded(filePath: string, sessionId: string, agentId: string | null): Promise<TrackerChange[]> {
    if (agentId === null) return [];
    const changes: TrackerChange[] = [];
    const { rt, created } = this.ensure(sessionId, agentId);
    if (created) changes.push({ kind: 'spawned', sessionId, agentId, parentAgentId: null });
    if (filePath.endsWith('.jsonl')) rt.file = filePath;
    const metaPath = filePath.endsWith('.meta.json') ? filePath : metaPathFor(filePath);
    await this.loadMeta(rt, metaPath);
    this.matchHint(rt);
    await this.resolveTeam(rt);
    return changes;
  }

  /** Meta'sı ya da takımı henüz çözülmemiş ajanlar için tekrar dener (orkestratör birkaç saniyede bir çağırır). */
  async refreshPending(): Promise<boolean> {
    let changed = false;
    const now = this.now();
    for (const m of this.sessions.values()) {
      for (const rt of m.values()) {
        if (rt.isMain) continue;
        if (!rt.metaLoaded && rt.file && now - (rt.firstTs || now) < META_RETRY_MS) {
          if (await this.loadMeta(rt, metaPathFor(rt.file))) changed = true;
        }
        if (!rt.teamResolved && rt.agentType) {
          if (await this.resolveTeam(rt)) changed = true;
        }
      }
    }
    return changed;
  }

  private async loadMeta(rt: AgentRuntime, metaPath: string): Promise<boolean> {
    const meta = await this.readMeta(metaPath);
    if (!meta) return false;
    rt.metaLoaded = true;
    if (meta.description) rt.desc = clip(redact(meta.description), DESC_MAX);
    if (meta.agentType) {
      if (meta.agentType !== rt.agentType) rt.teamResolved = false;
      rt.agentType = meta.agentType;
    }
    if (meta.model && meta.model !== 'inherit') rt.model = meta.model;
    if (meta.requestShape === 'background') rt.background = true;
    return true;
  }

  private async resolveTeam(rt: AgentRuntime): Promise<boolean> {
    if (rt.isMain || rt.teamResolved || !rt.agentType) return false;
    const root = this.projectRootOf(rt.sessionId);
    if (!root) return false; // proje henüz çözülmedi: sonra tekrar
    const dash = rt.agentType.indexOf('-');
    let team: string | null = null;
    if (dash > 0 && (await this.agentFileExists(root, rt.agentType))) team = rt.agentType.slice(0, dash);
    rt.teamResolved = true;
    if (team !== rt.team) {
      rt.team = team;
      return true;
    }
    return false;
  }

  /** Meta açıklamasıyla eşleşen ipucu; yoksa session'daki en eski eşlenmemiş ipucu (FIFO). */
  private matchHint(rt: AgentRuntime): void {
    if (rt.isMain || rt.hintId) return;
    const free = [...this.hints.values()].filter((h) => h.sessionId === rt.sessionId && h.agentId === null);
    if (free.length === 0) return;
    free.sort((a, b) => a.ts - b.ts);
    const byDesc = rt.desc ? free.find((h) => h.description && h.description === rt.desc) : undefined;
    const h = byDesc ?? free[0];
    if (!h) return;
    this.bindHint(rt, h);
  }

  private bindHint(rt: AgentRuntime, h: Hint): void {
    h.agentId = rt.id;
    rt.hintId = h.toolUseId;
    if (!rt.desc && h.description) rt.desc = h.description;
    if (!rt.agentType && h.subagentType) {
      rt.agentType = h.subagentType;
      rt.teamResolved = false;
    }
    if (h.background) rt.background = true;
    if (!rt.teamResolved) void this.resolveTeam(rt).then((c) => c && this.onAsyncChange());
  }

  // ---------- olaylar ----------

  apply(ev: EngineEvent): TrackerChange[] {
    const changes: TrackerChange[] = [];
    const targetId = ev.agentId ?? 'main';
    const { rt, created } = this.ensure(ev.sessionId, targetId);
    if (created && !rt.isMain) changes.push({ kind: 'spawned', sessionId: ev.sessionId, agentId: rt.id, parentAgentId: null });
    if (ev.ts > 0) {
      if (!rt.firstTs || ev.ts < rt.firstTs) rt.firstTs = ev.ts;
      if (ev.ts > rt.lastTs) rt.lastTs = ev.ts;
    }

    switch (ev.type) {
      case 'subagent-hint': {
        this.hints.set(ev.toolUseId, {
          toolUseId: ev.toolUseId,
          sessionId: ev.sessionId,
          description: ev.description,
          subagentType: ev.subagentType,
          background: ev.background,
          ts: ev.ts,
          agentId: null,
        });
        // Ajan dosyası ipucundan önce görüldüyse (ön plan sırası bozuk okuma) şimdi eşle.
        for (const other of this.sessions.get(ev.sessionId)?.values() ?? []) {
          if (!other.isMain && !other.hintId && other.desc && other.desc === ev.description) {
            const h = this.hints.get(ev.toolUseId);
            if (h) this.bindHint(other, h);
            break;
          }
        }
        break;
      }
      case 'tool-start': {
        const call: ToolCall = {
          id: ev.toolUseId,
          sessionId: ev.sessionId,
          agentId: ev.agentId,
          name: ev.name,
          category: ev.category,
          label: ev.label,
          startedAt: ev.ts,
        };
        if (ev.file) call.file = ev.file;
        rt.pending.set(ev.toolUseId, call);
        rt.current = call;
        pushSig(rt, `${ev.name}|${ev.label}`);
        rt.toolCount++;
        rt.endTurn = false;
        changes.push({ kind: 'current', sessionId: ev.sessionId, agentId: rt.id, call });
        break;
      }
      case 'tool-end': {
        let owner: AgentRuntime = rt;
        if (!rt.pending.has(ev.toolUseId)) {
          const main = this.get(ev.sessionId, 'main');
          if (main?.pending.has(ev.toolUseId)) owner = main;
        }
        const call = owner.pending.get(ev.toolUseId);
        if (call) {
          owner.pending.delete(ev.toolUseId);
          if (owner.current?.id === ev.toolUseId) {
            owner.current = latestPending(owner);
            changes.push({ kind: 'current', sessionId: ev.sessionId, agentId: owner.id, call: owner.current });
          }
        }
        if (!ev.ok) owner.errorCount++;
        if (ev.linkedAgentId) changes.push(...this.onLinked(ev));
        break;
      }
      case 'stop':
        rt.endTurn = ev.reason === 'end_turn';
        if (rt.endTurn && !rt.isMain) changes.push(...this.confirmStopHint(rt));
        break;
      case 'usage': {
        rt.tokens.input += ev.input;
        rt.tokens.output += ev.output;
        rt.tokens.cacheRead += ev.cacheRead;
        rt.tokens.cacheWrite += ev.cacheWrite;
        if (!rt.model && !rt.isMain && ev.model) rt.model = ev.model;
        changes.push({
          kind: 'usage',
          sessionId: ev.sessionId,
          agentId: rt.id,
          model: ev.model || rt.model,
          input: ev.input,
          output: ev.output,
          cacheRead: ev.cacheRead,
          cacheWrite: ev.cacheWrite,
          cacheWrite1h: ev.cacheWrite1h,
          speed: ev.speed,
        });
        break;
      }
      case 'prompt':
        if (rt.isMain && ev.variant === 'user') rt.endTurn = false;
        break;
      default:
        break;
    }
    return changes;
  }

  /** Ana transcript'te Agent aracının sonucu: ön plan ajanı bitti; arka plan ajanı yalnızca bağlanır. */
  private onLinked(ev: Extract<EngineEvent, { type: 'tool-end' }>): TrackerChange[] {
    const agentId = ev.linkedAgentId as string;
    const changes: TrackerChange[] = [];
    const { rt, created } = this.ensure(ev.sessionId, agentId);
    if (created) changes.push({ kind: 'spawned', sessionId: ev.sessionId, agentId, parentAgentId: null });
    const h = this.hints.get(ev.toolUseId);
    if (h && h.agentId === null) this.bindHint(rt, h);
    if (!rt.desc && ev.agentDescription) rt.desc = ev.agentDescription;
    if (!rt.model && ev.resolvedModel) rt.model = ev.resolvedModel;
    const async = /async|background|launched/i.test(ev.meta ?? '');
    if (async) rt.background = true;
    if (!rt.background && !rt.done) {
      rt.done = true;
      rt.doneAt = ev.ts || this.now();
      rt.pending.clear();
      rt.current = null;
      if (!ev.ok) rt.errorCount++;
      changes.push({ kind: 'done', sessionId: ev.sessionId, agentId, ok: ev.ok });
    }
    this.links.set(agentId, ev.toolUseId);
    return changes;
  }

  /** Her saniye: arka plan ajanlarının bitişi, SubagentStop adayları, görünürlük budaması. */
  tick(statusOf: (sessionId: string) => SessionStatus | null): TrackerChange[] {
    const now = this.now();
    const changes: TrackerChange[] = [];
    for (const [sid, m] of this.sessions) {
      void statusOf(sid);
      for (const rt of [...m.values()]) {
        if (rt.isMain) continue;
        if (!rt.done && rt.background && rt.endTurn && rt.pending.size === 0 && now - rt.lastTs > BG_QUIET_MS) {
          this.finish(rt, now, changes);
        }
        const stopAt = this.stopHints.get(rt.id);
        if (!rt.done && stopAt !== undefined && rt.pending.size === 0 && now - Math.max(stopAt, rt.lastTs) > BG_QUIET_MS) {
          this.finish(rt, now, changes);
        }
        if (rt.done && rt.doneAt !== null && now - rt.doneAt > THRESHOLDS.subagentVisibleMs) {
          m.delete(rt.id);
          this.forgetAgent(rt.id);
          changes.push({ kind: 'removed', sessionId: sid, agentId: rt.id });
        }
      }
    }
    return changes;
  }

  private finish(rt: AgentRuntime, at: number, out: TrackerChange[]): void {
    rt.done = true;
    // Uzun süredir sessiz ajan (ör. açılışta okunan, saatler önce bitmiş arka plan ajanı): bitiş, tespit anı
    // değil son kaydıdır. Yoksa 15 dk görünürlük ve "az önce bitti" açılıştan itibaren sayılır.
    rt.doneAt = rt.lastTs > 0 && at - rt.lastTs > STALE_FINISH_MS ? rt.lastTs : at;
    rt.current = null;
    this.stopHints.delete(rt.id);
    out.push({ kind: 'done', sessionId: rt.sessionId, agentId: rt.id, ok: true });
  }

  /** 02/09 SubagentStop hook ipucu: en yeni, pending'i olmayan çalışan ajanı aday yapar; tek başına bitirmez. */
  hintStop(sessionId: string, ts: number): TrackerChange[] {
    const m = this.sessions.get(sessionId);
    if (!m) return [];
    const cand = [...m.values()]
      .filter((a) => !a.isMain && !a.done && a.pending.size === 0 && a.lastTs <= ts)
      .sort((a, b) => b.lastTs - a.lastTs)[0];
    if (!cand) return [];
    this.stopHints.set(cand.id, ts);
    if (cand.endTurn) return this.confirmStopHint(cand);
    return [];
  }

  private confirmStopHint(rt: AgentRuntime): TrackerChange[] {
    if (!this.stopHints.has(rt.id) || rt.done || rt.pending.size > 0) return [];
    const out: TrackerChange[] = [];
    this.finish(rt, this.now(), out);
    return out;
  }

  // ---------- kurallar ----------

  isRunning(rt: AgentRuntime, sessionStatus: SessionStatus | null): boolean {
    if (rt.done) return false;
    if (rt.pending.size > 0) return true;
    const limit = sessionStatus === 'busy' ? BUSY_LIMIT_MS : IDLE_LIMIT_MS;
    return !rt.endTurn && this.now() - rt.lastTs < limit;
  }

  isLoop(rt: AgentRuntime): boolean {
    return rt.sig.length === 4 && new Set(rt.sig).size === 1;
  }

  hasActiveBackground(sessionId: string, now = this.now()): boolean {
    const m = this.sessions.get(sessionId);
    if (!m) return false;
    for (const rt of m.values()) {
      if (rt.isMain || !rt.background) continue;
      if (!rt.done) {
        if (rt.pending.size > 0) return true;
        if (!rt.endTurn && now - rt.lastTs < IDLE_LIMIT_MS) return true;
        if (now - rt.lastTs < BG_QUIET_MS) return true;
      } else if (rt.doneAt !== null && now - rt.doneAt < BG_QUIET_MS) {
        // Az önce bitti: ana ajan sonucu işlerken kart bir an "idle"a düşüp geri dönmesin.
        return true;
      }
    }
    return false;
  }

  toView(rt: AgentRuntime, ctx: { sessionModel: string; sessionStatus: SessionStatus; costUsd: number }): AgentView {
    return {
      id: rt.id,
      sessionId: rt.sessionId,
      isMain: rt.isMain,
      name: rt.isMain ? 'main' : rt.desc || rt.agentType || rt.id.slice(0, 8),
      agentType: rt.agentType,
      team: rt.team,
      model: shortModel(rt.model || ctx.sessionModel),
      background: rt.background,
      running: rt.isMain ? ctx.sessionStatus === 'busy' : this.isRunning(rt, ctx.sessionStatus),
      done: rt.done,
      current: rt.current,
      toolCount: rt.toolCount,
      errorCount: rt.errorCount,
      costUsd: ctx.costUsd,
      firstTs: rt.firstTs,
      lastTs: rt.lastTs,
      doneAt: rt.doneAt,
      loopSuspect: this.isLoop(rt),
    };
  }

  /** Idle olunca ana ajanın kesilen çağrıları takılı kalmasın. */
  clearMainPending(sessionId: string): void {
    const main = this.get(sessionId, 'main');
    if (!main) return;
    main.pending.clear();
    main.current = null;
  }

  rollDay(): void {
    // Uzun açık kalan uygulamada (günlerce) eşleşmemiş eski ipuçları birikmesin (05/02, main bellek).
    const cutoff = this.now() - 86_400_000;
    for (const [id, h] of this.hints) if (h.agentId === null && h.ts > 0 && h.ts < cutoff) this.hints.delete(id);
    for (const m of this.sessions.values()) {
      for (const rt of m.values()) {
        rt.toolCount = 0;
        rt.errorCount = 0;
        rt.tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      }
    }
  }

  dropSession(sessionId: string): void {
    const m = this.sessions.get(sessionId);
    if (m) for (const id of m.keys()) this.forgetAgent(id);
    this.sessions.delete(sessionId);
    for (const [id, h] of this.hints) if (h.sessionId === sessionId) this.hints.delete(id);
  }

  /** Listeden düşen ajanın yan kayıtları (stop ipucu, araç bağı, eşlenmiş ipucu) da silinir. */
  private forgetAgent(agentId: string): void {
    this.stopHints.delete(agentId);
    const tu = this.links.get(agentId);
    if (tu !== undefined) {
      this.links.delete(agentId);
      const h = this.hints.get(tu);
      if (h && h.agentId === agentId) this.hints.delete(tu);
    }
  }

  // ---------- iç ----------

  private ensure(sessionId: string, agentId: string): { rt: AgentRuntime; created: boolean } {
    let m = this.sessions.get(sessionId);
    if (!m) {
      m = new Map();
      this.sessions.set(sessionId, m);
    }
    if (agentId !== 'main' && !m.has('main')) m.set('main', createRuntime(sessionId, 'main', true));
    let rt = m.get(agentId);
    if (rt) return { rt, created: false };
    rt = createRuntime(sessionId, agentId, agentId === 'main');
    m.set(agentId, rt);
    return { rt, created: true };
  }
}
