import { describe, expect, it } from 'vitest';
import type { FileConflict, FileHeat } from '@shared/types';
import { fileSlots, gridExtent, gridLayout, sessionOverflow, sessionSlots } from '@renderer/map3d/layout';

const round = (v: number) => Math.round(v * 1000) / 1000;

describe('gridLayout', () => {
  it('1 proje merkezde', () => {
    expect(gridLayout(1)).toEqual([{ x: 0, z: 0 }]);
  });

  it('4 proje: prototipin 2×2 düzeni (±8.4, ±6.9)', () => {
    expect(gridLayout(4)).toEqual([
      { x: -8.4, z: -6.9 },
      { x: 8.4, z: -6.9 },
      { x: -8.4, z: 6.9 },
      { x: 8.4, z: 6.9 },
    ]);
  });

  it('5 proje: 3×2, son satır soldan', () => {
    const g = gridLayout(5);
    expect(g).toHaveLength(5);
    expect(g.map((p) => round(p.x))).toEqual([-16.8, 0, 16.8, -16.8, 0]);
    expect(new Set(g.map((p) => p.z))).toEqual(new Set([-6.9, 6.9]));
  });

  it('12 proje: 4×3, merkez orijin', () => {
    const g = gridLayout(12);
    const xs = [...new Set(g.map((p) => round(p.x)))];
    const zs = [...new Set(g.map((p) => round(p.z)))];
    expect(xs).toEqual([-25.2, -8.4, 8.4, 25.2]);
    expect(zs).toEqual([-13.8, 0, 13.8]);
    expect(gridExtent(12)).toEqual({ w: 4 * 16.8, d: 3 * 13.8, n: 12 });
  });
});

describe('sessionSlots (robot ekipleri, 03/08)', () => {
  it('1–3: tek sıra z=-0.7, aralık min(5.6, 11.2/(n-1))', () => {
    expect(sessionSlots(1)).toEqual([{ x: 0, z: -0.7 }]);
    expect(sessionSlots(2)).toEqual([
      { x: -2.8, z: -0.7 },
      { x: 2.8, z: -0.7 },
    ]);
    expect(sessionSlots(3).map((s) => s.x)).toEqual([-5.6, 0, 5.6]);
  });

  it('4–6: iki sıra (arka z=-1.6, ön z=+1.2)', () => {
    for (const n of [4, 5, 6]) {
      const s = sessionSlots(n);
      expect(s).toHaveLength(n);
      expect(s.filter((p) => p.z === -1.6)).toHaveLength(Math.ceil(n / 2));
      expect(s.filter((p) => p.z === 1.2)).toHaveLength(Math.floor(n / 2));
    }
  });

  it('7+: ilk 6 ve +N', () => {
    expect(sessionSlots(7)).toHaveLength(6);
    expect(sessionOverflow(7)).toBe(1);
    expect(sessionOverflow(9)).toBe(3);
    expect(sessionOverflow(6)).toBe(0);
  });
});

describe('fileSlots', () => {
  const heat = (path: string): FileHeat => ({ path, projectId: 'p', reads: 1, writes: 1, lastTs: 0, editors: [] });
  const conflict = (path: string): FileConflict => ({ path, projectId: 'p', sessionIds: ['a', 'b'], lastTs: 0 });

  it('çakışanlar önce, hot listede olmasa bile; en fazla 5', () => {
    const files = ['/a', '/b', '/c', '/d', '/e', '/f'].map(heat);
    const s = fileSlots(files, [conflict('/z'), conflict('/c')]);
    expect(s.map((f) => f.path)).toEqual(['/z', '/c', '/a', '/b', '/d']);
    expect(s.filter((f) => f.conflict).map((f) => f.path)).toEqual(['/z', '/c']);
    expect(s.map((f) => f.x)).toEqual([-4.8, -2.4, 0, 2.4, 4.8]);
  });

  it('boş liste', () => {
    expect(fileSlots([], [])).toEqual([]);
  });
});
