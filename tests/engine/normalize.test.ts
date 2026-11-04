import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createNormalizerState, type EngineEvent, type NormalizeCtx } from '@main/engine/events';
import { normalizeRecord } from '@main/engine/normalize';

const FX = path.resolve(__dirname, '../../fixtures/transcripts');
const SID = '11111111-1111-4111-8111-111111111111';

const ctx = (agentId: string | null = null): NormalizeCtx => ({ sessionId: SID, agentId, state: createNormalizerState() });
const types = (evs: EngineEvent[]) => evs.map((e) => e.type);
const of = <T extends EngineEvent['type']>(evs: EngineEvent[], t: T) =>
  evs.filter((e): e is Extract<EngineEvent, { type: T }> => e.type === t);

/** Fixture klasöründeki tek jsonl'i satır satır okur (TranscriptCursor'dan bağımsız). */
function readFixture(name: string): Record<string, unknown>[] {
  const dir = path.join(FX, name);
  const sub = fs.readdirSync(dir).find((d) => d.startsWith('-'))!;
  const file = fs.readdirSync(path.join(dir, sub)).find((f) => f.endsWith('.jsonl'))!;
  return fs
    .readFileSync(path.join(dir, sub, file), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function normalizeAll(records: Record<string, unknown>[], c = ctx()) {
  return records.flatMap((r) => normalizeRecord(r, c));
}

const ts = '2026-01-01T09:00:00.000Z';
const asst = (content: unknown, extra: Record<string, unknown> = {}, msg: Record<string, unknown> = {}) => ({
  type: 'assistant',
  sessionId: SID,
  timestamp: ts,
  uuid: 'u-1',
  message: { id: 'msg_1', model: 'claude-opus-5-5-20260601', content, ...msg },
  ...extra,
});
const user = (content: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'user',
  sessionId: SID,
  timestamp: ts,
  uuid: 'u-2',
  message: { role: 'user', content },
  ...extra,
});

describe('normalizeRecord — kayıt tipleri', () => {
  it('ortak alanlar: sessionId, agentId, ts, uuid', () => {
    const [e] = normalizeRecord(user('merhaba'), ctx());
    expect(e).toMatchObject({ type: 'prompt', sessionId: SID, agentId: null, ts: Date.parse(ts), uuid: 'u-2' });
  });

  it('ai-title ve last-prompt → session-meta (kısaltılmış)', () => {
    const c = ctx();
    expect(normalizeRecord({ type: 'ai-title', aiTitle: 'x'.repeat(200) }, c)[0]).toMatchObject({
      type: 'session-meta',
      title: 'x'.repeat(89) + '…',
    });
    expect(normalizeRecord({ type: 'last-prompt', lastPrompt: 'son prompt' }, c)[0]).toMatchObject({
      type: 'session-meta',
      lastPrompt: 'son prompt',
    });
    expect(normalizeRecord({ type: 'last-prompt', lastPrompt: 'subagent' }, ctx('ag1'))).toEqual([]);
  });

  it('cwd ve gitBranch yalnızca değişince, HEAD yok sayılır, subagent için üretilmez', () => {
    const c = ctx();
    const r = { ...user('a'), cwd: '/p', gitBranch: 'main' };
    expect(of(normalizeRecord(r, c), 'session-meta')).toEqual([expect.objectContaining({ cwd: '/p', branch: 'main' })]);
    expect(of(normalizeRecord(r, c), 'session-meta')).toEqual([]);
    expect(of(normalizeRecord({ ...r, gitBranch: 'HEAD' }, c), 'session-meta')).toEqual([]);
    expect(of(normalizeRecord({ ...r, gitBranch: 'dev' }, c), 'session-meta')).toEqual([
      expect.objectContaining({ branch: 'dev' }),
    ]);
    expect(of(normalizeRecord({ ...r, cwd: '/q' }, ctx('ag1')), 'session-meta')).toEqual([]);
  });

  it('assistant: model meta bir kez, usage bir kez (aynı message.id), stop, tool-start, text, thinking', () => {
    const c = ctx();
    const usage = { input_tokens: 3, output_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 11,
      cache_creation: { ephemeral_1h_input_tokens: 4 } };
    const first = normalizeRecord(asst([{ type: 'thinking', thinking: 'x' }], {}, { usage }), c);
    expect(types(first)).toEqual(['session-meta', 'usage', 'thinking']);
    expect(of(first, 'usage')[0]).toMatchObject({ msgId: 'msg_1', model: 'claude-opus-5-5-20260601', input: 3, output: 5,
      cacheRead: 7, cacheWrite: 11, cacheWrite1h: 4, speed: 'standard' });
    const second = normalizeRecord(
      asst([{ type: 'text', text: '  Tamam  ' }, { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/p/src/a.ts' } }], {}, { usage, stop_reason: 'tool_use' }),
      c,
    );
    expect(types(second)).toEqual(['stop', 'assistant-text', 'tool-start']);
    expect(of(second, 'tool-start')[0]).toMatchObject({ toolUseId: 't1', name: 'Edit', category: 'edit', label: 'src/a.ts', file: '/p/src/a.ts' });
    expect(of(second, 'assistant-text')[0]!.text).toBe('Tamam');
  });

  it('usage.speed fast ve effort alanı', () => {
    const c = ctx();
    const evs = normalizeRecord(asst([], { effort: 'high' }, { usage: { input_tokens: 1, output_tokens: 1, speed: 'fast' } }), c);
    expect(of(evs, 'usage')[0]!.speed).toBe('fast');
    expect(of(evs, 'session-meta').some((e) => e.effort === 'high')).toBe(true);
  });

  it('Agent / Task → tool-start + subagent-hint', () => {
    const evs = normalizeRecord(
      asst([{ type: 'tool_use', id: 'ta', name: 'Agent', input: { description: 'Testleri bul', subagent_type: 'Explore', run_in_background: true } }]),
      ctx(),
    );
    expect(of(evs, 'subagent-hint')[0]).toMatchObject({ toolUseId: 'ta', description: 'Testleri bul', subagentType: 'Explore', background: true });
    expect(of(evs, 'tool-start')[0]!.category).toBe('agent');
  });

  it('API hatası: isApiErrorMessage ve <synthetic> model → yalnızca api-error', () => {
    expect(normalizeRecord(asst([{ type: 'text', text: 'Request timed out' }], { isApiErrorMessage: true }), ctx())).toEqual([
      expect.objectContaining({ type: 'api-error', message: 'Request timed out' }),
    ]);
    const s = normalizeRecord(asst([], {}, { model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } }), ctx());
    expect(s).toEqual([expect.objectContaining({ type: 'api-error', message: 'API hatası' })]);
  });

  it('user: tool_result → tool-end; is_error → ok:false; prompt üretmez', () => {
    const evs = normalizeRecord(user([{ type: 'tool_result', tool_use_id: 't1', content: 'x', is_error: true }]), ctx());
    expect(evs).toEqual([expect.objectContaining({ type: 'tool-end', toolUseId: 't1', ok: false })]);
  });

  it('tool-end meta: WebFetch, WebSearch, Agent, interrupted', () => {
    const tr = (toolUseResult: unknown) =>
      of(normalizeRecord({ ...user([{ type: 'tool_result', tool_use_id: 't' }]), toolUseResult }, ctx()), 'tool-end')[0];
    expect(tr({ url: 'https://a.dev/x', code: 200, bytes: 41984 })).toMatchObject({ meta: '200 · 41 KB' });
    expect(
      tr({ query: 'q', results: [{ content: [{ url: 'https://a.dev/1' }, { url: 'https://a.dev/2' }, { url: 'https://b.dev' }] }, { content: [{ url: 'https://c.dev' }, { url: 'https://d.dev' }, { url: 'https://e.dev' }] }, 'metin'] }),
    ).toMatchObject({ meta: '6 sonuç', hosts: ['a.dev', 'b.dev', 'c.dev', 'd.dev'] });
    expect(tr({ agentId: 'abc', status: 'completed', description: 'Bul', resolvedModel: 'claude-haiku-5-5' })).toMatchObject({
      linkedAgentId: 'abc', meta: 'completed', agentDescription: 'Bul', resolvedModel: 'claude-haiku-5-5',
    });
    expect(tr({ interrupted: true })).toMatchObject({ interrupted: true, meta: 'interrupted' });
    expect(tr({ stdout: 'x', interrupted: false })).not.toHaveProperty('meta');
    expect(tr('düz metin')).not.toHaveProperty('meta');
  });

  it.each([
    ['normal prompt', 'Hatayı düzelt', { type: 'prompt', variant: 'user', text: 'Hatayı düzelt' }],
    ['kesme', '[Request interrupted by user]', { type: 'interrupted' }],
    ['task bildirimi', '<task-notification><x/></task-notification>', { type: 'prompt', variant: 'task-notification', text: 'arka plan görevi sonuç bildirdi' }],
    ['slash komutu', '<command-name>/compact</command-name><command-args></command-args>', { type: 'prompt', variant: 'command', text: '/compact' }],
  ])('prompt varyantı: %s', (_n, text, expected) => {
    expect(normalizeRecord(user(text), ctx())).toEqual([expect.objectContaining(expected)]);
  });

  it('prompt üretmeyenler: isMeta, komut adı olmayan etiket, Caveat, boş metin, subagent', () => {
    expect(normalizeRecord(user('Bir şey', { isMeta: true }), ctx())).toEqual([]);
    expect(normalizeRecord(user('<system-reminder>x</system-reminder>'), ctx())).toEqual([]);
    expect(normalizeRecord(user('Caveat: local commands'), ctx())).toEqual([]);
    expect(normalizeRecord(user('   '), ctx())).toEqual([]);
    expect(normalizeRecord(user('subagent prompt'), ctx('ag1'))).toEqual([]);
  });

  it('dizi içeriğinde text blokları birleşir, görsel yok sayılır', () => {
    const evs = normalizeRecord(user([{ type: 'text', text: 'Brief' }, { type: 'image', source: {} }, { type: 'text', text: 'cache' }]), ctx());
    expect(evs).toEqual([expect.objectContaining({ type: 'prompt', text: 'Brief cache' })]);
  });

  it('system: turn_duration, compact_boundary, api_error, level=error', () => {
    const sys = (r: Record<string, unknown>) => normalizeRecord({ type: 'system', timestamp: ts, ...r }, ctx());
    expect(sys({ subtype: 'turn_duration', durationMs: 4800 })).toEqual([expect.objectContaining({ type: 'turn-duration', durationMs: 4800 })]);
    expect(sys({ subtype: 'compact_boundary' })).toEqual([expect.objectContaining({ type: 'compact' })]);
    expect(sys({ subtype: 'api_error', content: 'API Error: 500' })).toEqual([expect.objectContaining({ type: 'api-error', message: 'API Error: 500' })]);
    expect(sys({ level: 'error' })).toEqual([expect.objectContaining({ type: 'api-error' })]);
    expect(sys({ subtype: 'informational' })).toEqual([]);
  });

  it('bilinmeyen tip → [] ve sayaç', () => {
    const c = ctx();
    expect(normalizeRecord({ type: 'summary', cwd: '/x' }, c)).toEqual([]);
    expect(normalizeRecord({ type: 'summary' }, c)).toEqual([]);
    expect(normalizeRecord({}, c)).toEqual([]);
    expect(c.state.unknownTypes).toEqual({ summary: 2, '(tipsiz)': 1 });
  });

  it('gerçek formatta görülen kullanılmayan tipler sessizce yok sayılır (unknownTypes şişmez)', () => {
    const c = ctx();
    for (const type of ['atis-latch', 'frame-link', 'mode', 'tools-used', 'cost-state', 'fork-context-ref']) {
      expect(normalizeRecord({ type, sessionId: 's', cwd: '/x' }, c)).toEqual([]);
    }
    expect(normalizeRecord({ type: 'system', subtype: 'stop_hook_summary' }, c)).toEqual([]);
    expect(normalizeRecord({ type: 'system', subtype: 'upgrade_relay_marker' }, c)).toEqual([]);
    expect(c.state.unknownTypes).toEqual({});
  });

  it('timestamp yoksa ts = 0', () => {
    const [e] = normalizeRecord({ type: 'user', message: { content: 'x' } }, ctx());
    expect(e!.ts).toBe(0);
  });

  it('ana dosyada isSidechain + agentId → subagent olayı', () => {
    const [e] = normalizeRecord(asst([{ type: 'tool_use', id: 'g', name: 'Glob', input: { pattern: '*.ts' } }], { isSidechain: true, agentId: 'ag9', cwd: '/x' }), ctx());
    expect(e).toMatchObject({ type: 'tool-start', agentId: 'ag9' });
  });
});

describe('fixture → olay dizisi (snapshot)', () => {
  it.each(['basic', 'edge', 'secrets'])('%s', (name) => {
    const c = ctx();
    const evs = normalizeAll(readFixture(name), c);
    expect({ events: evs, unknownTypes: c.state.unknownTypes }).toMatchSnapshot();
  });

  it('basic: beklenen önemli olaylar', () => {
    const evs = normalizeAll(readFixture('basic'));
    expect(of(evs, 'usage').map((u) => u.msgId)).toEqual(['msg_b01', 'msg_b02', 'msg_b03', 'msg_b04', 'msg_b05', 'msg_b06', 'msg_b07', 'msg_b08']);
    expect(of(evs, 'tool-start').map((t) => `${t.name}:${t.label}`)).toEqual([
      'Read:editor/ThemePreview.tsx',
      'Grep:"ThemePreview" src/',
      'Edit:editor/ThemePreview.tsx',
      'Bash:npm test -- editor …',
      'WebSearch:"vitest snapshot react 19"',
      'WebFetch:vitest.dev/guide/snapshot',
      'Agent:Snapshot testlerini bul',
    ]);
    expect(of(evs, 'tool-end').every((e) => e.ok)).toBe(true);
    expect(of(evs, 'tool-end').find((e) => e.toolUseId === 'toolu_b07')).toMatchObject({ linkedAgentId: 'a1b2c3d4e5f60718' });
    expect(of(evs, 'turn-duration')[0]!.durationMs).toBe(48211);
    expect(of(evs, 'stop').at(-1)!.reason).toBe('end_turn');
  });

  it('edge: usage tekrarı sayılmıyor, kesme/komut/görev bildirimi var', () => {
    const c = ctx();
    const evs = normalizeAll(readFixture('edge'), c);
    expect(of(evs, 'usage').filter((u) => u.msgId === 'msg_e01')).toHaveLength(1);
    expect(types(evs)).toEqual(expect.arrayContaining(['interrupted', 'compact', 'api-error']));
    expect(of(evs, 'prompt').map((p) => p.variant)).toEqual(['command', 'user', 'task-notification']);
    expect(of(evs, 'api-error')).toHaveLength(3);
    expect(c.state.unknownTypes).toEqual({ summary: 1, 'some-future-type': 1 });
    expect(of(evs, 'session-meta').some((m) => m.branch === 'HEAD')).toBe(false);
  });
});

describe('güvenlik', () => {
  it('hiçbir fixture olayında sır kalmıyor', () => {
    for (const name of ['basic', 'edge', 'secrets']) {
      const json = JSON.stringify(normalizeAll(readFixture(name)));
      for (const needle of ['sk-ant-', 'ghp_', 'github_pat_', 'AKIA', 'xoxb-', 'eyJ', 'FAKE']) {
        expect(json, `${name}: ${needle}`).not.toContain(needle);
      }
    }
  });

  it('olaylarda ham araç çıktısı ve tam prompt yok', () => {
    const json = JSON.stringify(normalizeAll(readFixture('basic')));
    expect(json).not.toContain('import React');
    expect(json).not.toContain('Tests: 12 passed');
  });
});

describe('performans', () => {
  it('200 bin kayıt < 1.5 sn', () => {
    const recs: Record<string, unknown>[] = [];
    for (let i = 0; i < 100_000; i++) {
      recs.push({
        type: 'assistant', sessionId: SID, uuid: `a${i}`, timestamp: ts, cwd: '/p', gitBranch: 'main',
        message: { id: `m${i}`, model: 'claude-opus-5-5-20260601', stop_reason: 'tool_use',
          usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
          content: [{ type: 'tool_use', id: `t${i}`, name: i % 2 ? 'Bash' : 'Edit', input: i % 2 ? { command: `npm test -- ${i}` } : { file_path: `/p/src/f${i}.ts` } }] },
      });
      recs.push({ type: 'user', sessionId: SID, uuid: `u${i}`, timestamp: ts, cwd: '/p', gitBranch: 'main',
        message: { content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'ok' }] }, toolUseResult: { stdout: 'ok' } });
    }
    const c = ctx();
    const t = performance.now();
    let n = 0;
    for (const r of recs) n += normalizeRecord(r, c).length;
    const ms = performance.now() - t;
    console.log(`[perf] normalizeRecord: ${recs.length} kayıt → ${n} olay, ${ms.toFixed(0)} ms (${((ms * 1000) / recs.length).toFixed(1)} µs/kayıt)`);
    expect(ms).toBeLessThan(1500);
  });
});
