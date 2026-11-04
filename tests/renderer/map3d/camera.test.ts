import { describe, expect, it } from 'vitest';
import { focusPose, HOME_BOX, HOME_DIR, homePose, lerpAlpha, projectedBox, sceneBounds } from '@renderer/map3d/camera';
import { gridExtent } from '@renderer/map3d/layout';

const dist = (p: { pos: { x: number; y: number; z: number }; target: { x: number; y: number; z: number } }) =>
  Math.hypot(p.pos.x - p.target.x, p.pos.y - p.target.y, p.pos.z - p.target.z);

describe('homePose (sahneye sığdırma)', () => {
  // Harita alanı: tam ekran geniş (1900×920), standart (1600×1000), dar (1100×1000) ve çok dar sütun.
  const ASPECTS = [1900 / 920, 1600 / 1000, 1100 / 1000, 0.6];

  it('bütün sınır noktaları NDC kutusunun içinde ve sahne dikeyde ortalı (1, 4, 12 proje)', () => {
    for (const n of [1, 4, 12]) {
      // 12 proje çok dar sütunda mesafe sınırına (DIST_MAX) dayanır; orada sığma beklenmez.
      for (const a of n === 12 ? ASPECTS.slice(0, 3) : ASPECTS) {
        const pose = homePose(a, gridExtent(n));
        const b = projectedBox(pose, a, sceneBounds(n));
        expect(b.minX).toBeGreaterThan(HOME_BOX.minX - 1e-6);
        expect(b.maxX).toBeLessThan(HOME_BOX.maxX + 1e-6);
        expect(b.minY).toBeGreaterThan(HOME_BOX.minY - 1e-6);
        expect(b.maxY).toBeLessThan(HOME_BOX.maxY + 1e-6);
        // Dikeyde kutunun ortasında; yatayda da.
        expect((b.minY + b.maxY) / 2).toBeCloseTo((HOME_BOX.minY + HOME_BOX.maxY) / 2, 1);
        expect((b.minX + b.maxX) / 2).toBeCloseTo(0, 1);
        // En az bir eksende kutuyu dolduruyor (gereksiz uzak değil).
        const fillY = (b.maxY - b.minY) / (HOME_BOX.maxY - HOME_BOX.minY);
        const fillX = (b.maxX - b.minX) / (HOME_BOX.maxX - HOME_BOX.minX);
        if (dist(pose) > 15.01) expect(Math.max(fillX, fillY)).toBeGreaterThan(0.95);
      }
    }
  });

  it('bakış yönü sabit (HOME_DIR); dar ekranda ve çok projede kamera geri çekilir', () => {
    const p = homePose(1.6, gridExtent(4));
    const d = dist(p);
    expect((p.pos.x - p.target.x) / d).toBeCloseTo(HOME_DIR.x, 6);
    expect((p.pos.y - p.target.y) / d).toBeCloseTo(HOME_DIR.y, 6);
    expect(dist(homePose(1100 / 1000, gridExtent(4)))).toBeGreaterThan(d);
    expect(dist(homePose(1.6, gridExtent(12)))).toBeGreaterThan(d);
    expect(dist(homePose(1.6, gridExtent(1)))).toBeLessThan(d);
  });

  it('geniş ekranda küre ve platformlar birlikte: küre tepesi üst sınırın altında', () => {
    const a = 1900 / 920;
    const b = projectedBox(homePose(a, gridExtent(4)), a, sceneBounds(4).slice(0, 1));
    expect(b.maxY).toBeLessThan(HOME_BOX.maxY);
    expect(b.maxY).toBeGreaterThan(0.5);
  });

  it('proje yoksa tek platform varsayılır; bozuk en-boy oranı 1.5 sayılır', () => {
    expect(homePose(1.6, gridExtent(0))).toEqual(homePose(1.6, gridExtent(1)));
    expect(homePose(Number.NaN, gridExtent(4))).toEqual(homePose(1.5, gridExtent(4)));
  });
});

describe('focusPose', () => {
  it('hedef + (0.18d, 0.78d, 0.82d)', () => {
    const p = focusPose({ x: 1, y: 1.6, z: -2 }, 15);
    expect(p.pos.x).toBeCloseTo(1 + 2.7);
    expect(p.pos.y).toBeCloseTo(1.6 + 11.7);
    expect(p.pos.z).toBeCloseTo(-2 + 12.3);
    expect(p.target).toEqual({ x: 1, y: 1.6, z: -2 });
  });
});

describe('lerpAlpha', () => {
  it('60 Hz bir kare = base', () => {
    expect(lerpAlpha(1 / 60)).toBeCloseTo(0.07, 10);
  });

  it('120 Hz iki kare = 60 Hz bir kare', () => {
    const a = lerpAlpha(1 / 120);
    const twoSteps = 1 - (1 - a) * (1 - a);
    expect(twoSteps).toBeCloseTo(lerpAlpha(1 / 60), 10);
  });

  it('dt 0 → hareket yok', () => {
    expect(lerpAlpha(0)).toBe(0);
  });
});
