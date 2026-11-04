// Görüntü kalitesi → piksel oranı ve data-quality izleme.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentQuality, pixelRatioFor, watchQuality } from '@renderer/map3d/quality';
import { applyQuality } from '@renderer/state/settings';

afterEach(() => {
  delete document.documentElement.dataset['quality'];
});

describe('pixelRatioFor', () => {
  it('Yüksek: Retina 2, 3x ekranda da 2 ile sınırlı', () => {
    expect(pixelRatioFor(2, 'high')).toBe(2);
    expect(pixelRatioFor(3, 'high')).toBe(2);
  });
  it('Dengeli: Retina 1.5; 1x ekranda değişmez', () => {
    expect(pixelRatioFor(2, 'balanced')).toBe(1.5);
    expect(pixelRatioFor(1, 'balanced')).toBe(1);
  });
  it('geçersiz devicePixelRatio → 1', () => {
    expect(pixelRatioFor(0, 'high')).toBe(1);
    expect(pixelRatioFor(Number.NaN, 'balanced')).toBe(1);
  });
});

describe('data-quality', () => {
  it('applyQuality kök attribute yazar; varsayılan Yüksek attribute bırakmaz', () => {
    applyQuality('balanced');
    expect(currentQuality()).toBe('balanced');
    applyQuality('high');
    expect(document.documentElement.dataset['quality']).toBeUndefined();
    expect(currentQuality()).toBe('high');
  });
  it('watchQuality yalnızca değer değişince çağırır', async () => {
    const cb = vi.fn();
    const stop = watchQuality(cb);
    applyQuality('balanced');
    await Promise.resolve();
    applyQuality('balanced');
    await Promise.resolve();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith('balanced');
    stop();
    applyQuality('high');
    await Promise.resolve();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
