// LiveEffects (03/06, 03/08): kuyruk, sürekli efektler, robot doğuşu/kapanışı, web küresi, reduced motion, dispose.
// Gerçek ProjectNode düğümleri sahte ortamla kurulur; WebGL gerekmez.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CATEGORY_COLOR, SLOW_COLOR } from '@shared/constants';
import type { AgentView, BoardEvent, BoardSnapshot, ToolCall } from '@shared/types';
import { LiveEffects, waitRingAt, type EffectsHost } from '@renderer/map3d/effects';
import { ProjectNode } from '@renderer/map3d/platform';
import { WebGlobe } from '@renderer/map3d/web';
import { DEMAND_ACTIVE, DEMAND_AMBIENT, DEMAND_NONE } from '@renderer/map3d/renderLoop';
import { IDS, makeSnapshot } from '../__fixtures__/snapshot';
import { fakeEnv } from './_env';

const NOW = 1_800_000_000_000;
const FILE = '/Users/demo/Projects/demo-app/src/api/orders.ts';

function makeHost(opts: { reduced?: boolean; hidden?: boolean } = {}) {
  const env = fakeEnv({ reducedMotion: opts.reduced ?? false, now: () => NOW });
  const scene = new THREE.Scene();
  let snap: BoardSnapshot = makeSnapshot(NOW);
  snap.projects[0]!.hotFiles = [{ path: FILE, projectId: 'p1demoapp', reads: 3, writes: 2, lastTs: NOW, editors: [] }];
  const projects = new Map<string, ProjectNode>();
  const frames = new Set<(t: number, dt: number) => void>();
  const updates = new Set<(s: BoardSnapshot) => void>();
  const restores = new Set<() => void>();
  let debug: (() => string) | null = null;
  const web = new WebGlobe(env, () => {});
  scene.add(web.group);

  const sync = (s: BoardSnapshot) => {
    snap = s;
    const byId = new Map(s.sessions.map((x) => [x.id, x]));
    s.projects.forEach((p, i) => {
      let n = projects.get(p.id);
      if (!n) {
        n = new ProjectNode(p.id, env);
        projects.set(p.id, n);
        scene.add(n.group);
      }
      n.place(i * 14, 0, 0);
      n.sync(p, byId, 0, NOW);
    });
    for (const cb of updates) cb(s);
  };
  const sessionNode = (sid: string) => {
    for (const p of projects.values()) {
      const s = p.sessions.get(sid);
      if (s) return s;
    }
    return null;
  };
  sync(snap);

  const clock = { t: 1000 };
  const host: EffectsHost = {
    scene,
    reducedMotion: opts.reduced ?? false,
    glow: env.glow,
    get lastSnapshot() {
      return snap;
    },
    anchors: {
      agentPos: (sid, aid) => sessionNode(sid)?.worldPos(aid) ?? null,
      filePos: (pid, path) => projects.get(pid)?.fileWorld(path) ?? null,
      shellPos: (pid) => projects.get(pid)?.shellWorld() ?? null,
      haloPos: () => web.surfaceTarget(),
      webCenter: () => web.center(),
      sessionTop: (sid) => sessionNode(sid)?.topWorld() ?? null,
      sessionBase: (sid) => sessionNode(sid)?.baseWorld() ?? null,
      projectCenter: (pid) => projects.get(pid)?.centerWorld() ?? null,
    },
    onFrame: (cb) => (frames.add(cb), () => void frames.delete(cb)),
    onUpdate: (cb) => (updates.add(cb), () => void updates.delete(cb)),
    onRestore: (cb) => (restores.add(cb), () => void restores.delete(cb)),
    projectNode: (id) => projects.get(id),
    projectNodes: () => projects.values(),
    sessionNodeById: sessionNode,
    webGlobe: () => web,
    projectOfSession: (sid) => snap.sessions.find((s) => s.id === sid)?.projectId ?? null,
    setDebugInfo: (fn) => {
      debug = fn;
    },
  };
  const fx = new LiveEffects(host, { now: () => clock.t, wallNow: () => NOW, isHidden: () => opts.hidden ?? false });
  const tick = (ms: number) => {
    clock.t += ms;
    for (const cb of frames) cb(clock.t, ms / 1000);
  };
  return {
    fx,
    host,
    scene,
    projects,
    sync,
    snap: () => snap,
    tick,
    clock,
    web,
    frames,
    debug: () => debug,
    sessionNode,
  };
}

const call = (o: Partial<ToolCall>): ToolCall => ({
  id: 'toolu_x',
  sessionId: IDS.busy,
  agentId: null,
  name: 'Edit',
  category: 'edit',
  label: 'x',
  startedAt: NOW,
  ...o,
});

describe('LiveEffects', () => {
  it('düzenleme: parçacık uçar, varışta dosya ısınır ve söner', () => {
    const h = makeHost();
    h.fx.handle([{ type: 'tool-start', call: call({ file: FILE }) }]);
    h.tick(16);
    expect(h.fx.pool.liveCount).toBe(1);
    const node = h.projects.get('p1demoapp')!.files.nodes.get(FILE)!;
    expect(node.heat).toBe(0);
    for (let i = 0; i < 60; i++) h.tick(16); // ~960 ms > 900
    expect(node.heat).toBeGreaterThan(0.9);
    expect(node.mesh.material.emissive.getHexString()).toBe(CATEGORY_COLOR.edit.slice(1).toLowerCase());
    expect(node.mesh.material.emissiveIntensity).toBeGreaterThan(1);
    for (let i = 0; i < 120; i++) h.tick(16);
    expect(node.heat).toBe(0);
    expect(node.mesh.material.emissiveIntensity).toBe(0);
  });

  it("batch içindeki komutlar 40 ms arayla; 2 sn'den eski komutlar atılır", () => {
    const h = makeHost();
    const ev: BoardEvent[] = [0, 1, 2].map((i) => ({
      type: 'tool-start',
      call: call({ id: `t${i}`, category: 'bash', name: 'Bash' }),
    }));
    h.fx.handle(ev);
    h.tick(1);
    expect(h.fx.pool.liveCount).toBe(1);
    h.tick(40);
    expect(h.fx.pool.liveCount).toBe(2);
    h.tick(40);
    expect(h.fx.pool.liveCount).toBe(3);

    const h2 = makeHost();
    h2.fx.handle(ev);
    h2.clock.t += 5000; // pencere uzun süre çizilmedi
    h2.tick(16);
    expect(h2.fx.pool.liveCount).toBe(0);
    expect(h2.fx.queueLength).toBe(0);
  });

  it('pencere gizliyken olaylar kuyruğa alınmaz', () => {
    const h = makeHost({ hidden: true });
    h.fx.handle([{ type: 'tool-start', call: call({ file: FILE }) }]);
    expect(h.fx.queueLength).toBe(0);
  });

  it("shell pad: bash başlayınca hemen nabız; snapshot'ta yavaş bash varsa kırmızı", () => {
    const h = makeHost();
    const pad = h.projects.get('p1demoapp')!.shell.material;
    h.tick(16);
    expect(pad.emissiveIntensity).toBe(0);
    h.fx.handle([{ type: 'tool-start', call: call({ category: 'bash', name: 'Bash' }) }]);
    h.tick(16);
    expect(pad.emissiveIntensity).toBeGreaterThan(0.25);
    h.fx.handle([{ type: 'tool-end', call: call({ category: 'bash', name: 'Bash', endedAt: NOW }) }]);
    h.tick(16);
    expect(pad.emissiveIntensity).toBe(0);
    // agent-lab'da a2'nin bash'i 200 sn'dir sürüyor (> 3 dk)
    const team = h.projects.get('p2agents')!.shell.material;
    expect(team.emissiveIntensity).toBeGreaterThan(0.25);
    expect(team.emissive.getHexString()).toBe(SLOW_COLOR.slice(1).toLowerCase());
  });

  it("web küresi: snapshot'ta çalışan web aracı varsa taban ısı; varışta tam ısınır ve yüzeyde dalga", () => {
    const h = makeHost();
    h.tick(16);
    const u = h.web.uniforms;
    expect(u.uHeat.value).toBeCloseTo(0.6, 2);
    expect(h.web.rimUniforms.uHeat.value).toBeCloseTo(0.6, 2);
    expect(h.web.pings).toHaveLength(0);
    h.fx.exec({ kind: 'haloHeat', delayMs: 0 }, h.clock.t);
    h.tick(16);
    expect(u.uHeat.value).toBeGreaterThan(0.95);
    expect(h.web.pings).toHaveLength(1);
    // Web aracı yokken ısı söner.
    const r = makeHost();
    r.sync(quiet(r.snap()));
    r.fx.exec({ kind: 'haloHeat', delayMs: 0 }, r.clock.t);
    for (let i = 0; i < 120; i++) r.tick(16);
    expect(r.web.uniforms.uHeat.value).toBe(0);
    expect(r.web.atmo.material.opacity).toBeCloseTo(0.08, 3);
  });

  it("bekleme: lider pedindeki amber halka genişleyip söner; reduced motion'da statik", () => {
    const h = makeHost();
    const s = h.sessionNode(IDS.waiting)!;
    h.clock.t = 1600 * 10 + 800; // döngünün ortası
    h.tick(0);
    expect(s.waitRing.scale.x).toBeCloseTo(1.4, 1);
    expect(s.waitRing.material.opacity).toBeCloseTo(0.425, 2);
    expect(h.sessionNode(IDS.busy)!.waitRing.visible).toBe(false);

    const r = makeHost({ reduced: true });
    r.tick(16);
    const rs = r.sessionNode(IDS.waiting)!;
    expect(rs.waitRing.scale.x).toBe(1.1);
    expect(rs.waitRing.material.opacity).toBe(0.7);
    expect(waitRingAt(123, true)).toEqual({ scale: 1.1, opacity: 0.7 });
  });

  it("şok halkası tek seferlik: 900 ms'de büyüyüp kaybolur", () => {
    const h = makeHost();
    h.fx.handle([{ type: 'status', sessionId: IDS.busy, from: 'busy', to: 'waiting', at: NOW }]);
    h.tick(16);
    const shock = () =>
      h.scene.getObjectByName('fx')!.children.find((o) => (o as THREE.Mesh).isMesh && o.visible) as
        THREE.Mesh | undefined;
    expect(shock()).toBeTruthy();
    h.tick(450);
    expect(shock()!.scale.x).toBeGreaterThan(1.5);
    h.tick(500);
    expect(shock()).toBeUndefined();
  });

  it("ajan doğuşu: olay snapshot'tan önce gelir; robot liderin pedinden yürür ve liderden parçacık atılır", () => {
    const h = makeHost();
    h.fx.handle([{ type: 'agent-spawn', sessionId: IDS.busy, agent: { id: 'nw' } as AgentView, parentAgentId: null }]);
    h.tick(16);
    expect(h.fx.pool.liveCount).toBe(0); // robot henüz yok
    expect(h.fx.demand()).toBe(DEMAND_AMBIENT); // bekleyen doğuş
    const s = structuredClone(h.snap());
    const sess = s.sessions.find((x) => x.id === IDS.busy)!;
    sess.agents.push({ ...sess.agents[0]!, id: 'nw', isMain: false, name: 'nw', current: null });
    h.sync(s);
    h.tick(16);
    const robot = h.sessionNode(IDS.busy)!.robots.get('nw')!;
    expect(robot.walking).toBe(true); // var olan ekibe katılan robot liderin pedinden yürür
    expect(h.fx.pool.liveCount).toBe(1);
  });

  it("ajan bitti: robot hemen kapanır (gözler söner); reduced motion'da da", () => {
    for (const reduced of [false, true]) {
      const h = makeHost({ reduced });
      const a1 = h.sessionNode(IDS.team)!.robots.get('a1')!;
      expect(a1.state).toBe('work');
      h.fx.handle([{ type: 'agent-done', sessionId: IDS.team, agentId: 'a1' }]);
      h.tick(16);
      expect(a1.state).toBe('off');
      expect(a1.eyeMat.color.getHexString()).toBe('2a3240');
    }
  });

  it('reduced motion: parçacık yok, ısı ve etiket var', () => {
    const h = makeHost({ reduced: true });
    h.fx.handle([
      { type: 'tool-start', call: call({ file: FILE }) },
      { type: 'tool-start', call: call({ id: 'w', category: 'web', name: 'WebSearch' }) },
    ]);
    h.tick(16);
    expect(h.fx.pool.liveCount).toBe(0);
    expect(h.projects.get('p1demoapp')!.files.nodes.get(FILE)!.heat).toBeGreaterThan(0.9);
  });

  it('havuz taşınca en eskiler geri alınır; canlı parçacık ≤ kapasite', () => {
    const h = makeHost();
    const burst: BoardEvent[] = Array.from({ length: 50 }, (_, i) => ({
      type: 'tool-start',
      call: call({ id: `b${i}`, category: 'read', name: 'Read', file: FILE }),
    }));
    h.fx.handle(burst);
    h.fx.handle(burst);
    for (let i = 0; i < 200; i++) {
      h.tick(16);
      expect(h.fx.pool.liveCount).toBeLessThanOrEqual(60);
    }
  });

  it('performans: dolu havuzla kare başına efekt güncellemesi < 1.5 ms', () => {
    const h = makeHost();
    const burst: BoardEvent[] = Array.from({ length: 60 }, (_, i) => ({
      type: 'tool-start',
      call: call({ id: `p${i}`, category: i % 2 ? 'web' : 'edit', name: 'X', file: FILE }),
    }));
    h.fx.handle(burst);
    for (let i = 0; i < 80; i++) h.tick(16); // kuyruk boşalsın, havuz dolsun
    let total = 0;
    for (let i = 0; i < 200; i++) {
      if (i % 10 === 0) h.fx.handle(burst.slice(0, 6));
      const t0 = performance.now();
      h.tick(16);
      total += performance.now() - t0;
    }
    expect(total / 200).toBeLessThan(1.5);
  });

  it('debug satırı, bağlam yenileme ve dispose', () => {
    const h = makeHost();
    expect(h.debug()?.()).toMatch(/^particles: 0\/60 · queue: 0$/);
    h.fx.handle([{ type: 'tool-start', call: call({ file: FILE }) }]);
    h.tick(16);
    h.fx.reset();
    expect(h.fx.pool.liveCount).toBe(0);
    h.fx.dispose();
    expect(h.frames.size).toBe(0);
    expect(h.scene.getObjectByName('fx')).toBeUndefined();
    expect(h.scene.getObjectByName('particles')).toBeUndefined();
    expect(h.debug()).toBeNull();
  });
});

// 05/02: efektlerin çizim döngüsünden istediği hız.
function quiet(s: BoardSnapshot): BoardSnapshot {
  return {
    ...s,
    sessions: s.sessions.map((x) => ({
      ...x,
      status: x.status === 'ended' ? 'ended' : 'idle',
      waitingFor: null,
      flags: [],
      agents: x.agents.map((a) => ({ ...a, current: null, running: false })),
    })),
    projects: s.projects.map((p) => ({ ...p, conflicts: [] })),
  };
}

describe('LiveEffects.demand', () => {
  it('sahnede hiçbir şey olmuyorsa boşta', () => {
    const h = makeHost();
    h.sync(quiet(h.snap()));
    h.tick(16);
    expect(h.fx.demand()).toBe(DEMAND_NONE);
  });

  it("bekleyen session / çalışan ajan / süren bash: yavaş hız (nabız); reduced motion'da boşta", () => {
    const h = makeHost();
    h.tick(16);
    expect(h.fx.demand()).toBe(DEMAND_AMBIENT);
    const r = makeHost({ reduced: true });
    r.sync(quiet(r.snap()));
    const s = r.snap();
    r.sync({ ...s, sessions: s.sessions.map((x) => (x.id === IDS.waiting ? { ...x, status: 'waiting' } : x)) });
    r.tick(16);
    expect(r.fx.demand()).toBe(DEMAND_NONE);
  });

  it('parçacık uçarken tam hız; varınca ısı sönümü yavaş hız; sönünce boşta', () => {
    const h = makeHost();
    h.sync(quiet(h.snap()));
    h.fx.handle([{ type: 'tool-start', call: call({ file: FILE }) }]);
    expect(h.fx.demand()).toBe(DEMAND_ACTIVE); // kuyrukta
    h.tick(16);
    expect(h.fx.demand()).toBe(DEMAND_ACTIVE); // uçuşta
    let n = 0;
    while (h.fx.pool.liveCount > 0 && n++ < 200) {
      expect(h.fx.demand()).toBe(DEMAND_ACTIVE);
      h.tick(16);
    }
    const node = h.projects.get('p1demoapp')!.files.nodes.get(FILE)!;
    expect(node.heat).toBeGreaterThan(0);
    expect(h.fx.demand()).toBe(DEMAND_AMBIENT); // dosya ısısı sönüyor
    for (let i = 0; i < 150; i++) h.tick(16);
    expect(node.heat).toBe(0);
    expect(h.fx.demand()).toBe(DEMAND_NONE);
  });

  it('şok halkası tam hız ister, bitince bırakır', () => {
    const h = makeHost();
    h.sync(quiet(h.snap()));
    h.fx.handle([{ type: 'status', sessionId: IDS.busy, from: 'busy', to: 'idle', at: NOW }]);
    h.tick(16);
    expect(h.fx.demand()).toBe(DEMAND_ACTIVE);
    for (let i = 0; i < 80; i++) h.tick(16);
    expect(h.fx.demand()).toBe(DEMAND_NONE);
  });
});
