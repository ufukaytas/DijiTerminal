import { describe, expect, it } from 'vitest';
import { SKIP_TYPES, shouldSkip, stripLargeData } from '../../../src/main/engine/transcript/prefilter';

const b = (s: string) => Buffer.from(s, 'utf8');

describe('shouldSkip', () => {
  it.each(SKIP_TYPES)('%s atlanır', (t) => {
    expect(shouldSkip(b(`{"type":"${t}","uuid":"u"}`))).toBe(true);
  });
  it('user/assistant/system atlanmaz', () => {
    for (const t of ['user', 'assistant', 'system', 'summary']) expect(shouldSkip(b(`{"type":"${t}"}`))).toBe(false);
  });
  it('yalnızca ilk 600 byte bakılır', () => {
    const pad = 'x'.repeat(700);
    expect(shouldSkip(b(`{"type":"user","note":"${pad}","inner":{"type":"progress"}}`))).toBe(false);
    expect(shouldSkip(b(`{"pad":"${'x'.repeat(500)}","type":"progress"}`))).toBe(true);
  });
});

describe('stripLargeData', () => {
  it('32 KB ve altı satır olduğu gibi döner', () => {
    const line = b(`{"type":"user","data":"${'A'.repeat(20_000)}"}`);
    expect(stripLargeData(line)).toBe(line);
  });
  it('büyük data değerleri boşaltılır, kısa olanlar kalır', () => {
    const big = 'Q'.repeat(40_000);
    const line = b(`{"a":{"data":"${big}"},"b":{"data":"short"},"c":{"data":"${big}"},"z":1}`);
    const out = JSON.parse(stripLargeData(line).toString('utf8')) as Record<string, { data: string }>;
    expect(out['a']?.data).toBe('');
    expect(out['b']?.data).toBe('short');
    expect(out['c']?.data).toBe('');
    expect((out as unknown as { z: number }).z).toBe(1);
  });
  it('data anahtarı yoksa satır değişmez', () => {
    const line = b(`{"type":"assistant","text":"${'t'.repeat(40_000)}"}`);
    expect(stripLargeData(line).equals(line)).toBe(true);
  });
  it('2 MB base64 satır hızla küçülür', () => {
    const line = b(`{"type":"user","message":{"content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"${'iVBOR'.repeat(420_000)}"}}]}}`);
    const t0 = performance.now();
    const out = stripLargeData(line);
    expect(performance.now() - t0).toBeLessThan(200);
    expect(out.length).toBeLessThan(300);
    expect(() => JSON.parse(out.toString('utf8'))).not.toThrow();
  });
});

describe('shouldSkip eşdeğerliği (05/02 hızlandırma)', () => {
  // Eski uygulama: ilk 600 byte'ta her tip için `"type":"<tip>"` araması.
  const naive = (line: Buffer): boolean => {
    const head = line.subarray(0, 600);
    return SKIP_TYPES.some((t) => head.indexOf(Buffer.from(`"type":"${t}"`)) !== -1);
  };
  let seed = 11;
  const rnd = (k: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % k;
  };
  const parts = ['"type":"', ...SKIP_TYPES, 'user', 'assistant', 'text', '"', ',', '{', '}', 'x'.repeat(50), 'progres', 'ü'];

  it('rastgele 5000 satırda eski taramayla aynı karar (600 byte sınırı dahil)', () => {
    for (let i = 0; i < 5000; i++) {
      let s = '';
      const n = rnd(60);
      for (let k = 0; k < n; k++) s += parts[rnd(parts.length)];
      const line = Buffer.from(s);
      expect(shouldSkip(line), s).toBe(naive(line));
    }
    for (let pad = 570; pad < 610; pad++) {
      const line = Buffer.from(`{"x":"${'a'.repeat(pad)}","type":"progress","y":1}`);
      expect(shouldSkip(line)).toBe(naive(line));
    }
  });
});
