// Ham transcript kaydı → EngineEvent[]
// Claude Code transcript formatına bağımlılığın tek noktası. Format değişirse yalnızca bu dosya yamalanır.
// Yan etkisiz: durum (tekrar önleme, son meta) dışarıdan NormalizeCtx.state ile verilir. Dosya erişimi yok.
import { categoryOf } from '@shared/constants';
import type { EngineEvent, NormalizeCtx } from './events';
import { fmtBytes, safeText, summarizeTool } from './summarize';

type Rec = Record<string, unknown>;

const LIMITS = { title: 90, prompt: 220, text: 160, error: 100, agentDescription: 70 } as const;

const isObj = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const safe = (s: string, n: number): string => safeText(s, n);

type Base = { sessionId: string; agentId: string | null; ts: number; uuid?: string };

/**
 * Gerçek transcript'lerde görülen ama UI'ın kullanmadığı kayıt tipleri (2026-10 inspect-format bulguları).
 * Bilinçli olarak yok sayılır; unknownTypes'ı şişirip format değişikliği alarmını boğmasınlar.
 * Prefilter'a eklenmediler: bayt düzeyinde `"type":"mode"` gibi kısa iğneler başka kayıtlarda yanlış pozitif verebilir.
 */
export const IGNORED_TYPES: ReadonlySet<string> = new Set([
  'atis-latch',
  'frame-link',
  'mode',
  'tools-used',
  'cost-state',
  'fork-context-ref',
]);

export function normalizeRecord(rec: Rec, ctx: NormalizeCtx): EngineEvent[] {
  const type = str(rec.type);
  if (type && IGNORED_TYPES.has(type)) return [];
  const handler = type ? HANDLERS[type] : undefined;
  if (!handler) {
    const key = type ?? '(tipsiz)';
    ctx.state.unknownTypes[key] = (ctx.state.unknownTypes[key] ?? 0) + 1;
    return [];
  }

  const sessionId = str(rec.sessionId) ?? ctx.sessionId;
  const agentId = ctx.agentId ?? (rec.isSidechain === true ? (str(rec.agentId) ?? null) : null);
  const ts = Date.parse(str(rec.timestamp) ?? '') || 0;
  const base: Base = { sessionId, agentId, ts };
  const uuid = str(rec.uuid);
  if (uuid) base.uuid = uuid;

  const out: EngineEvent[] = [];
  if (agentId === null) metaFromLocation(rec, base, ctx, out);
  handler(rec, base, ctx, out);
  return out;
}

type Handler = (rec: Rec, base: Base, ctx: NormalizeCtx, out: EngineEvent[]) => void;

const HANDLERS: Record<string, Handler> = {
  'ai-title': (rec, base, _ctx, out) => {
    const t = str(rec.aiTitle);
    if (t) out.push({ ...base, type: 'session-meta', title: safe(t, LIMITS.title) });
  },
  'last-prompt': (rec, base, _ctx, out) => {
    const p = str(rec.lastPrompt);
    if (p && base.agentId === null) out.push({ ...base, type: 'session-meta', lastPrompt: safe(p, LIMITS.prompt) });
  },
  assistant: onAssistant,
  user: onUser,
  system: onSystem,
};

/** cwd / gitBranch değiştiyse session-meta (yalnızca ana ajan). */
function metaFromLocation(rec: Rec, base: Base, ctx: NormalizeCtx, out: EngineEvent[]): void {
  const cwd = str(rec.cwd);
  const branchRaw = str(rec.gitBranch);
  const branch = branchRaw && branchRaw !== 'HEAD' ? branchRaw : undefined;
  if (!cwd && !branch) return;
  const last = metaOf(ctx, base.sessionId);
  const ev: Extract<EngineEvent, { type: 'session-meta' }> = { ...base, type: 'session-meta' };
  let changed = false;
  if (cwd && cwd !== last.cwd) {
    last.cwd = cwd;
    ev.cwd = cwd;
    changed = true;
  }
  if (branch && branch !== last.branch) {
    last.branch = branch;
    ev.branch = branch;
    changed = true;
  }
  if (changed) out.push(ev);
}

function metaOf(ctx: NormalizeCtx, sessionId: string) {
  let m = ctx.state.lastMeta.get(sessionId);
  if (!m) {
    m = {};
    ctx.state.lastMeta.set(sessionId, m);
  }
  return m;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is Rec => isObj(b) && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join(' ');
}

function onAssistant(rec: Rec, base: Base, ctx: NormalizeCtx, out: EngineEvent[]): void {
  const m = isObj(rec.message) ? rec.message : {};
  const model = str(m.model);
  const content = m.content;

  if (rec.isApiErrorMessage === true || model === '<synthetic>') {
    out.push({ ...base, type: 'api-error', message: safe(textOf(content), LIMITS.error) || 'API hatası' });
    return;
  }

  if (base.agentId === null) {
    const last = metaOf(ctx, base.sessionId);
    if (model && model !== last.model) {
      last.model = model;
      out.push({ ...base, type: 'session-meta', model });
    }
    const effort = str(rec.effort);
    if (effort && effort !== last.effort) {
      last.effort = effort;
      out.push({ ...base, type: 'session-meta', effort });
    }
  }

  // Aynı mesaj her content bloğu için ayrı satırda tekrar eder: usage yalnızca bir kez.
  const usage = isObj(m.usage) ? m.usage : null;
  const msgId = str(m.id) ?? base.uuid;
  if (usage && msgId && !ctx.state.seenMsgIds.has(msgId)) {
    ctx.state.seenMsgIds.add(msgId);
    const cc = isObj(usage.cache_creation) ? usage.cache_creation : {};
    out.push({
      ...base,
      type: 'usage',
      msgId,
      model: model ?? '',
      input: num(usage.input_tokens),
      output: num(usage.output_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
      cacheWrite: num(usage.cache_creation_input_tokens),
      cacheWrite1h: num(cc.ephemeral_1h_input_tokens),
      speed: usage.speed === 'fast' ? 'fast' : 'standard',
    });
  }

  const stop = str(m.stop_reason);
  if (stop) out.push({ ...base, type: 'stop', reason: stop });

  if (typeof content === 'string') {
    if (content.trim()) out.push({ ...base, type: 'assistant-text', text: safe(content, LIMITS.text) });
    return;
  }
  if (!Array.isArray(content)) return;

  content.forEach((b, idx) => {
    if (!isObj(b)) return;
    switch (b.type) {
      case 'tool_use': {
        const name = str(b.name) ?? '?';
        const toolUseId = str(b.id) ?? `${base.uuid ?? base.ts}:${idx}`;
        const s = summarizeTool(name, b.input);
        const ev: Extract<EngineEvent, { type: 'tool-start' }> = {
          ...base,
          type: 'tool-start',
          toolUseId,
          name,
          category: categoryOf(name),
          label: s.label,
        };
        if (s.file) ev.file = s.file;
        if (s.command) ev.command = s.command;
        out.push(ev);
        if (name === 'Agent' || name === 'Task') {
          const input = isObj(b.input) ? b.input : {};
          out.push({
            ...base,
            type: 'subagent-hint',
            toolUseId,
            description: safe(str(input.description) ?? '', LIMITS.agentDescription),
            subagentType: str(input.subagent_type) ?? '',
            background: input.run_in_background === true,
          });
        }
        break;
      }
      case 'text': {
        const t = str(b.text);
        if (t && t.trim()) out.push({ ...base, type: 'assistant-text', text: safe(t, LIMITS.text) });
        break;
      }
      case 'thinking':
      case 'redacted_thinking':
        out.push({ ...base, type: 'thinking' });
        break;
    }
  });
}

function onUser(rec: Rec, base: Base, _ctx: NormalizeCtx, out: EngineEvent[]): void {
  const m = isObj(rec.message) ? rec.message : {};
  const content = m.content;
  const isMain = base.agentId === null;
  const isMeta = rec.isMeta === true;

  if (typeof content === 'string') {
    if (isMain && !isMeta) promptFrom(content, base, out);
    return;
  }
  if (!Array.isArray(content)) return;

  let hasResult = false;
  for (const b of content) {
    if (!isObj(b) || b.type !== 'tool_result') continue;
    hasResult = true;
    const toolUseId = str(b.tool_use_id);
    if (!toolUseId) continue;
    out.push({ ...base, type: 'tool-end', toolUseId, ok: b.is_error !== true, ...metaFrom(rec.toolUseResult) });
  }
  if (!hasResult && isMain && !isMeta) promptFrom(textOf(content), base, out);
}

function promptFrom(raw: string, base: Base, out: EngineEvent[]): void {
  const t = raw.trim();
  if (!t) return;
  if (t.startsWith('[Request interrupted')) {
    out.push({ ...base, type: 'interrupted' });
    return;
  }
  if (t.startsWith('<task-notification')) {
    out.push({ ...base, type: 'prompt', variant: 'task-notification', text: 'arka plan görevi sonuç bildirdi' });
    return;
  }
  if (t.startsWith('<') || t.startsWith('Caveat:')) {
    const cmd = /<command-name>([^<]+)<\/command-name>/.exec(t)?.[1]?.trim();
    if (cmd) out.push({ ...base, type: 'prompt', variant: 'command', text: safe(cmd, LIMITS.text) });
    return;
  }
  out.push({ ...base, type: 'prompt', variant: 'user', text: safe(t, LIMITS.prompt) });
}

type ToolEndMeta = Pick<
  Extract<EngineEvent, { type: 'tool-end' }>,
  'meta' | 'hosts' | 'linkedAgentId' | 'agentDescription' | 'resolvedModel' | 'interrupted'
>;

/** toolUseResult'tan yalnızca bilinen alanlar okunur; şekli araçtan araca değişir. */
function metaFrom(tr: unknown): ToolEndMeta {
  if (!isObj(tr)) return {};
  if (str(tr.url) && (typeof tr.code === 'number' || typeof tr.code === 'string')) {
    const bytes = typeof tr.bytes === 'number' && tr.bytes > 0 ? ` · ${fmtBytes(tr.bytes)}` : '';
    return { meta: `${tr.code}${bytes}` };
  }
  if (str(tr.query) !== undefined && Array.isArray(tr.results)) {
    const links = tr.results.flatMap((r) => (isObj(r) && Array.isArray(r.content) ? r.content : []));
    const hosts: string[] = [];
    for (const l of links) {
      if (!isObj(l)) continue;
      const h = hostOf(str(l.url));
      if (h && !hosts.includes(h)) hosts.push(h);
      if (hosts.length === 4) break;
    }
    return { meta: `${links.length} sonuç`, hosts };
  }
  if (str(tr.agentId)) {
    const r: ToolEndMeta = { linkedAgentId: tr.agentId as string, meta: str(tr.status) ?? '' };
    const d = str(tr.description);
    if (d) r.agentDescription = safe(d, LIMITS.agentDescription);
    const rm = str(tr.resolvedModel);
    if (rm) r.resolvedModel = rm;
    return r;
  }
  if (tr.interrupted === true) return { interrupted: true, meta: 'interrupted' };
  return {};
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

function onSystem(rec: Rec, base: Base, _ctx: NormalizeCtx, out: EngineEvent[]): void {
  const subtype = str(rec.subtype);
  if (subtype === 'turn_duration' && typeof rec.durationMs === 'number') {
    out.push({ ...base, type: 'turn-duration', durationMs: rec.durationMs });
  } else if (subtype === 'compact_boundary') {
    out.push({ ...base, type: 'compact' });
  } else if (rec.level === 'error' || subtype === 'api_error') {
    out.push({ ...base, type: 'api-error', message: safe(str(rec.content) ?? subtype ?? 'API hatası', LIMITS.error) });
  }
}
