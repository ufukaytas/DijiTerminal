// 07/01 pencere görünümü: taşıma/boyutlandırma hesabı ve ekrana sığdırma.
import { describe, expect, it } from 'vitest';
import { applyGesture, clampModalRect, defaultModalRect, MODAL_MIN_H, MODAL_MIN_W } from '@renderer/state/terminals';

const R = { x: 100, y: 80, w: 900, h: 600 };

describe('pencere dikdörtgeni', () => {
  it('varsayılan: ortada, en çok 1320×860, küçük ekranda kenar boşluğuyla', () => {
    expect(defaultModalRect(1600, 1000)).toEqual({ x: 140, y: 70, w: 1320, h: 860 });
    expect(defaultModalRect(1000, 700)).toEqual({ x: 16, y: 32, w: 968, h: 636 });
  });
  it('taşıma ve kenar/köşe boyutlandırma; en küçük boyut korunur, karşı kenar sabit kalır', () => {
    expect(applyGesture('move', R, 30, -20)).toEqual({ x: 130, y: 60, w: 900, h: 600 });
    expect(applyGesture('se', R, 50, 40)).toEqual({ x: 100, y: 80, w: 950, h: 640 });
    expect(applyGesture('nw', R, 100, 50)).toEqual({ x: 200, y: 130, w: 800, h: 550 });
    const tiny = applyGesture('w', R, 2000, 0);
    expect(tiny.w).toBe(MODAL_MIN_W);
    expect(tiny.x + tiny.w).toBe(R.x + R.w);
    expect(applyGesture('n', R, 0, 2000).h).toBe(MODAL_MIN_H);
  });
  it('ekrana sığdırma: çubuk her zaman görünür, boyut ekranı aşmaz', () => {
    expect(clampModalRect({ x: -5000, y: -50, w: 900, h: 600 }, 1600, 1000)).toEqual({ x: -820, y: 0, w: 900, h: 600 });
    expect(clampModalRect({ x: 5000, y: 5000, w: 3000, h: 3000 }, 1600, 1000)).toEqual({ x: 1520, y: 960, w: 1600, h: 1000 });
  });
});
