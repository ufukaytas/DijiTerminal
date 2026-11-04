// Ajan çalışma zamanı durumu — 02/04. Ana ajan ('main') ve subagent'lar aynı yapıyla izlenir.
import type { ToolCall } from '@shared/types';

export interface AgentMeta {
  description?: string;
  agentType?: string;
  model?: string;
  requestShape?: string;
}

export interface AgentRuntime {
  sessionId: string;
  id: string; // 'main' ya da agentId
  isMain: boolean;
  desc: string;
  agentType: string; // ana ajan için ''
  team: string | null;
  model: string; // ham model id'si; boşsa session modeli
  background: boolean;
  pending: Map<string, ToolCall>;
  current: ToolCall | null;
  sig: string[]; // son 4 'name|label'
  endTurn: boolean;
  done: boolean;
  doneAt: number | null;
  toolCount: number;
  errorCount: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  firstTs: number;
  lastTs: number;
  /** İç: transcript dosyası (meta yeniden okumak için), meta okundu mu, takım çözümlemesi yapıldı mı. */
  file: string | null;
  metaLoaded: boolean;
  teamResolved: boolean;
  /** Eşlenen Agent aracı çağrısının toolUseId'si (ipucu). */
  hintId: string | null;
}

export function createRuntime(sessionId: string, id: string, isMain: boolean): AgentRuntime {
  return {
    sessionId,
    id,
    isMain,
    desc: '',
    agentType: '',
    team: null,
    model: '',
    background: false,
    pending: new Map(),
    current: null,
    sig: [],
    endTurn: !isMain ? false : true,
    done: false,
    doneAt: null,
    toolCount: 0,
    errorCount: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    firstTs: 0,
    lastTs: 0,
    file: null,
    metaLoaded: isMain,
    teamResolved: isMain,
    hintId: null,
  };
}

/** Son 4 imzayı tutar. */
export function pushSig(rt: AgentRuntime, sig: string): void {
  rt.sig.push(sig);
  if (rt.sig.length > 4) rt.sig.splice(0, rt.sig.length - 4);
}

/** Kalan pending çağrılarından en yenisi. */
export function latestPending(rt: AgentRuntime): ToolCall | null {
  let best: ToolCall | null = null;
  for (const c of rt.pending.values()) if (!best || c.startedAt >= best.startedAt) best = c;
  return best;
}
