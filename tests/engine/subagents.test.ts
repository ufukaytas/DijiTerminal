import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentMeta } from '@main/engine/agent-runtime';
import type { EngineEvent } from '@main/engine/events';
import { SubagentTracker, metaPathFor } from '@main/engine/subagents';
import { TranscriptPool, type RecordsBatch } from '@main/engine/transcript/pool';
import { normalizeRecord } from '@main/engine/normalize';
import { createNormalizerState } from '@main/engine/events';
import { claudePaths } from '@main/engine/paths';
import { FIXTURES } from './_wait';

const S = 'sess-1';
const T0 = Date.parse('2026-01-01T09:00:00Z');

function setup(opts: { metas?: Record<string, AgentMeta>; agentFiles?: string[]; root?: string | null } = {}) {
  let now = T0;
  const tracker = new SubagentTracker({
    projectRootOf: () => (opts.root === undefined ? '/repo' : opts.root),
    now: () => now,
    readMeta: async (p) => opts.metas?.[path.basename(p)] ?? null,
    agentFileExists: async (_root, type) => (opts.agentFiles ?? []).includes(type),
  });
  return {
    tracker,
    at: (ms: number) => {
      now = T0 + ms;
    },
    now: () => now,
  };
}

const ev = {
  start: (toolUseId: string, ts: number, agentId: string | null = null, name = 'Read', label = 'a.ts'): EngineEvent => ({
    type: 'tool-start',
    sessionId: S,
    agentId,
    ts: T0 + ts,
    toolUseId,
    name,
    category: name === 'Agent' ? 'agent' : 'read',
    label,
  }),
  end: (toolUseId: string, ts: number, agentId: string | null = null, extra: Partial<Extract<EngineEvent, { type: 'tool-end' }>> = {}): EngineEvent => ({
    type: 'tool-end',
    sessionId: S,
    agentId,
    ts: T0 + ts,
    toolUseId,
    ok: true,
    ...extra,
  }),
  stop: (reason: string, ts: number, agentId: string | null): EngineEvent => ({ type: 'stop', sessionId: S, agentId, ts: T0 + ts, reason }),
  hint: (toolUseId: string, ts: number, description: string, subagentType = 'Explore', background = false): EngineEvent => ({
    type: 'subagent-hint',
    sessionId: S,
    agentId: null,
    ts: T0 + ts,
    toolUseId,
    description,
    subagentType,
    background,
  }),
};

describe('SubagentTracker', () => {
  it('ana ajan her session\'da main kimliğiyle var ve listede ilk', async () => {
    const { tracker } = setup();
    tracker.apply(ev.start('t1', 0, 'a1'));
    const list = tracker.agents(S);
    expect(list[0]?.id).toBe('main');
    expect(list[0]?.isMain).toBe(true);
    expect(list.map((a) => a.id)).toContain('a1');
  });

  it('meta önceliği: meta > ipucu; inherit model session modelini kullanır; background', async () => {
    const { tracker } = setup({
      metas: { 'agent-a1.meta.json': { description: 'snapshot testleri', agentType: 'Explore', model: 'inherit', requestShape: 'background' } },
    });
    tracker.apply(ev.hint('tu1', 0, 'ipucu açıklaması', 'general-purpose'));
    const ch = await tracker.onFileAdded('/p/agent-a1.jsonl', S, 'a1');
    expect(ch).toEqual([{ kind: 'spawned', sessionId: S, agentId: 'a1', parentAgentId: null }]);
    const rt = tracker.get(S, 'a1');
    expect(rt?.desc).toBe('snapshot testleri');
    expect(rt?.agentType).toBe('Explore');
    expect(rt?.model).toBe('');
    expect(rt?.background).toBe(true);
    const view = tracker.toView(rt!, { sessionModel: 'claude-opus-5-5', sessionStatus: 'busy', costUsd: 0 });
    expect(view.model).toBe('opus 5.5');
    expect(view.name).toBe('snapshot testleri');
  });

  it('meta yoksa ipucundan, ipucu da yoksa kısa id', async () => {
    const a = setup();
    a.tracker.apply(ev.hint('tu1', 0, 'arama yap', 'Explore'));
    await a.tracker.onFileAdded('/p/agent-a1.jsonl', S, 'a1');
    expect(a.tracker.get(S, 'a1')?.desc).toBe('arama yap');
    const b = setup();
    await b.tracker.onFileAdded('/p/agent-abcdef0123.jsonl', S, 'abcdef0123');
    const v = b.tracker.toView(b.tracker.get(S, 'abcdef0123')!, { sessionModel: '', sessionStatus: 'idle', costUsd: 0 });
    expect(v.name).toBe('abcdef01');
  });

  it('paralel ipuçları: meta açıklamasıyla eşleşir, yoksa FIFO', async () => {
    const { tracker } = setup({ metas: { 'agent-b.meta.json': { description: 'ikinci' } } });
    tracker.apply(ev.hint('tu1', 0, 'birinci'));
    tracker.apply(ev.hint('tu2', 1, 'ikinci'));
    tracker.apply(ev.hint('tu3', 2, 'üçüncü'));
    await tracker.onFileAdded('/p/agent-b.jsonl', S, 'b');
    await tracker.onFileAdded('/p/agent-a.jsonl', S, 'a');
    expect(tracker.get(S, 'b')?.hintId).toBe('tu2');
    expect(tracker.get(S, 'a')?.hintId).toBe('tu1');
  });

  it('takım: önek yalnızca proje ajan dosyası varsa', async () => {
    const { tracker } = setup({
      metas: {
        'agent-t.meta.json': { agentType: 'audience-seo-researcher' },
        'agent-g.meta.json': { agentType: 'general-purpose' },
      },
      agentFiles: ['audience-seo-researcher'],
    });
    await tracker.onFileAdded('/p/agent-t.jsonl', S, 't');
    await tracker.onFileAdded('/p/agent-g.jsonl', S, 'g');
    expect(tracker.get(S, 't')?.team).toBe('audience');
    expect(tracker.get(S, 'g')?.team).toBeNull();
  });

  it('takım: proje kökü henüz çözülmediyse refreshPending ile sonradan', async () => {
    let root: string | null = null;
    const tracker = new SubagentTracker({
      projectRootOf: () => root,
      now: () => T0,
      readMeta: async () => ({ agentType: 'pipeline-writer' }),
      agentFileExists: async () => true,
    });
    await tracker.onFileAdded('/p/agent-x.jsonl', S, 'x');
    expect(tracker.get(S, 'x')?.team).toBeNull();
    root = '/repo';
    expect(await tracker.refreshPending()).toBe(true);
    expect(tracker.get(S, 'x')?.team).toBe('pipeline');
  });

  it('ön plan ajanı ana transcript sonucuyla biter', () => {
    const { tracker } = setup();
    tracker.apply(ev.start('tu1', 0, null, 'Agent', 'ara'));
    tracker.apply(ev.hint('tu1', 0, 'ara'));
    tracker.apply(ev.start('x1', 1000, 'a1'));
    const ch = tracker.apply(ev.end('tu1', 5000, null, { linkedAgentId: 'a1', ok: true }));
    expect(ch).toContainEqual({ kind: 'done', sessionId: S, agentId: 'a1', ok: true });
    const rt = tracker.get(S, 'a1')!;
    expect(rt.done).toBe(true);
    expect(rt.pending.size).toBe(0);
    expect(tracker.get(S, 'main')?.pending.size).toBe(0);
  });

  it('hata ile biten subagent errorCount ve done', () => {
    const { tracker } = setup();
    tracker.apply(ev.start('x1', 0, 'a1'));
    const ch = tracker.apply(ev.end('tu1', 1000, null, { linkedAgentId: 'a1', ok: false }));
    expect(ch).toContainEqual({ kind: 'done', sessionId: S, agentId: 'a1', ok: false });
    expect(tracker.get(S, 'a1')?.errorCount).toBe(1);
  });

  it('arka plan ajanı: launch sonucu bitirmez; end_turn + 20 sn sessizlik bitirir', () => {
    const { tracker, at } = setup();
    tracker.apply(ev.hint('tu1', 0, 'izle', 'Explore', true));
    tracker.apply(ev.start('x1', 500, 'bg'));
    tracker.apply(ev.end('tu1', 600, null, { linkedAgentId: 'bg', meta: 'async_launched' }));
    expect(tracker.get(S, 'bg')?.done).toBe(false);
    expect(tracker.get(S, 'bg')?.background).toBe(true);
    tracker.apply(ev.end('x1', 2000, 'bg'));
    tracker.apply(ev.stop('end_turn', 3000, 'bg'));
    at(15_000);
    expect(tracker.hasActiveBackground(S)).toBe(true);
    expect(tracker.tick(() => 'idle')).toEqual([]);
    at(24_000);
    expect(tracker.tick(() => 'idle')).toContainEqual({ kind: 'done', sessionId: S, agentId: 'bg', ok: true });
    // Az önce bitti: 20 sn daha "aktif arka plan" sayılır (kart idle'a düşüp geri dönmesin).
    at(40_000);
    expect(tracker.hasActiveBackground(S)).toBe(true);
    at(50_000);
    expect(tracker.hasActiveBackground(S)).toBe(false);
  });

  it('açılışta saatler önce susmuş arka plan ajanı: bitiş son kaydı, "az önce bitti" sayılmaz', () => {
    const { tracker, at } = setup();
    tracker.apply(ev.hint('tu1', 0, 'izle', 'Explore', true));
    tracker.apply(ev.start('x1', 500, 'bg'));
    tracker.apply(ev.end('tu1', 600, null, { linkedAgentId: 'bg', meta: 'async_launched' }));
    tracker.apply(ev.end('x1', 2000, 'bg'));
    tracker.apply(ev.stop('end_turn', 3000, 'bg'));
    at(2 * 3_600_000); // uygulama iki saat sonra açıldı
    // Bitiş son kaydına (3 sn) çekilir; 15 dk görünürlük çoktan dolduğu için aynı tick'te listeden düşer.
    const changes = tracker.tick(() => 'idle');
    expect(changes).toContainEqual({ kind: 'done', sessionId: S, agentId: 'bg', ok: true });
    expect(changes).toContainEqual({ kind: 'removed', sessionId: S, agentId: 'bg' });
    expect(tracker.hasActiveBackground(S)).toBe(false);
  });

  it('running kuralı: pending varsa; yoksa busy session 15 dk, değilse 3 dk', () => {
    const { tracker, at } = setup();
    tracker.apply(ev.start('x1', 0, 'a1'));
    const rt = tracker.get(S, 'a1')!;
    expect(tracker.isRunning(rt, 'idle')).toBe(true);
    tracker.apply(ev.end('x1', 1000, 'a1'));
    at(4 * 60_000);
    expect(tracker.isRunning(rt, 'idle')).toBe(false);
    expect(tracker.isRunning(rt, 'busy')).toBe(true);
    at(16 * 60_000);
    expect(tracker.isRunning(rt, 'busy')).toBe(false);
  });

  it('döngü şüphesi: son 4 imza aynı', () => {
    const { tracker } = setup();
    for (let i = 0; i < 3; i++) tracker.apply(ev.start(`x${i}`, i, 'a1', 'Read', 'same.ts'));
    expect(tracker.isLoop(tracker.get(S, 'a1')!)).toBe(false);
    tracker.apply(ev.start('x3', 4, 'a1', 'Read', 'same.ts'));
    expect(tracker.isLoop(tracker.get(S, 'a1')!)).toBe(true);
    tracker.apply(ev.start('x4', 5, 'a1', 'Read', 'other.ts'));
    expect(tracker.isLoop(tracker.get(S, 'a1')!)).toBe(false);
  });

  it('bitmiş ajanlar 15 dk sonra budanır', () => {
    const { tracker, at } = setup();
    tracker.apply(ev.start('x1', 0, 'a1'));
    tracker.apply(ev.end('tu', 1000, null, { linkedAgentId: 'a1' }));
    at(10 * 60_000);
    expect(tracker.tick(() => 'idle')).toEqual([]);
    at(16 * 60_000);
    expect(tracker.tick(() => 'idle')).toContainEqual({ kind: 'removed', sessionId: S, agentId: 'a1' });
    expect(tracker.get(S, 'a1')).toBeUndefined();
  });

  it('budanan ajanın ipucu ve araç bağı da silinir (uzun açık kalan uygulamada bellek sınırı)', () => {
    const { tracker, at } = setup();
    tracker.apply(ev.hint('tu', 0, 'iş', 'Explore'));
    tracker.apply(ev.start('x1', 100, 'a1'));
    tracker.apply(ev.end('tu', 1000, null, { linkedAgentId: 'a1' }));
    const internals = tracker as unknown as { hints: Map<string, unknown>; links: Map<string, string> };
    expect(internals.links.size).toBe(1);
    at(16 * 60_000);
    tracker.tick(() => 'idle');
    expect(tracker.get(S, 'a1')).toBeUndefined();
    expect(internals.hints.size).toBe(0);
    expect(internals.links.size).toBe(0);
  });

  it('usage değişikliği ve token sayaçları; rollDay sıfırlar', () => {
    const { tracker } = setup();
    const ch = tracker.apply({
      type: 'usage',
      sessionId: S,
      agentId: 'a1',
      ts: T0,
      msgId: 'm1',
      model: 'claude-haiku-5-5',
      input: 10,
      output: 20,
      cacheRead: 30,
      cacheWrite: 40,
      cacheWrite1h: 0,
      speed: 'standard',
    });
    expect(ch.find((c) => c.kind === 'usage')).toMatchObject({ agentId: 'a1', model: 'claude-haiku-5-5', input: 10 });
    expect(tracker.get(S, 'a1')?.tokens.cacheWrite).toBe(40);
    expect(tracker.get(S, 'a1')?.model).toBe('claude-haiku-5-5');
    tracker.rollDay();
    expect(tracker.get(S, 'a1')?.tokens.input).toBe(0);
  });

  it('SubagentStop ipucu tek başına bitirmez; end_turn ile kesinleşir', () => {
    const { tracker, at } = setup();
    tracker.apply(ev.start('x1', 0, 'a1'));
    tracker.apply(ev.end('x1', 1000, 'a1'));
    expect(tracker.hintStop(S, T0 + 2000)).toEqual([]);
    expect(tracker.get(S, 'a1')?.done).toBe(false);
    const ch = tracker.apply(ev.stop('end_turn', 2500, 'a1'));
    expect(ch).toContainEqual({ kind: 'done', sessionId: S, agentId: 'a1', ok: true });
    at(3000);
  });

  it('dropSession tüm ajanları siler', () => {
    const { tracker } = setup();
    tracker.apply(ev.start('x1', 0, 'a1'));
    tracker.dropSession(S);
    expect(tracker.agents(S)).toEqual([]);
  });

  it('metaPathFor', () => {
    expect(metaPathFor('/x/agent-a1.jsonl')).toBe('/x/agent-a1.meta.json');
  });

  it('entegrasyon: pool + normalizer + tracker fixture zinciri (subagents-team)', async () => {
    const root = path.join(FIXTURES, 'subagents-team', 'claude');
    const pool = new TranscriptPool(claudePaths({ configDir: root }));
    const tracker = new SubagentTracker({
      projectRootOf: () => '/Users/demo/Projects/demo-team',
      now: () => Date.parse('2026-01-01T09:00:00Z'), // manifest now
      agentFileExists: async (_r, t) => ['audience-seo-researcher', 'pipeline-linkedin-writer', 'ventures-skool-planner'].includes(t),
    });
    const state = createNormalizerState();
    const batches: RecordsBatch[] = [];
    pool.on('records', (b: RecordsBatch) => batches.push(b));
    await pool.boot(0, []);
    await pool.stop();
    for (const b of batches) {
      if (b.agentId && !tracker.get(b.sessionId, b.agentId)) await tracker.onFileAdded(b.path, b.sessionId, b.agentId);
      for (const r of b.records) for (const e of normalizeRecord(r, { sessionId: b.sessionId, agentId: b.agentId, state })) tracker.apply(e);
    }
    tracker.tick(() => 'idle'); // arka plan ajanı: end_turn + sessizlik → bitti
    const sid = batches[0]!.sessionId;
    const subs = tracker.agents(sid).filter((a) => !a.isMain);
    expect(subs.map((a) => a.team).sort()).toEqual(['audience', 'pipeline', 'ventures']);
    expect(subs.filter((a) => a.done).length).toBe(1);
    expect(subs.some((a) => a.background)).toBe(true);
  });
});
