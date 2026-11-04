// planEffects (03/06): olay → efekt komutu eşlemesi, gecikmeler, eksik konum, reduced motion.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CATEGORY_COLOR, STATUS_COLOR } from '@shared/constants';
import type { AgentView, BoardEvent, ToolCall, ToolCategory } from '@shared/types';
import {
  BATCH_GAP_MS,
  DUR,
  planEffects,
  SEARCH_GAP_MS,
  SPAWN_COLOR,
  type EffectCommand,
  type PlanContext,
} from '@renderer/map3d/effects';
import type { SceneAnchors } from '@renderer/map3d/scene';

const S = 'sess-1';
const P = 'proj-1';
const V = (x: number, y = 0, z = 0) => new THREE.Vector3(x, y, z);

const AGENT_MAIN = V(0, 5, 0);
const AGENT_SUB = V(1, 5, 0);
const HALO = V(0, 14, 0);
const SHELL = V(5, 0.3, 3);
const BACK = V(0, 0.6, -3);
const FILES: Record<string, THREE.Vector3> = { '/a.ts': V(-2, 0.6, -3), '/b.ts': V(-1, 0.6, -3) };

function ctx(over: Partial<PlanContext> = {}, anchors: Partial<SceneAnchors> = {}): PlanContext {
  return {
    anchors: {
      agentPos: (sid, aid) => (sid !== S ? null : aid === null ? AGENT_MAIN : aid === 'sub' ? AGENT_SUB : null),
      filePos: (pid, path) => (pid !== P ? null : (FILES[path] ?? BACK)),
      shellPos: (pid) => (pid === P ? SHELL : null),
      haloPos: () => HALO,
      webCenter: () => V(0, 12.2, -0.6),
      sessionTop: () => V(0, 6, 0),
      sessionBase: () => V(0, 0.3, 0),
      projectCenter: () => V(0, 0, 0),
      ...anchors,
    },
    hotFiles: () => ['/a.ts', '/b.ts', '/c.ts'],
    projectOfSession: (sid) => (sid === S ? P : null),
    mainAgentId: 'main',
    reducedMotion: false,
    ...over,
  };
}

const call = (category: ToolCategory, o: Partial<ToolCall> = {}): ToolCall => ({
  id: 'toolu_1',
  sessionId: S,
  agentId: null,
  name: 'X',
  category,
  label: 'x',
  startedAt: 1,
  ...o,
});
const start = (category: ToolCategory, o: Partial<ToolCall> = {}): BoardEvent => ({
  type: 'tool-start',
  call: call(category, o),
});
const end = (category: ToolCategory, o: Partial<ToolCall> = {}): BoardEvent => ({
  type: 'tool-end',
  call: call(category, o),
});
const kinds = (cs: EffectCommand[]) => cs.map((c) => c.kind);
const particles = (cs: EffectCommand[]) =>
  cs.filter((c): c is Extract<EffectCommand, { kind: 'particle' }> => c.kind === 'particle');

describe('planEffects', () => {
  it('edit: ajandan dosyaya parçacık, varışta ısı + etiket', () => {
    const cs = planEffects([start('edit', { file: '/a.ts' })], ctx());
    expect(kinds(cs)).toEqual(['particle']);
    const p = particles(cs)[0]!;
    expect(p.from).toBe(AGENT_MAIN);
    expect(p.to).toBe(FILES['/a.ts']);
    expect(p.color).toBe(CATEGORY_COLOR.edit);
    expect(p.durationMs).toBe(DUR.edit);
    expect(kinds(p.onArrive!)).toEqual(['heatFile', 'flashLabel']);
  });

  it('read: ısı + etiket hemen, dosyadan ajana parçacık', () => {
    const cs = planEffects([start('read', { file: '/b.ts', agentId: 'sub' })], ctx());
    expect(kinds(cs)).toEqual(['heatFile', 'flashLabel', 'particle']);
    const p = particles(cs)[0]!;
    expect(p.from).toBe(FILES['/b.ts']);
    expect(p.to).toBe(AGENT_SUB);
    expect(p.durationMs).toBe(DUR.read);
  });

  it('search: en sıcak 2 dosyadan 220 ms arayla; dosya yoksa platform arka merkezinden', () => {
    const cs = particles(planEffects([start('search')], ctx()));
    expect(cs.map((c) => c.from)).toEqual([FILES['/a.ts'], FILES['/b.ts']]);
    expect(cs.map((c) => c.delayMs)).toEqual([0, SEARCH_GAP_MS]);
    const none = particles(planEffects([start('search')], ctx({ hotFiles: () => [] })));
    expect(none).toHaveLength(1);
    expect(none[0]!.from).toBe(BACK);
  });

  it("bash: shell pad'e parçacık + shellActive; bitince shellActive(off)", () => {
    const cs = planEffects([start('bash')], ctx());
    expect(kinds(cs)).toEqual(['particle', 'shellActive']);
    expect(particles(cs)[0]!.to).toBe(SHELL);
    expect(cs[1]).toMatchObject({ projectId: P, on: true });
    expect(planEffects([end('bash')], ctx())).toEqual([{ kind: 'shellActive', projectId: P, on: false, delayMs: 0 }]);
  });

  it('web: halkaya parçacık + varışta halo ısısı; bitince halkadan geri döner', () => {
    const p = particles(planEffects([start('web')], ctx()))[0]!;
    expect(p.to).toBe(HALO);
    expect(p.durationMs).toBe(DUR.web);
    expect(kinds(p.onArrive!)).toEqual(['haloHeat']);
    const back = particles(planEffects([end('web')], ctx()))[0]!;
    expect(back.from).toBe(HALO);
    expect(back.to).toBe(AGENT_MAIN);
    expect(back.durationMs).toBe(DUR.webBack);
  });

  it('browser/mcp kendi renginde halkaya; agent ve plan efekt üretmez', () => {
    expect(particles(planEffects([start('mcp')], ctx()))[0]!.color).toBe(CATEGORY_COLOR.mcp);
    expect(particles(planEffects([start('browser')], ctx()))[0]!.durationMs).toBe(DUR.halo);
    expect(planEffects([start('agent'), start('plan')], ctx())).toEqual([]);
  });

  it('agent-spawn: ana ajandan yeni küreye beyaz parçacık + büyüme; küre yoksa yalnızca büyüme', () => {
    const agent = { id: 'sub' } as AgentView;
    const cs = planEffects([{ type: 'agent-spawn', sessionId: S, agent, parentAgentId: null }], ctx());
    expect(kinds(cs)).toEqual(['particle', 'growAgent']);
    expect(particles(cs)[0]).toMatchObject({
      from: AGENT_MAIN,
      to: AGENT_SUB,
      color: SPAWN_COLOR,
      durationMs: DUR.spawn,
    });
    const fresh = planEffects(
      [{ type: 'agent-spawn', sessionId: S, agent: { id: 'yeni' } as AgentView, parentAgentId: null }],
      ctx(),
    );
    expect(kinds(fresh)).toEqual(['growAgent']);
  });

  it('durum geçişleri: bekleme → şok halkası; busy→idle ve prompt → uç parıltısı', () => {
    const cs = planEffects(
      [
        { type: 'status', sessionId: S, from: 'busy', to: 'waiting', at: 1 },
        { type: 'status', sessionId: S, from: 'busy', to: 'idle', at: 1 },
        { type: 'status', sessionId: S, from: 'waiting', to: 'busy', at: 1 },
        { type: 'prompt', sessionId: S, label: 'x', at: 1 },
        { type: 'agent-done', sessionId: S, agentId: 'sub' },
      ],
      ctx(),
    );
    expect(cs).toEqual([
      { kind: 'shockRing', sessionId: S, color: STATUS_COLOR.waiting, delayMs: 0 },
      { kind: 'tipBlink', sessionId: S, color: STATUS_COLOR.idle, delayMs: BATCH_GAP_MS },
      { kind: 'tipBlink', sessionId: S, color: '#E4E8EF', delayMs: 3 * BATCH_GAP_MS },
      { kind: 'dimAgent', sessionId: S, agentId: 'sub', delayMs: 4 * BATCH_GAP_MS },
    ]);
  });

  it('file-touch ısı (parçacık yok), conflict yanıp sönme', () => {
    const cs = planEffects(
      [
        { type: 'file-touch', projectId: P, path: '/a.ts', sessionId: S, agentId: null, write: true, at: 1 },
        { type: 'conflict', conflict: { path: '/a.ts', projectId: P, sessionIds: [S, 'x'], lastTs: 1 } },
      ],
      ctx(),
    );
    expect(cs).toEqual([
      { kind: 'heatFile', projectId: P, path: '/a.ts', color: CATEGORY_COLOR.edit, delayMs: 0 },
      { kind: 'conflictFlash', projectId: P, path: '/a.ts', delayMs: BATCH_GAP_MS },
    ]);
  });

  it('batch gecikmeleri: olay sırası × 40 ms, olay içi göreli gecikme korunur', () => {
    const cs = planEffects([start('bash'), start('read', { file: '/a.ts' }), start('search')], ctx());
    const ps = particles(cs);
    expect(ps.map((p) => p.delayMs)).toEqual([0, 40, 80, 80 + SEARCH_GAP_MS]);
  });

  it('konum yoksa parçacık atlanır, hata yok', () => {
    expect(planEffects([start('edit', { sessionId: 'yok', file: '/a.ts' })], ctx())).toEqual([]);
    const noAgent = ctx({}, { agentPos: () => null });
    expect(particles(planEffects([start('bash'), start('web'), start('read', { file: '/a.ts' })], noAgent))).toEqual(
      [],
    );
    // edit varış komutları yine de (hemen) çalışır
    expect(kinds(planEffects([start('edit', { file: '/a.ts' })], noAgent))).toEqual(['heatFile', 'flashLabel']);
  });

  it('subagent henüz haritada yoksa ana ajanın konumu kullanılır', () => {
    const p = particles(planEffects([start('bash', { agentId: 'henuz-yok' })], ctx()))[0]!;
    expect(p.from).toBe(AGENT_MAIN);
  });

  it('reduced motion: parçacık, halka, parıltı ve büyüme yok; yalnızca renk ve etiket', () => {
    const r = ctx({ reducedMotion: true });
    const cs = planEffects(
      [
        start('edit', { file: '/a.ts' }),
        start('bash'),
        start('web'),
        { type: 'status', sessionId: S, from: 'busy', to: 'waiting', at: 1 },
        { type: 'agent-spawn', sessionId: S, agent: { id: 'sub' } as AgentView, parentAgentId: null },
        { type: 'agent-done', sessionId: S, agentId: 'sub' },
        { type: 'conflict', conflict: { path: '/a.ts', projectId: P, sessionIds: [S], lastTs: 1 } },
      ],
      r,
    );
    expect(kinds(cs)).toEqual(['heatFile', 'flashLabel', 'dimAgent', 'conflictFlash']);
    expect(cs[0]!.delayMs).toBe(0);
    expect(cs.some((c) => c.kind === 'particle')).toBe(false);
  });
});
