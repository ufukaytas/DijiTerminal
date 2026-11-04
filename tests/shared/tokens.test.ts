// tokens.css ↔ constants.ts renk eşitliği (00/03). CSS dosyası okunduğu için node ortamında.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CATEGORY_COLOR, SLOW_COLOR, STATUS_COLOR } from '@shared/constants';

const css = fs.readFileSync(path.join(__dirname, '../../src/renderer/styles/tokens.css'), 'utf8');
const token = (name: string) => {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
  return m?.[1]?.toUpperCase() ?? null;
};

describe('tokens.css', () => {
  it('durum renkleri constants.ts ile aynı', () => {
    expect(token('busy')).toBe(STATUS_COLOR.busy.toUpperCase());
    expect(token('wait')).toBe(STATUS_COLOR.waiting.toUpperCase());
    expect(token('idle')).toBe(STATUS_COLOR.idle.toUpperCase());
    expect(token('ended')).toBe(STATUS_COLOR.ended.toUpperCase());
    expect(token('slow')).toBe(SLOW_COLOR.toUpperCase());
  });

  it("her araç kategorisinin token'ı var ve aynı renkte", () => {
    for (const [cat, color] of Object.entries(CATEGORY_COLOR)) {
      expect(token(cat), cat).toBe(color.toUpperCase());
    }
  });
});
