// Düğüm diff'i (03/05, 03/08): renderer'sız three sahnesinde robot ekipleri — ekle/çıkar, dispose,
// pickable kaydı, renkler, ctx yayı, etiketler ve çizim döngüsü talebi.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { AgentView, ProjectView, SessionView } from '@shared/types';
import { CrewNode } from '@renderer/map3d/crew';
import { ProjectNode } from '@renderer/map3d/platform';
import { orphanGeometries, sharedCount } from '@renderer/map3d/geometries';
import { DEMAND_ACTIVE, DEMAND_AMBIENT, DEMAND_NONE } from '@renderer/map3d/renderLoop';
import { crewSlots } from '@renderer/map3d/robotLogic';
import { SHELL } from '@renderer/lib/robotColor';
import { IDS, makeSnapshot } from '../__fixtures__/snapshot';
import { fakeEnv, spyDisposals } from './_env';

const NOW = 1_800_000_000_000;
/** Robot başına pickable: kafa, vizör, gövde kutusu, ped. Ekip başına: ctx yayı zemini. */
const PICKS_PER_ROBOT = 4;

function setup() {
  const snap = makeSnapshot(NOW);
  const env = fakeEnv();
  const scene = new THREE.Scene();
  const byId = new Map(snap.sessions.map((s) => [s.id, s]));
  return { snap, env, scene, byId };
}

const sub = (sessionId: string, id: string, over: Partial<AgentView> = {}): AgentView => ({
  id,
  sessionId,
  isMain: false,
  name: id,
  agentType: 'general-purpose',
  team: null,
  model: 'sonnet',
  background: false,
  running: true,
  done: false,
  current: null,
  toolCount: 0,
  errorCount: 0,
  costUsd: 0,
  firstTs: NOW,
  lastTs: NOW,
  doneAt: null,
  loopSuspect: false,
  ...over,
});

const kindsOf = (env: ReturnType<typeof fakeEnv>) =>
  env.picks.list.map((o) => (o.userData['pick'] as { kind: string }).kind);

describe('ProjectNode.sync (robot ekipleri)', () => {
  it('her session bir ekip: ajan başına robot ve pickable kaydı', () => {
    const { snap, env, scene, byId } = setup();
    const p = snap.projects.find((x) => x.id === 'p1demoapp')!;
    const n = new ProjectNode(p.id, env);
    scene.add(n.group);
    n.sync(p, byId, 0, NOW);
    expect([...n.sessions.keys()]).toEqual([IDS.waiting, IDS.busy, IDS.ended]);
    const kinds = kindsOf(env);
    expect(kinds.filter((k) => k === 'platform')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'crew')).toHaveLength(3);
    expect(kinds.filter((k) => k === 'emblem').length).toBeGreaterThan(0);
    const agents = p.sessionIds.reduce((s, id) => s + byId.get(id)!.agents.length, 0);
    expect(kinds.filter((k) => k === 'agent')).toHaveLength(agents * PICKS_PER_ROBOT);
    for (const id of p.sessionIds) expect(n.sessions.get(id)!.robots.size).toBe(byId.get(id)!.agents.length);
  });

  it('bekleyen session kenar rengini amber yapar, amber halka görünür', () => {
    const { snap, env, byId } = setup();
    const p = snap.projects.find((x) => x.id === 'p1demoapp')!;
    const n = new ProjectNode(p.id, env);
    n.sync(p, byId, 0, NOW);
    expect(n.edges.material.color.getHex()).toBe(0x6a5420);
    expect(n.sessions.get(IDS.waiting)!.waitRing.visible).toBe(true);
    expect(n.sessions.get(IDS.busy)!.waitRing.visible).toBe(false);
  });

  it('session çıkınca ekip dispose edilir ve pickable kaydı silinir', () => {
    const { snap, env, byId } = setup();
    const p = snap.projects.find((x) => x.id === 'p1demoapp')!;
    const n = new ProjectNode(p.id, env);
    n.sync(p, byId, 0, NOW);
    const gone = n.sessions.get(IDS.ended)!;
    const spy = spyDisposals(gone.group);
    const before = env.picks.size;
    const agents = byId.get(IDS.ended)!.agents.length;
    n.sync({ ...p, sessionIds: [IDS.waiting, IDS.busy] }, byId, 0, NOW);
    expect(n.sessions.has(IDS.ended)).toBe(false);
    expect(gone.group.parent).toBeNull();
    expect(spy.count()).toBeGreaterThan(0);
    expect(env.picks.size).toBe(before - 1 - agents * PICKS_PER_ROBOT);
  });

  it('kararlı sıra: kalan ekipler yer değiştirmez, yeni session sona eklenir', () => {
    const { snap, env, byId } = setup();
    const p = snap.projects.find((x) => x.id === 'p1demoapp')!;
    const n = new ProjectNode(p.id, env);
    n.sync({ ...p, sessionIds: [IDS.busy, IDS.waiting] }, byId, 0, NOW);
    n.sync({ ...p, sessionIds: [IDS.waiting, IDS.busy, IDS.idle] }, byId, 0, NOW);
    expect([...n.sessions.keys()]).toEqual([IDS.busy, IDS.waiting, IDS.idle]);
  });

  it('7+ session: ilk 6 ekip (bekleyen öncelikli) ve +N etiketi', () => {
    const { snap, env } = setup();
    const base = snap.sessions.find((s) => s.id === IDS.busy)!;
    const many: SessionView[] = Array.from({ length: 9 }, (_, i) => ({
      ...base,
      id: `aaaaaaaa-0000-4000-8000-00000000000${i}`,
      status: i === 8 ? 'waiting' : 'idle',
      agents: [],
    }));
    const byId = new Map(many.map((s) => [s.id, s]));
    const p: ProjectView = { ...snap.projects[0]!, sessionIds: many.map((s) => s.id) };
    const n = new ProjectNode(p.id, env);
    n.sync(p, byId, 0, NOW);
    expect(n.sessions.size).toBe(6);
    expect(n.sessions.has(many[8]!.id)).toBe(true);
    const more = n.group.children.find((o) => (o as { element?: HTMLElement }).element?.classList.contains('more'));
    expect(more?.visible).toBe(true);
    expect((more as unknown as { element: HTMLElement }).element.textContent).toBe('+3');
  });

  it("çakışan dosya küpü ve yazan her görünür session'a kesikli çizgi", () => {
    const { snap, env, byId } = setup();
    const p = snap.projects.find((x) => x.id === 'p2agents')!;
    const n = new ProjectNode(p.id, env);
    n.sync({ ...p, sessionIds: [IDS.team, IDS.idle] }, byId, 0, NOW);
    const file = p.conflicts[0]!.path;
    expect(n.files.nodes.get(file)?.conflict).toBe(true);
    const dashed: THREE.Object3D[] = [];
    n.group.traverse((o) => {
      if ((o as THREE.Line).material instanceof THREE.LineDashedMaterial) dashed.push(o);
    });
    expect(dashed).toHaveLength(2);
  });

  it("dispose: tüm pickable'lar ve malzemeler bırakılır; paylaşılan geometri/malzemeler kalır", () => {
    const { snap, env, scene, byId } = setup();
    const p = snap.projects.find((x) => x.id === 'p2agents')!;
    const n = new ProjectNode(p.id, env);
    scene.add(n.group);
    n.sync(p, byId, 0, NOW);
    const shared = sharedCount();
    const spy = spyDisposals(n.group);
    n.dispose();
    expect(env.picks.size).toBe(0);
    expect(n.group.parent).toBeNull();
    expect(spy.count()).toBeGreaterThan(10);
    expect(sharedCount()).toBe(shared);
  });

  it('robot ekleme/çıkarma döngüsü sahipsiz geometri bırakmaz (perf: orphanGeometries < 3)', () => {
    const { snap, env, scene, byId } = setup();
    const p = snap.projects.find((x) => x.id === 'p2agents')!;
    const n = new ProjectNode(p.id, env);
    scene.add(n.group);
    // GPU'daki geometri sayısı yerine: sahnede görülüp dispose edilmemiş her geometri "ayrılmış" sayılır.
    const live = new Set<THREE.BufferGeometry>();
    const watch = () =>
      scene.traverse((o) => {
        const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
        if (!g || live.has(g)) return;
        live.add(g);
        g.addEventListener('dispose', () => live.delete(g));
      });
    const team = byId.get(IDS.team)!;
    for (let i = 0; i < 20; i++) {
      const extra = Array.from({ length: (i % 5) + 1 }, (_, k) => sub(IDS.team, `x${i}-${k}`));
      byId.set(IDS.team, { ...team, agents: [...team.agents, ...extra], ctxRatio: (i % 10) / 10 });
      n.sync(p, byId, i * 100, NOW);
      watch();
    }
    byId.set(IDS.team, team);
    n.sync(p, byId, 5000, NOW);
    watch();
    expect(orphanGeometries(scene, live.size)).toBeLessThan(3);
  });
});

describe('CrewNode', () => {
  it('robot ekle/çıkar: yalnızca değişen robotlar oluşturulur/silinir; malzeme ve iz dispose edilir', () => {
    const { snap, env } = setup();
    const s = snap.sessions.find((x) => x.id === IDS.team)!;
    const n = new CrewNode(s.id, env);
    n.sync(s, 0, NOW, true);
    const before = new Map(n.robots);
    expect(before.size).toBe(s.agents.length);

    const added: SessionView = { ...s, agents: [...s.agents, sub(s.id, 'zz')] };
    n.sync(added, 0, NOW, true);
    expect(n.robots.size).toBe(s.agents.length + 1);
    for (const [id, r] of before) expect(n.robots.get(id)).toBe(r);

    const removedId = s.agents[1]!.id;
    const removed = n.robots.get(removedId)!;
    const spy = spyDisposals(removed.group);
    let traceDisposed = false;
    removed.trace!.geometry.addEventListener('dispose', () => (traceDisposed = true));
    n.sync({ ...added, agents: added.agents.filter((a) => a.id !== removedId) }, 0, NOW, true);
    expect(n.robots.has(removedId)).toBe(false);
    expect(removed.group.parent).toBeNull();
    // Robotun kendi malzemeleri: gözler, göz parıltısı, ped, iz. Paylaşılan gövde/kafa malzemeleri kalır.
    expect(spy.count()).toBeGreaterThanOrEqual(4);
    expect(traceDisposed).toBe(true);
    expect(env.picks.list.some((o) => (o.userData['pick'] as { agentId?: string }).agentId === removedId)).toBe(false);
  });

  it('lider ortada (0,0), alt ajanlar SLOT_DEG yuvalarında; kararlı sıra', () => {
    const { snap, env } = setup();
    const s = snap.sessions.find((x) => x.id === IDS.team)!;
    const n = new CrewNode(s.id, env);
    n.sync(s, 0, NOW, true);
    expect(n.robot(null)!.isLead).toBe(true);
    expect(n.robot('main')!.homeLocal).toEqual({ x: 0, z: 0 });
    const slots = crewSlots(3);
    expect(n.robot('a1')!.homeLocal).toEqual(slots[0]);
    expect(n.robot('a2')!.homeLocal).toEqual(slots[1]);
    // a1 çıkınca a2 ikinci yuvadan ilk yuvaya kayar; yeni gelen sona.
    n.sync({ ...s, agents: s.agents.filter((a) => a.id !== 'a1').concat(sub(s.id, 'new')) }, 0, NOW, true);
    const s2 = crewSlots(3);
    expect(n.robot('a2')!.homeLocal).toEqual(s2[0]);
    expect(n.robot('new')!.homeLocal).toEqual(s2[2]);
    expect(n.robot('a1')).toBeNull();
  });

  it('robot durumları: work (web), slow (200 sn bash), off (bitmiş), ask (bekleyen ana ajan)', () => {
    const { snap, env } = setup();
    const s = snap.sessions.find((x) => x.id === IDS.team)!;
    const n = new CrewNode(s.id, env);
    n.sync(s, 0, NOW, true);
    expect(n.robot('a1')!.state).toBe('work');
    expect(n.robot('a2')!.state).toBe('slow');
    expect(n.robot('a3')!.state).toBe('off');
    expect('#' + n.robot('a1')!.eyeMat.color.getHexString().toUpperCase()).toBe('#4CC38A');
    expect('#' + n.robot('a2')!.eyeMat.color.getHexString().toUpperCase()).toBe('#FF7A6B');
    const w = snap.sessions.find((x) => x.id === IDS.waiting)!;
    const wn = new CrewNode(w.id, env);
    wn.sync(w, 0, NOW, true);
    expect(wn.robot(null)!.state).toBe('ask');
  });

  it('chibi yüz: duruma göre ağız, göğüs ışığı durum renginde; onayda sağ kol yana-yukarı kalkık', () => {
    const { snap } = setup();
    const env = fakeEnv({ reducedMotion: false });
    const s = snap.sessions.find((x) => x.id === IDS.team)!;
    const n = new CrewNode(s.id, env);
    n.sync(s, 0, NOW, true);
    const mouth = (id: string) =>
      Object.entries(n.robot(id)!.mouths)
        .filter(([, m]) => m.visible)
        .map(([k]) => k);
    expect(mouth('a1')).toEqual(['smile']);
    expect(mouth('a2')).toEqual(['oh']);
    expect(mouth('a3')).toEqual(['flat']);
    const a2 = n.robot('a2')!;
    expect(a2.chestMat.color.getHex()).toBe(a2.eyeMat.color.getHex());
    const w = snap.sessions.find((x) => x.id === IDS.waiting)!;
    const wn = new CrewNode(w.id, env);
    wn.sync(w, 0, NOW, true);
    for (let t = 0; t < 200; t += 16) wn.step(t, 0.016);
    const [L, R] = wn.robot(null)!.arms as [THREE.Group, THREE.Group];
    expect(R.rotation.z).toBeGreaterThan(2.3);
    expect(R.rotation.x).toBeCloseTo(-0.35);
    expect(L.rotation.z).toBe(0);
    // Onay bitince kol iner (z dönüşü sıfırlanır).
    wn.sync({ ...w, status: 'busy', waitingFor: null }, 0, NOW, true);
    wn.step(300, 0.016);
    expect(wn.robot(null)!.arms[1]!.rotation.z).toBe(0);
    // Hareketi azalt: sabit poz, aynı kalkık kol.
    const still = new CrewNode(w.id, fakeEnv({ reducedMotion: true }));
    still.sync(w, 0, NOW, true);
    expect(still.robot(null)!.arms[1]!.rotation.z).toBeCloseTo(2.55);
  });

  it('gövde rengi: takım/tip rengi, aynı takım aynı renk; lider proje renginde', () => {
    const { snap, env } = setup();
    const s = snap.sessions.find((x) => x.id === IDS.team)!;
    const n = new CrewNode(s.id, env);
    n.sync(s, 0, NOW, true, '#FF00AA');
    expect(n.robot('a1')!.shellHex).toBe(SHELL.audience);
    expect(n.robot('a2')!.shellHex).toBe(SHELL.audience);
    expect(n.robot('a3')!.shellHex).toBe(SHELL.Explore);
    expect(n.robot('main')!.shellHex).toBe('#FF00AA');
    // Beyaz kabuk + aksan tek boya malzemesinde (köşe rengi); aynı renkteki robotlar aynı geometriyi paylaşır.
    const a1 = n.robot('a1')!;
    expect(a1.head.material).toBe(n.robot('a3')!.head.material);
    expect(a1.head.geometry).toBe(n.robot('a2')!.head.geometry);
    expect(a1.head.geometry).not.toBe(n.robot('a3')!.head.geometry);
    expect(a1.head.geometry.userData['shared']).toBe(true);
    // Proje rengi değişince liderin aksanı da değişir (geometri değişir, malzeme aynı).
    const leadGeo = n.robot('main')!.head.geometry;
    n.sync(s, 0, NOW, true, '#00FF00');
    expect(n.robot('main')!.shellHex).toBe('#00FF00');
    expect(n.robot('main')!.head.geometry).not.toBe(leadGeo);
  });

  it("ctx yayı oranla büyür, yalnızca %1 adımda yeniden kurulur, ≥%80'de kırmızı", () => {
    const { snap, env } = setup();
    const s = snap.sessions.find((x) => x.id === IDS.busy)!;
    const n = new CrewNode(s.id, env);
    n.sync({ ...s, ctxRatio: 0, ctxMax: 200_000 }, 0, NOW, true);
    expect(n.arc).toBeNull();
    n.sync({ ...s, ctxRatio: 0.5, ctxMax: 200_000 }, 0, NOW, true);
    const a1 = n.arc!;
    expect('#' + a1.material.color.getHexString().toUpperCase()).toBe('#6B7590');
    n.sync({ ...s, ctxRatio: 0.501, ctxMax: 200_000 }, 0, NOW, true);
    expect(n.arc).toBe(a1); // aynı adım: yeniden kurulmaz
    let disposed = false;
    a1.geometry.addEventListener('dispose', () => (disposed = true));
    n.sync({ ...s, ctxRatio: 0.85, ctxMax: 200_000 }, 0, NOW, true);
    expect(disposed).toBe(true);
    expect('#' + n.arc!.material.color.getHexString().toUpperCase()).toBe('#FF7A6B');
  });

  it('etiket: bekleyen için onay süresi; seçimde .sel, beyaz halka ve robot isim etiketleri', () => {
    const { snap, env } = setup();
    const s = snap.sessions.find((x) => x.id === IDS.waiting)!;
    const n = new CrewNode(s.id, env);
    n.sync(s, 0, NOW, true);
    expect(n.label.button.textContent).toContain('onay · 1:35');
    expect(n.label.button.getAttribute('aria-label')).toBe("ödeme akışı session'ını seç, onay bekliyor");
    expect(n.selRing.visible).toBe(false);
    expect(n.robot(null)!.tag.visible).toBe(false);
    n.setSelected(true);
    expect(n.label.button.classList.contains('sel')).toBe(true);
    expect(n.selRing.visible).toBe(true);
    // Seçili ekibin isim etiketleri yalnızca kamera yakınken (uzakta üst üste binerler).
    for (const r of n.robots.values())
      r.step(0, 0.016, null, r.root.position.clone().add(new THREE.Vector3(0, 60, 60)));
    expect([...n.robots.values()].some((r) => r.tag.visible)).toBe(false);
    for (const r of n.robots.values()) r.step(0, 0.016, null, r.root.position.clone().add(new THREE.Vector3(0, 6, 8)));
    expect([...n.robots.values()].every((r) => r.tag.visible)).toBe(true);
    n.label.button.click();
    expect(env.clicks).toEqual([IDS.waiting]);
  });

  it('hover: yalnızca o robotun isim etiketi; isim etiketinde gövde rengi', () => {
    const { snap, env } = setup();
    const s = snap.sessions.find((x) => x.id === IDS.team)!;
    const n = new CrewNode(s.id, env);
    n.sync(s, 0, NOW, true);
    n.setHover('a1');
    expect(n.robot('a1')!.tag.visible).toBe(true);
    expect(n.robot('a2')!.tag.visible).toBe(false);
    const sw = n.robot('a1')!.tag.element.querySelector('.swatch') as HTMLElement;
    expect(sw.style.background).not.toBe('');
    n.setHover(null);
    expect(n.robot('a1')!.tag.visible).toBe(false);
  });

  it('baloncuk: bekleyen ana ajanda onay aracı; çalışan robotta araç adı yalnızca seçili/hover', () => {
    const { snap, env } = setup();
    const w = snap.sessions.find((x) => x.id === IDS.waiting)!;
    const wn = new CrewNode(w.id, env);
    wn.sync(w, 0, NOW, true);
    const bubbles = (g: THREE.Object3D) => {
      const out: string[] = [];
      g.traverse((o) => {
        const e = (o as { element?: HTMLElement }).element;
        if (e?.classList.contains('bubble')) out.push(e.textContent ?? '');
      });
      return out;
    };
    expect(bubbles(wn.group)[0]).toMatch(/^! onay · /);
    const s = snap.sessions.find((x) => x.id === IDS.team)!;
    const n = new CrewNode(s.id, env);
    n.sync(s, 0, NOW, true);
    expect(bubbles(n.group).some((b) => b === 'WebSearch')).toBe(false);
    expect(bubbles(n.group).some((b) => b.startsWith('Bash ·'))).toBe(true); // yavaş araç her zaman
    n.setHover('a1');
    expect(bubbles(n.group)).toContain('WebSearch');
  });

  it('05/02 döngü: yürüyen yeni robot ACTIVE, nefes AMBIENT, hareketi azalt NONE', () => {
    const { snap } = setup();
    const env = fakeEnv({ reducedMotion: false });
    const s = snap.sessions.find((x) => x.id === IDS.idle)!;
    const n = new CrewNode(s.id, env);
    n.sync(s, 0, NOW, true);
    for (let t = 0; t <= 2000; t += 16) n.step(t, 0.016);
    expect(n.step(2016, 0.016)).toBe(DEMAND_AMBIENT); // boşta lider: nefes/göz kırpma
    n.sync({ ...s, agents: [...s.agents, sub(s.id, 'w1')] }, 3000, NOW, false);
    expect(n.robot('w1')!.walking).toBe(true);
    expect(n.step(3100, 0.016)).toBe(DEMAND_ACTIVE);
    for (let t = 3100; t <= 4400; t += 16) n.step(t, 0.016);
    expect(n.robot('w1')!.walking).toBe(false);
    const h = n.robot('w1')!.homeLocal;
    expect(n.robot('w1')!.root.position.x).toBeCloseTo(h.x);

    const still = new CrewNode(s.id, fakeEnv({ reducedMotion: true }));
    still.sync({ ...s, agents: [...s.agents, sub(s.id, 'w1')] }, 0, NOW, false);
    expect(still.robot('w1')!.walking).toBe(false);
    expect(still.step(16, 0.016)).toBe(DEMAND_NONE);
  });

  it('platform adımı: amblem yalnızca decor=true iken döner; kayma ACTIVE', () => {
    const { snap, byId } = setup();
    const p = snap.projects.find((x) => x.id === 'p1demoapp')!;
    const anim = fakeEnv({ reducedMotion: false });
    const pn = new ProjectNode(p.id, anim);
    pn.place(0, 0, 0);
    pn.sync(p, byId, 0, NOW);
    for (let t = 0; t <= 400; t += 16) pn.step(t, 0.016);
    pn.place(14, 0, 1000);
    expect(pn.step(1100, 0.016)).toBe(DEMAND_ACTIVE);
    const rotOf = () => pn.emblem.rotation.y;
    const r0 = rotOf();
    pn.step(2000, 0.25, false);
    expect(rotOf()).toBe(r0);
    pn.step(2250, 0.25, true);
    expect(rotOf()).not.toBe(r0);
  });

  it('powerDown: "ajan bitti" olayıyla gözler hemen söner; snapshot doğrulamazsa 3 sn sonra döner', () => {
    const { snap, env } = setup();
    const s = snap.sessions.find((x) => x.id === IDS.team)!;
    const n = new CrewNode(s.id, env);
    n.sync(s, 0, NOW, true);
    const r = n.robot('a1')!;
    r.powerDown(Date.now());
    expect(r.state).toBe('off');
    r.apply(r.agent, s, NOW, Date.now() + 3100);
    expect(r.state).toBe('work');
  });

  it('uzak kamerada küçük parçalar çizilmez; yakında geri gelir (robot başına çizim çağrısı)', () => {
    const { snap, env } = setup();
    const s = snap.sessions.find((x) => x.id === IDS.idle)!;
    const n = new CrewNode(s.id, env);
    n.sync(s, 0, NOW, true);
    const visibleMeshes = () => {
      let c = 0;
      n.robot(null)!.root.traverseVisible((o) => {
        if (
          (o as THREE.Mesh).isMesh &&
          (o as THREE.Mesh).material &&
          ((o as THREE.Mesh).material as THREE.Material).visible
        )
          c++;
      });
      return c;
    };
    const view = (z: number) => ({ camera: new THREE.Vector3(0, 10, z), face: () => null });
    n.step(0, 0.016, view(5));
    const near = visibleMeshes();
    n.step(16, 0.016, view(80));
    expect(visibleMeshes()).toBe(near - 7); // göz parlaması, ağız, göğüs ışığı, 2 kol yayı, 2 kalça yayı
    n.step(32, 0.016, view(5));
    expect(visibleMeshes()).toBe(near);
  });

  it('kafa konumu (06 parçacıkları) ekip grubuyla birlikte taşınır', () => {
    const { snap, env } = setup();
    const s = snap.sessions.find((x) => x.id === IDS.team)!;
    const n = new CrewNode(s.id, env);
    n.sync(s, 0, NOW, true);
    n.place(5, 2, 0, true);
    n.group.updateMatrixWorld(true);
    const head = n.worldPos(null)!;
    expect(head.x).toBeCloseTo(5, 1);
    expect(head.y).toBeGreaterThan(1);
    expect(n.worldPos('a1')!.distanceTo(head)).toBeGreaterThan(1.5);
    expect(n.worldPos('nope')).toBeNull();
  });
});
