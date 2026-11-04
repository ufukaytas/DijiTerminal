// Motorun iç olay tipleri
// Ham transcript kayıtları normalizeRecord() ile bu olaylara çevrilir; motorun geri kalanı ham kayıt görmez.
import type { ToolCategory } from '@shared/types';

interface EvBase {
  sessionId: string;
  agentId: string | null;
  ts: number;
  uuid?: string;
}

export type EngineEvent =
  | (EvBase & {
      type: 'session-meta';
      title?: string;
      lastPrompt?: string;
      cwd?: string;
      branch?: string;
      model?: string;
      effort?: string;
    })
  | (EvBase & { type: 'prompt'; variant: 'user' | 'command' | 'task-notification'; text: string })
  | (EvBase & {
      type: 'tool-start';
      toolUseId: string;
      name: string;
      category: ToolCategory;
      label: string;
      file?: string;
      command?: string;
    })
  | (EvBase & {
      type: 'tool-end';
      toolUseId: string;
      ok: boolean;
      meta?: string;
      hosts?: string[];
      linkedAgentId?: string;
      agentDescription?: string;
      resolvedModel?: string;
      interrupted?: boolean;
    })
  | (EvBase & { type: 'assistant-text'; text: string })
  | (EvBase & { type: 'thinking' })
  | (EvBase & { type: 'stop'; reason: string }) // 'end_turn' | 'tool_use' | 'max_tokens' | …
  | (EvBase & {
      type: 'usage';
      msgId: string;
      model: string;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      cacheWrite1h: number;
      speed: 'fast' | 'standard';
    })
  | (EvBase & { type: 'turn-duration'; durationMs: number })
  | (EvBase & { type: 'compact' })
  | (EvBase & { type: 'api-error'; message: string })
  | (EvBase & { type: 'interrupted' })
  | (EvBase & {
      type: 'subagent-hint';
      toolUseId: string;
      description: string;
      subagentType: string;
      background: boolean;
    });

export type EngineEventType = EngineEvent['type'];

export interface NormalizerState {
  /** Usage'ı çift saymamak için görülen message.id'ler (gün dönümünde store sıfırlar). */
  seenMsgIds: Set<string>;
  /** Tanınmayan kayıt tipleri — yeni Claude Code sürümünde format değişikliğini fark etmek için. */
  unknownTypes: Record<string, number>;
  /** sessionId → son yayınlanan meta değerleri (yalnızca değişince session-meta üretilir). */
  lastMeta: Map<string, { cwd?: string; branch?: string; model?: string; effort?: string }>;
}

export interface NormalizeCtx {
  sessionId: string;
  agentId: string | null;
  state: NormalizerState;
}

export function createNormalizerState(): NormalizerState {
  return { seenMsgIds: new Set(), unknownTypes: {}, lastMeta: new Map() };
}
