// MapInteraction (03/07): tıklama/sürükleme eşiği, görünmez hitbox isabeti, uçuş, ev konumu, dispose.
import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { homePose } from '@renderer/map3d/camera';
import type { PickData } from '@renderer/map3d/env';
import { MapInteraction, type ControlsLike, type InteractionHost } from '@renderer/map3d/interaction';
import { DEMAND_ACTIVE, DEMAND_NONE } from '@renderer/map3d/renderLoop';
import { gridExtent } from '@renderer/map3d/layout';
import type { SceneAnchors } from '@renderer/map3d/scene';

class FakeControls implements ControlsLike {
  target = new THREE.Vector3();
  enableDamping = false;
  dampingFactor = 0;
  maxPolarAngle = Math.PI;
  minDistance = 0;
  maxDistance = Infinity;
  enablePan = false;
  disposed = false;
  /** Sönümleme sürüyor gibi davran (update true döner). */
  moving = false;
  readonly listeners = new Map<string, Set<() => void>>();
  update() {
    return this.moving;
  }
  addEventListener(type: string, cb: () => void) {
    const s = this.listeners.get(type) ?? new Set();
    s.add(cb);
    this.listeners.set(type, s);
  }
  removeEventListener(type: string, cb: () => void) {
    this.listeners.get(type)?.delete(cb);
  }
  emit(type: string) {
    for (const cb of this.listeners.get(type) ?? []) cb();
  }
  dispose() {
    this.disposed = true;
  }
}

/** Etkileşimin başlangıç en-boy oranı 1.5; 4 projelik sahneye sığdırılmış ev konumu. */
const HOME = homePose(1.5, gridExtent(4));
const AT = HOME.target;

function setup(opts: { reduced?: boolean } = {}) {
  const el = document.createElement('div');
  el.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width: 100,
    height: 100,
    right: 100,
    bottom: 100,
    x: 0,
    y: 0,
    toJSON() {},
  });
  document.body.appendChild(el);
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 220);
  const pickables: THREE.Object3D[] = [];
  const hooks = new Set<(t: number, dt: number) => void>();
  const wakes = { n: 0 };
  const tops = new Map<string, THREE.Vector3>([['S1', new THREE.Vector3(5, 3, -2)]]);
  const anchors: SceneAnchors = {
    agentPos: () => null,
    filePos: () => null,
    shellPos: () => null,
    haloPos: () => new THREE.Vector3(),
    webCenter: () => new THREE.Vector3(0, 12.2, -0.6),
    sessionTop: (id) => tops.get(id)?.clone() ?? null,
    sessionBase: () => null,
    projectCenter: (id) => (id === 'P1' ? new THREE.Vector3(-8.4, 0, 6.9) : null),
  };
  const host: InteractionHost = {
    camera,
    domElement: el,
    pickables,
    anchors,
    reducedMotion: opts.reduced ?? false,
    extent: gridExtent(4),
    onFrame: (cb) => {
      hooks.add(cb);
      return () => hooks.delete(cb);
    },
    requestFrame: () => {
      wakes.n++;
    },
  };
  const selected: [string, string][] = [];
  const agents: (string | undefined)[] = [];
  const activated: string[] = [];
  const hovers: (PickData | null)[] = [];
  let controls!: FakeControls;
  const ix = new MapInteraction(host, {
    onSelect: (id, src, agentId) => {
      selected.push([id, src]);
      agents.push(agentId);
    },
    onActivate: (id) => activated.push(id),
    onHover: (p) => hovers.push(p),
    firstSessionOfProject: (pid) => (pid === 'P1' ? 'S1' : null),
    createControls: () => (controls = new FakeControls()),
  });
  // Ekranın ortasındaki ışın kamera hedefinden geçer; oraya görünmez bir hitbox koy.
  const add = (data: PickData) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 3, 8), new THREE.MeshBasicMaterial({ visible: false }));
    m.position.set(AT.x, AT.y, AT.z);
    m.userData['pick'] = data;
    m.updateMatrixWorld();
    pickables.push(m);
    return m;
  };
  const frames = (n: number, dt = 1 / 60) => {
    for (let i = 0; i < n; i++) for (const h of [...hooks]) h(i * dt * 1000, dt);
  };
  const ptr = (type: string, x: number, y: number, button = 0) =>
    el.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button, bubbles: true }));
  const click = (dx: number) => {
    ptr('pointerdown', 50, 50);
    if (dx) ptr('pointermove', 50 + dx, 50);
    ptr('pointerup', 50 + dx, 50);
  };
  return { ix, el, camera, controls, selected, agents, activated, hovers, add, frames, ptr, click, hooks, wakes };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('MapInteraction', () => {
  it('sahneye sığdırılmış ev konumuyla başlar, OrbitControls ayarları prototiple aynı', () => {
    const { camera, controls } = setup();
    expect(camera.position.toArray()).toEqual([HOME.pos.x, HOME.pos.y, HOME.pos.z]);
    expect(controls.target.toArray()).toEqual([AT.x, AT.y, AT.z]);
    expect(controls.dampingFactor).toBe(0.08);
    expect(controls.maxPolarAngle).toBe(1.32);
    expect([controls.minDistance, controls.maxDistance]).toEqual([7, 160]);
  });

  it("görünmez hitbox raycast'te bulunur; 3 px hareketli tık seçer", () => {
    const { add, click, selected } = setup();
    add({ kind: 'crew', sessionId: 'S1' });
    click(3);
    expect(selected).toEqual([['S1', 'map']]);
  });

  it('8 px sürükleme seçmez ve kamerayı kullanıcıya bırakır', () => {
    const { add, click, selected, ix } = setup();
    add({ kind: 'crew', sessionId: 'S1' });
    click(8);
    expect(selected).toEqual([]);
    expect(ix.userMoved).toBe(true);
  });

  it('boşluğa tık hiçbir şey yapmaz', () => {
    const { click, selected, ix } = setup();
    click(0);
    expect(selected).toEqual([]);
    expect(ix.flying).toBe(false);
  });

  it('sağ tık seçim yapmaz', () => {
    const { add, ptr, selected } = setup();
    add({ kind: 'crew', sessionId: 'S1' });
    ptr('pointerdown', 50, 50, 2);
    ptr('pointerup', 50, 50, 2);
    expect(selected).toEqual([]);
  });

  it("platforma tık: projenin ilk session'ı seçilir, kamera projeye uçar", () => {
    const { add, click, selected, ix, frames, controls } = setup();
    add({ kind: 'platform', projectId: 'P1' });
    click(0);
    expect(selected).toEqual([['S1', 'map']]);
    expect(ix.flying).toBe(true);
    frames(400);
    expect(ix.flying).toBe(false);
    expect(controls.target.x).toBeCloseTo(-8.4);
    expect(controls.target.y).toBeCloseTo(1.5);
  });

  it('focusSession: 19 birim mesafeden yumuşak uçuş, ~0.6–0.8 sn sonra yakın', () => {
    const { ix, frames, camera, controls } = setup();
    ix.focusSession('S1');
    frames(45); // 0.75 sn
    expect(camera.position.distanceTo(new THREE.Vector3(5 + 0.18 * 19, 1.6 + 0.78 * 19, -2 + 0.82 * 19))).toBeLessThan(
      1.5,
    );
    frames(300);
    expect(ix.flying).toBe(false);
    expect(controls.target.toArray()).toEqual([5, 1.6, -2]);
  });

  it('uçuş sırasında sürükleme uçuşu iptal eder', () => {
    const { ix, ptr } = setup();
    ix.focusSession('S1');
    expect(ix.flying).toBe(true);
    ptr('pointerdown', 50, 50);
    ptr('pointermove', 70, 50);
    expect(ix.flying).toBe(false);
  });

  it("görünmeyen session'a odak: kamera yerinde kalır", () => {
    const { ix } = setup();
    ix.focusSession('yok');
    expect(ix.flying).toBe(false);
  });

  it('Esc ev konumuna döner ve userMoved sıfırlanır', () => {
    const { ix, frames, camera } = setup();
    ix.focusSession('S1');
    frames(400);
    expect(ix.userMoved).toBe(true);
    expect(ix.handleKey('Escape')).toBe(true);
    frames(400);
    expect(ix.userMoved).toBe(false);
    expect(camera.position.distanceTo(new THREE.Vector3(HOME.pos.x, HOME.pos.y, HOME.pos.z))).toBeLessThan(0.06);
  });

  it('+/- mesafeyi değiştirir, sınırlar içinde kalır', () => {
    const { ix, camera, controls } = setup();
    const d0 = camera.position.distanceTo(controls.target);
    ix.handleKey('+');
    expect(camera.position.distanceTo(controls.target)).toBeCloseTo(d0 * 0.85);
    for (let i = 0; i < 30; i++) ix.handleKey('-');
    expect(camera.position.distanceTo(controls.target)).toBeCloseTo(160);
    expect(ix.handleKey('x')).toBe(false);
  });

  it('reduced motion: uçuş yok, anında yerleşir', () => {
    const { ix, controls } = setup({ reduced: true });
    ix.focusSession('S1');
    expect(ix.flying).toBe(false);
    expect(controls.target.toArray()).toEqual([5, 1.6, -2]);
  });

  it('yeniden boyutlandırma: kullanıcı oynatmadıysa yeni ev konumu anında', () => {
    const { ix, camera } = setup();
    ix.onResize(0.9);
    const h = homePose(0.9, gridExtent(4));
    expect(camera.position.distanceTo(new THREE.Vector3(h.pos.x, h.pos.y, h.pos.z))).toBeLessThan(1e-9);
    ix.focusSession('S1');
    const before = camera.position.clone();
    ix.onResize(2);
    expect(camera.position.equals(before)).toBe(true);
  });

  it('robota tık: session seçilir ve ajan bildirilir (panelde satır vurgusu); çift tık terminale gider', () => {
    const { add, click, selected, agents, activated, el } = setup();
    add({ kind: 'agent', sessionId: 'S1', agentId: 'a7' });
    click(0);
    expect(selected).toEqual([['S1', 'map']]);
    expect(agents).toEqual(['a7']);
    el.dispatchEvent(new MouseEvent('dblclick', { clientX: 50, clientY: 50, bubbles: true }));
    expect(activated).toEqual(['S1']);
  });

  it('hover: robotun üstünde pick bildirilir; ayrılınca null', () => {
    const { add, ptr, hovers, el } = setup();
    add({ kind: 'agent', sessionId: 'S1', agentId: 'a7' });
    ptr('pointermove', 50, 50);
    expect(hovers.at(-1)).toMatchObject({ kind: 'agent', agentId: 'a7' });
    el.dispatchEvent(new MouseEvent('pointerleave', { bubbles: true }));
    expect(hovers.at(-1)).toBeNull();
    const n = hovers.length;
    el.dispatchEvent(new MouseEvent('pointerleave', { bubbles: true }));
    expect(hovers.length).toBe(n); // aynı "hiçbiri" tekrar bildirilmez
  });

  it('web küresine tık: kamera küreye yaklaşır, seçim değişmez', () => {
    const { add, click, selected, ix, frames, camera } = setup();
    add({ kind: 'web' });
    click(0);
    expect(selected).toEqual([]);
    expect(ix.flying).toBe(true);
    frames(400);
    expect(camera.position.distanceTo(new THREE.Vector3(0, 12.2, -0.6))).toBeLessThan(13);
  });

  it('dispose: dinleyiciler ve kare kancası kalkar, kontroller dispose edilir', () => {
    const { ix, add, click, selected, hooks, controls } = setup();
    add({ kind: 'crew', sessionId: 'S1' });
    ix.dispose();
    click(0);
    expect(selected).toEqual([]);
    expect(hooks.size).toBe(0);
    expect(controls.disposed).toBe(true);
  });

  it('05/02 döngü: uçuş ve sönümleme tam hız ister, bitince bırakır', () => {
    const { ix, frames, controls } = setup();
    expect(ix.demand()).toBe(DEMAND_NONE);
    ix.focusSession('S1');
    expect(ix.demand()).toBe(DEMAND_ACTIVE);
    frames(400);
    expect(ix.flying).toBe(false);
    expect(ix.demand()).toBe(DEMAND_NONE);
    controls.moving = true; // sürükleme bitti, sönümleme sürüyor
    frames(1);
    expect(ix.demand()).toBe(DEMAND_ACTIVE);
    controls.moving = false;
    frames(1);
    expect(ix.demand()).toBe(DEMAND_NONE);
  });

  it('05/02 döngü: odak, klavye, işaretçi ve kontrol "change" olayı döngüyü uyandırır', () => {
    const { ix, ptr, controls, wakes } = setup();
    const w = () => wakes.n;
    let n = w();
    ix.focusSession('S1');
    expect(w()).toBeGreaterThan(n);
    n = w();
    ix.handleKey('+');
    expect(w()).toBeGreaterThan(n);
    n = w();
    ptr('pointerdown', 10, 10);
    expect(w()).toBeGreaterThan(n);
    n = w();
    controls.emit('change');
    expect(w()).toBe(n + 1);
    ix.dispose();
    controls.emit('change');
    expect(w()).toBe(n + 1); // dispose sonrası dinleyici yok
  });
});
