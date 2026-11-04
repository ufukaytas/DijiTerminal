import { describe, expect, it } from 'vitest';
import { costOf, ctxMaxFor, PRICES, priceFor, savedOf, shortModel } from '@main/engine/pricing';

const M = 1_000_000;

describe('pricing', () => {
  it.each(Object.keys(PRICES))('%s: tarihli model kimliği kendi satırına düşer', (key) => {
    expect(priceFor(`${key}-20260101`)).toBe(PRICES[key]);
  });

  it('en uzun önek kazanır: opus-5-5 opus-5\'e düşmez', () => {
    expect(priceFor('claude-opus-5-5')?.in).toBe(4);
    expect(priceFor('claude-opus-5')?.in).toBe(5);
    expect(priceFor('claude-fable-5-1-x')?.cr).toBe(0.25);
    expect(priceFor('claude-fable-5')?.cr).toBe(1);
  });

  it('bilinmeyen model → null, maliyet 0', () => {
    expect(priceFor('gpt-x')).toBeNull();
    expect(priceFor(null)).toBeNull();
    expect(costOf('<synthetic>', { input_tokens: 1000 })).toBe(0);
    expect(ctxMaxFor('gpt-x')).toBeNull();
  });

  it('girdi, çıktı ve cache okuma', () => {
    expect(costOf('claude-opus-5-5', { input_tokens: M, output_tokens: M, cache_read_input_tokens: M })).toBeCloseTo(4 + 20 + 0.2, 9);
  });

  it('5 dk cache yazımı ×1.25, 1 saatlik ×2', () => {
    const c = costOf('claude-sonnet-5', {
      cache_creation_input_tokens: 3 * M,
      cache_creation: { ephemeral_1h_input_tokens: M },
    });
    expect(c).toBeCloseTo(2 * M * 2 * 1.25 / M + 1 * 2 * 2, 9); // 2M×$2×1.25 + 1M×$2×2
  });

  it('long eşiği aşılınca long fiyatları (haiku-5-5)', () => {
    const short = costOf('claude-haiku-5-5', { input_tokens: 100_000, output_tokens: 1000 });
    expect(short).toBeCloseTo((100_000 * 0.1 + 1000 * 0.5) / M, 12);
    const long = costOf('claude-haiku-5-5', { input_tokens: 90_000, cache_read_input_tokens: 20_000, output_tokens: 1000 });
    expect(long).toBeCloseTo((90_000 * 0.5 + 20_000 * 0.05 + 1000 * 2.5) / M, 12);
  });

  it('fast hız ×2', () => {
    const base = costOf('claude-opus-5-5', { input_tokens: 1000, output_tokens: 1000 });
    expect(costOf('claude-opus-5-5', { input_tokens: 1000, output_tokens: 1000, speed: 'fast' })).toBeCloseTo(base * 2, 12);
  });

  it('savedOf: cache okumanın tam fiyata göre kazancı', () => {
    expect(savedOf('claude-opus-5-5', { cache_read_input_tokens: M })).toBeCloseTo(3.8, 9);
  });

  it('ctxMaxFor: tablo değeri; 0 → null', () => {
    expect(ctxMaxFor('claude-opus-5-5-20260101')).toBe(1e6);
    expect(ctxMaxFor('claude-haiku-4-5')).toBe(2e5);
    expect(ctxMaxFor('claude-haiku-5-5')).toBeNull();
  });

  it('shortModel', () => {
    expect(shortModel('claude-opus-5-5-20260101')).toBe('opus 5.5');
  });
});
