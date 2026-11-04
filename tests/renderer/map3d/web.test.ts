// Web küresi (03/08): uydu etiketleri, süren web çağrıları, istek/dk, rozet, döngü talebi, hareketi azalt.
import { describe, expect, it } from 'vitest';
import type { BoardSnapshot, LogEntry } from '@shared/types';
import { SHELL } from '@renderer/lib/robotColor';
import * as THREE from 'three';
import { WEB_R } from '@renderer/map3d/geometries';
import { isLand } from '@renderer/map3d/landMask';
import { DEMAND_ACTIVE, DEMAND_AMBIENT, DEMAND_NONE } from '@renderer/map3d/renderLoop';
import {
  liveWebCalls,
  MAX_SATS,
  WEB_N,
  WebGlobe,
  webCallLabel,
  webPerMinute,
  webPointCount,
} from '@renderer/map3d/web';
import { IDS, makeSnapshot } from '../__fixtures__/snapshot';
import { fakeEnv } from './_env';

const NOW = 1_800_000_000_000;

describe('webCallLabel', () => {
  it('WebFetch ve URL → alan adı (www. atılır); arama → tırnaksız sorgu', () => {
    expect(webCallLabel({ name: 'WebFetch', label: 'https://www.example.com/a/b?c=1' })).toBe('example.com');
    expect(webCallLabel({ name: 'WebFetch', label: 'docs.python.org/3/library' })).toBe('docs.python.org');
    expect(webCallLabel({ name: 'WebSearch', label: '"rakip fiyatlandırma 2026"' })).toBe('rakip fiyatlandırma 2026');
    expect(webCallLabel({ name: 'WebSearch', label: 'http://news.ycombinator.com' })).toBe('news.ycombinator.com');
  });
  it('28 karakterde kısalır; boş etiket "web"', () => {
    const l = webCallLabel({ name: 'WebSearch', label: 'çok uzun bir arama sorgusu ki etikete sığmaz' });
    expect(l).toHaveLength(28);
    expect(l.endsWith('…')).toBe(true);
    expect(webCallLabel({ name: 'WebSearch', label: '   ' })).toBe('web');
  });
});

describe('liveWebCalls / webPerMinute', () => {
  it("süren web çağrıları, çağıran ajanın gövde renginde; biten ve sona eren session'lar hariç", () => {
    const s = makeSnapshot(NOW);
    const calls = liveWebCalls(s);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ label: 'rakip fiyatlandırma 2026', color: SHELL.audience });
    const ended: BoardSnapshot = {
      ...s,
      sessions: s.sessions.map((x) => (x.id === IDS.team ? { ...x, status: 'ended' } : x)),
    };
    expect(liveWebCalls(ended)).toEqual([]);
  });
  it('son 60 sn içindeki web aracı log satırları', () => {
    const e = (ts: number, category: LogEntry['category'] = 'web'): LogEntry =>
      ({ id: String(ts), ts, kind: 'tool', category }) as LogEntry;
    expect(webPerMinute({ log: [e(NOW - 1000), e(NOW - 59_000), e(NOW - 61_000), e(NOW - 10, 'read')] }, NOW)).toBe(2);
  });
});

function withWeb(n: number): BoardSnapshot {
  const s = makeSnapshot(NOW);
  const busy = s.sessions.find((x) => x.id === IDS.busy)!;
  s.sessions = s.sessions.map((x) => (x.id === IDS.busy ? x : { ...x, agents: [] }));
  busy.agents = Array.from({ length: n }, (_, i) => ({
    ...busy.agents[0]!,
    id: i === 0 ? 'main' : `w${i}`,
    isMain: i === 0,
    current: {
      id: `c${i}`,
      sessionId: busy.id,
      agentId: i === 0 ? null : `w${i}`,
      name: 'WebFetch',
      category: 'web' as const,
      label: `https://site${i}.dev/x`,
      startedAt: NOW,
    },
  }));
  return s;
}

describe('WebGlobe', () => {
  it('her süren çağrı bir uydu; etiketi alan adı ve ajan rengi noktası; rozet sayıları', () => {
    const env = fakeEnv({ reducedMotion: false });
    let focused = 0;
    const web = new WebGlobe(env, () => focused++);
    web.sync(withWeb(3), NOW);
    expect(web.sats.size).toBe(3);
    const tags = [...web.group.children]
      .flatMap((c) => c.children)
      .map((o) => (o as { element?: HTMLElement }).element)
      .filter((e): e is HTMLElement => Boolean(e?.classList.contains('sattag')));
    expect(tags.map((t) => t.textContent).sort()).toEqual(['site0.dev', 'site1.dev', 'site2.dev']);
    expect(tags.every((t) => (t.querySelector('i') as HTMLElement).style.background !== '')).toBe(true);
    expect(web.badge.textContent).toBe('web0 istek/dk · 3 açık');
    web.badge.click();
    expect(focused).toBe(1);
    expect(env.picks.list.some((o) => (o.userData['pick'] as { kind: string }).kind === 'web')).toBe(true);
  });

  it('uydular varken tam hız; biten uydu ~6 sn sönük kalır (.old), sonra kalkar; boşta istek yok', () => {
    const env = fakeEnv({ reducedMotion: false });
    const web = new WebGlobe(env, () => {});
    expect(web.step(1 / 60, true)).toBe(DEMAND_NONE);
    web.sync(withWeb(1), NOW);
    expect(web.step(1 / 60, true)).toBe(DEMAND_ACTIVE);
    web.sync(withWeb(0), NOW);
    const sat = [...web.sats.values()][0]!;
    expect(sat.tag.element.classList.contains('old')).toBe(true);
    for (let i = 0; i < 5.5 * 60; i++) web.step(1 / 60, true);
    expect(web.sats.size).toBe(1);
    for (let i = 0; i < 2 * 60; i++) web.step(1 / 60, true);
    expect(web.sats.size).toBe(0);
    expect(web.step(1 / 60, true)).toBe(DEMAND_NONE);
  });

  it('ısı: karalar, kenar ve ağ parlar, dönüş hızlanır; döngü boştayken (decor=false) dönmez', () => {
    const web = new WebGlobe(fakeEnv({ reducedMotion: false }), () => {});
    const r0 = web.globe.rotation.y;
    expect(web.step(0.5, false)).toBe(DEMAND_NONE); // sessizken döngüden istek yok
    expect(web.globe.rotation.y).toBe(r0);
    web.step(0.5, true);
    const slow = web.globe.rotation.y - r0;
    expect(web.net.rotation.y).toBeLessThan(0); // ağ ters yönde
    web.setHeat(1);
    expect(web.uniforms.uHeat.value).toBe(1);
    expect(web.rimUniforms.uHeat.value).toBe(1);
    expect(web.atmo.material.opacity).toBeCloseTo(0.28);
    expect(web.links.material.opacity).toBeGreaterThan(0.55);
    const r1 = web.globe.rotation.y;
    expect(web.step(0.5, true)).toBe(DEMAND_AMBIENT); // web etkinliğinde dönüş yavaş hız ister
    expect(web.globe.rotation.y - r1).toBeGreaterThan(slow * 4);
  });

  it('noktalı dünya: kara noktaları ve seyrek okyanus; Dengeli yarı nokta; geometriler paylaşılır', () => {
    expect(isLand(39, 35)).toBe(true); // Anadolu
    expect(isLand(0, -140)).toBe(false); // Pasifik
    expect(webPointCount('high')).toBe(WEB_N);
    expect(webPointCount('balanced')).toBe(WEB_N / 2);
    const a = new WebGlobe(fakeEnv(), () => {}, 'high', 2);
    const b = new WebGlobe(fakeEnv(), () => {}, 'high', 1);
    expect(a.dots.geometry).toBe(b.dots.geometry);
    const g = a.dots.geometry;
    const land = g.getAttribute('land');
    let nLand = 0;
    for (let i = 0; i < land.count; i++) nLand += land.getX(i);
    // ~%29 kara: tüm kara noktaları + okyanusun üçte biri.
    expect(nLand / WEB_N).toBeGreaterThan(0.2);
    expect(nLand / WEB_N).toBeLessThan(0.4);
    expect(land.count - nLand).toBeCloseTo((WEB_N - nLand) / 3, -2);
    expect(g.boundingSphere!.radius).toBeGreaterThan(WEB_R);
    expect(a.uniforms.uScale.value).toBe(2);
    a.setQuality('balanced', 1.5);
    expect(a.dots.geometry.getAttribute('land').count).toBeLessThan(land.count * 0.6);
    expect(a.uniforms.uScale.value).toBe(1.5);
    expect(a.dots.material).toBeInstanceOf(THREE.ShaderMaterial);
    expect(a.rim.material.side).toBe(THREE.BackSide);
    expect(a.links.geometry.getAttribute('position').count).toBeGreaterThan(60);
  });

  it('hareketi azalt: dönme, yörünge ve dalga yok; yalnızca parlaklık', () => {
    const web = new WebGlobe(fakeEnv({ reducedMotion: true }), () => {});
    web.sync(withWeb(2), NOW);
    const pos = [...web.sats.values()].map((s) => s.mesh.position.clone());
    const r0 = web.globe.rotation.y;
    web.setHeat(1);
    expect(web.step(0.5, true)).toBe(DEMAND_NONE);
    expect(web.globe.rotation.y).toBe(r0);
    expect(web.net.rotation.y).toBe(0);
    [...web.sats.values()].forEach((s, i) => expect(s.mesh.position.equals(pos[i]!)).toBe(true));
    web.ping();
    expect(web.pings).toHaveLength(0);
    expect(web.uniforms.uHeat.value).toBe(1); // yalnızca parlaklık
  });

  it('en fazla 12 uydu; rozet tüm açık istekleri sayar', () => {
    const web = new WebGlobe(fakeEnv({ reducedMotion: false }), () => {});
    web.sync(withWeb(20), NOW);
    expect(web.sats.size).toBe(MAX_SATS);
    expect(web.badge.textContent).toContain('20 açık');
  });

  it('dalgalar en fazla 8; 1.4 sn sonra kalkar', () => {
    const web = new WebGlobe(fakeEnv({ reducedMotion: false }), () => {});
    for (let i = 0; i < 12; i++) web.ping();
    expect(web.pings).toHaveLength(8);
    expect(web.step(0.1, true)).toBe(DEMAND_ACTIVE);
    for (let i = 0; i < 20; i++) web.step(0.1, true);
    expect(web.pings).toHaveLength(0);
  });
});
