import { describe, expect, it } from 'vitest';

describe('smoke', () => {
  it('vitest node ortamında çalışıyor', () => {
    expect(1 + 1).toBe(2);
    expect(typeof process.versions.node).toBe('string');
  });
});
