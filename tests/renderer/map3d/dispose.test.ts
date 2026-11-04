// 05/02 dispose denetimi: sahneden kalkan her GPU kaynağı (paylaşılmayan geometri, malzeme, texture) dispose
// edilir; sahnede kalanlar edilmez; ekle-çıkar döngüsünde canlı kaynak sayısı sabit kalır
// (renderer.info.memory'nin WebGL'siz karşılığı).
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { BoardSnapshot, ProjectView, SessionView } from '@shared/types';
import { LiveEffects, type EffectsHost } from '@renderer/map3d/effects';
import { disposeTree, geo, orphanGeometries, sharedCount } from '@renderer/map3d/geometries';
import { ProjectNode } from '@renderer/map3d/platform';
import { WebGlobe } from '@renderer/map3d/web';
import { IDS, makeSnapshot } from '../__fixtures__/snapshot';
import { fakeEnv } from './_env';

const NOW = 1_800_000_000_000;
type Res = THREE.BufferGeometry | THREE.Material | THREE.Texture;

/**
 * Bir alt ağacın paylaşılmayan GPU kaynakları. Robot gövde/kafa malzemeleri renk başına paylaşılır
 * (`userData.shared`, 03/08) ve yalnızca sahne kapanırken disposeShared ile bırakılır.
 */
function resources(root: THREE.Object3D): Set<Res> {
  const out = new Set<Res>();
  root.traverse((o) => {
    const x = o as THREE.Object3D & { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };
    // Sprite geometrisi three'de tüm sprite'lar arasında ortak (modül düzeyinde); dispose edilmemeli.
    if (x.geometry && !x.geometry.userData['shared'] && !(o as THREE.Sprite).isSprite) out.add(x.geometry);
    for (const m of Array.isArray(x.material) ? x.material : x.material ? [x.material] : []) {
      if (m.userData['shared']) continue;
      out.add(m);
      for (const v of Object.values(m)) if (v instanceof THREE.Texture && !v.userData['shared']) out.add(v);
    }
  });
  return out;
}

/** dispose olaylarını izler. */
function tracker() {
  const disposed = new WeakSet<Res>();
  const watched = new WeakSet<Res>();
  return {
    watch(set: Iterable<Res>) {
      for (const r of set) {
        if (watched.has(r)) continue;
        watched.add(r);
        (r as unknown as { addEventListener(t: 'dispose', cb: () => void): void }).addEventListener('dispose', () =>
          disposed.add(r),
        );
      }
    },
    disposed: (r: Res) => disposed.has(r),
  };
}

function setup() {
  const glow = new THREE.Texture();
  glow.userData['shared'] = true; // gerçek glowTexture() gibi
  const env = fakeEnv({ reducedMotion: false, glow });
  const scene = new THREE.Scene();
  const base = makeSnapshot(NOW);
  const p = base.projects.find((x) => x.id === 'p1demoapp')!;
  const node = new ProjectNode(p.id, env);
  scene.add(node.group);
  node.place(0, 0, 0);
  const sync = (proj: ProjectView, sessions: SessionView[]) => {
    node.sync(proj, new Map(sessions.map((s) => [s.id, s])), 0, NOW);
    for (let t = 0; t <= 400; t += 50) node.step(t, 0.05);
  };
  return { env, scene, base, p, node, sync };
}

describe('dispose denetimi', () => {
  it('session/ajan/dosya/çakışma/amblem kalkınca kaynakları bırakılır; kalanlar dokunulmaz', () => {
    const { scene, base, p, node, sync } = setup();
    const t = tracker();
    const full: ProjectView = {
      ...p,
      hotFiles: [
        {
          path: '/a/x.ts',
          projectId: p.id,
          reads: 1,
          writes: 2,
          lastTs: NOW,
          editors: [{ sessionId: IDS.busy, agentId: null, ts: NOW }],
        },
        { path: '/a/y.ts', projectId: p.id, reads: 3, writes: 0, lastTs: NOW, editors: [] },
      ],
      conflicts: [{ path: '/a/x.ts', projectId: p.id, sessionIds: [IDS.busy, IDS.waiting], lastTs: NOW }],
    };
    sync(full, base.sessions);
    const before = resources(scene);
    t.watch(before);

    // Bir session, tüm subagent'lar (robotlar, izler, pedler), bir dosya ve çakışma gider; amblem türü değişir.
    const trimmed = base.sessions
      .filter((s) => s.id !== IDS.waiting)
      .map((s) => ({ ...s, agents: s.agents.filter((a) => a.isMain) }));
    const next: ProjectView = {
      ...full,
      sessionIds: p.sessionIds.filter((id) => id !== IDS.waiting),
      hotFiles: full.hotFiles.slice(1),
      conflicts: [],
      emblem: full.emblem === 'ring' ? 'cube' : 'ring',
    };
    sync(next, trimmed);
    const after = resources(scene);
    t.watch(after);

    const gone = [...before].filter((r) => !after.has(r));
    expect(gone.length).toBeGreaterThan(10);
    const leaked = gone.filter((r) => !t.disposed(r));
    expect(leaked.map((r) => `${r.constructor.name}`)).toEqual([]);
    const early = [...after].filter((r) => t.disposed(r));
    expect(early.map((r) => r.constructor.name)).toEqual([]);

    node.dispose();
    const all = [...before, ...after];
    expect(
      all
        .filter((r) => !t.disposed(r))
        .map(
          (r) =>
            `${r.constructor.name}:${(r as { name?: string }).name ?? ''}:${(r as THREE.Texture).isTexture ? (r as THREE.Texture).image?.width : ''}`,
        ),
    ).toEqual([]);
    expect(scene.children.includes(node.group)).toBe(false);
  });

  it('ekle-çıkar döngüsü: canlı kaynak sayısı sabit, kalkan her şey dispose', () => {
    const { scene, base, p, sync } = setup();
    const t = tracker();
    const withAll = () => sync(p, base.sessions);
    const withOne = () =>
      sync(
        { ...p, sessionIds: [IDS.busy] },
        base.sessions.filter((s) => s.id === IDS.busy),
      );
    withAll();
    const n0 = resources(scene).size;
    const seen = new Set<Res>();
    for (let i = 0; i < 5; i++) {
      for (const r of resources(scene)) seen.add(r);
      t.watch(resources(scene));
      withOne();
      t.watch(resources(scene));
      for (const r of resources(scene)) seen.add(r);
      withAll();
      expect(resources(scene).size).toBe(n0);
    }
    const live = resources(scene);
    const leaked = [...seen].filter((r) => !live.has(r) && !t.disposed(r));
    expect(leaked.length).toBe(0);
  });

  it('LiveEffects.dispose: efekt grubu ve havuz kaynakları bırakılır, paylaşılan glow kalır', () => {
    const scene = new THREE.Scene();
    const glow = new THREE.Texture();
    glow.userData['shared'] = true;
    const host = {
      scene,
      reducedMotion: false,
      glow,
      lastSnapshot: null as BoardSnapshot | null,
      anchors: {
        agentPos: () => null,
        filePos: () => null,
        shellPos: () => null,
        haloPos: () => new THREE.Vector3(),
        webCenter: () => new THREE.Vector3(),
        sessionTop: () => null,
        sessionBase: () => null,
        projectCenter: () => null,
      },
      onFrame: () => () => {},
      onUpdate: () => () => {},
      onRestore: () => () => {},
      projectNode: () => undefined,
      projectNodes: () => [],
      sessionNodeById: () => null,
      webGlobe: () => null,
      projectOfSession: () => null,
      setDebugInfo: () => {},
    } satisfies EffectsHost;
    const fx = new LiveEffects(host);
    const t = tracker();
    const res = resources(scene);
    t.watch(res);
    let glowDisposed = false;
    glow.addEventListener('dispose', () => (glowDisposed = true));
    expect(res.size).toBeGreaterThan(100); // 60 × 3 sprite + şok/parlama
    fx.dispose();
    expect([...res].filter((r) => !t.disposed(r)).length).toBe(0);
    expect(scene.children.length).toBe(0);
    expect(glowDisposed).toBe(false);
  });

  it("disposeTree: paylaşılan geometri, glow ve three'nin ortak sprite geometrisi bırakılmaz", () => {
    const shared = geo('webSat');
    const glow = new THREE.Texture();
    glow.userData['shared'] = true;
    const own = new THREE.BoxGeometry();
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow }));
    const other = new THREE.Sprite(new THREE.SpriteMaterial());
    const root = new THREE.Group().add(
      new THREE.Mesh(shared, new THREE.MeshBasicMaterial()),
      new THREE.Mesh(own),
      sprite,
    );
    const fired: string[] = [];
    shared.addEventListener('dispose', () => fired.push('shared'));
    glow.addEventListener('dispose', () => fired.push('glow'));
    own.addEventListener('dispose', () => fired.push('own'));
    sprite.geometry.addEventListener('dispose', () => fired.push('spriteGeo'));
    sprite.material.addEventListener('dispose', () => fired.push('spriteMat'));
    disposeTree(root);
    expect(fired.sort()).toEqual(['own', 'spriteMat']);
    expect(other.geometry).toBe(sprite.geometry); // ortak olduğu için dokunulmamalı
  });
});

describe('WebGlobe dispose (03/08)', () => {
  const snapWith = (calls: { id: string; label: string }[], ended = false): BoardSnapshot => {
    const s = makeSnapshot(NOW);
    const sess = s.sessions.find((x) => x.id === IDS.busy)!;
    sess.status = ended ? 'ended' : 'busy';
    sess.agents = calls.map((c, i) => ({
      ...sess.agents[0]!,
      id: `w${i}`,
      isMain: i === 0,
      current: {
        id: c.id,
        sessionId: sess.id,
        agentId: null,
        name: 'WebSearch',
        category: 'web',
        label: c.label,
        startedAt: NOW,
      },
    }));
    // Diğer session'lardaki web çağrıları sayılmasın.
    s.sessions = s.sessions.map((x) => (x.id === sess.id ? x : { ...x, agents: [] }));
    return s;
  };

  it('uydu → sönük bekleme → kaybolma; uydu, parıltı, dalga malzemeleri ve etiketler bırakılır', () => {
    const glow = new THREE.Texture();
    glow.userData['shared'] = true;
    const env = fakeEnv({ reducedMotion: false, glow });
    const scene = new THREE.Scene();
    const web = new WebGlobe(env, () => {});
    scene.add(web.group);
    const base = resources(scene);
    const t = tracker();
    web.sync(
      snapWith([
        { id: 'c1', label: 'rakip fiyat' },
        { id: 'c2', label: 'https://example.com/x' },
      ]),
      NOW,
    );
    web.ping();
    expect(web.sats.size).toBe(2);
    const live = resources(scene);
    const own = [...live].filter((r) => !base.has(r));
    t.watch(own);
    expect(own.length).toBeGreaterThanOrEqual(5); // 2 × (uydu + parıltı) + dalga
    // Çağrılar bitti: 6 sn sönük, sonra söner.
    web.sync(snapWith([]), NOW);
    for (let i = 0; i < 5 * 60; i++) web.step(1 / 60, true);
    expect(web.sats.size).toBe(2);
    for (let i = 0; i < 3 * 60; i++) web.step(1 / 60, true);
    expect(web.sats.size).toBe(0);
    expect(web.pings).toHaveLength(0);
    expect(own.filter((r) => !t.disposed(r))).toEqual([]);
    expect(web.step(1 / 60, true)).toBe(0); // uydu ve dalga yok → döngüden istek yok
    const all = resources(scene);
    t.watch(all);
    web.dispose();
    expect([...all].filter((r) => !t.disposed(r))).toEqual([]);
    expect(env.picks.size).toBe(0);
    expect(scene.children.length).toBe(0);
  });
});

describe('orphanGeometries (bench sızıntı ölçüsü)', () => {
  it('sahnedeki ve paylaşılan geometriler sayılmaz; sahneden kalkıp dispose edilmeyen sayılır', () => {
    const root = new THREE.Group();
    const a = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    const b = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    root.add(a, b);
    const shared = sharedCount();
    // GPU'da: sahnedeki 2 + paylaşılan önbellek.
    expect(orphanGeometries(root, 2 + shared)).toBe(0);
    root.remove(b); // dispose edilmeden kaldırıldı: hâlâ GPU'da
    expect(orphanGeometries(root, 2 + shared)).toBe(1);
    // henüz çizilmemiş yeni nesne (yüklü sayılmaz) negatife düşürmez
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
    expect(orphanGeometries(root, 1 + shared)).toBe(0);
  });
});
