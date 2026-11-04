import { describe, expect, it } from 'vitest';
import { basename, fmtClock, fmtCost, fmtDuration, fmtHotkey, fmtPct, fmtTokens, tildify } from '@renderer/lib/format';

describe('format', () => {
  it('fmtDuration', () => {
    expect(fmtDuration(0)).toBe('0s');
    expect(fmtDuration(42_900)).toBe('42s');
    expect(fmtDuration(242_000)).toBe('4:02');
    expect(fmtDuration(3_790_000)).toBe('1:03:10');
    expect(fmtDuration(-5)).toBe('0s');
    expect(fmtDuration(Number.NaN)).toBe('0s');
  });

  it('fmtClock 24 saat, iki haneli', () => {
    const d = new Date(2026, 9, 28, 7, 5, 9);
    expect(fmtClock(d.getTime())).toBe('07:05:09');
    expect(fmtClock(new Date(2026, 9, 28, 23, 59, 0).getTime())).toBe('23:59:00');
  });

  it('fmtCost', () => {
    expect(fmtCost(1.844)).toBe('$1.84');
    expect(fmtCost(0)).toBe('$0.00');
    expect(fmtCost(0.004)).toBe('<$0.01');
    expect(fmtCost(12)).toBe('$12.00');
  });

  it('fmtTokens', () => {
    expect(fmtTokens(950)).toBe('950');
    expect(fmtTokens(410_200)).toBe('410k');
    expect(fmtTokens(1_200_000)).toBe('1.2M');
    expect(fmtTokens(2_000_000)).toBe('2M');
    expect(fmtTokens(999_700)).toBe('1M');
    expect(fmtTokens(0)).toBe('0');
  });

  it('fmtHotkey: ⌃⌥ varsayılan, aralık dışı null', () => {
    expect(fmtHotkey(1)).toBe('⌃⌥1');
    expect(fmtHotkey(9, '⌘')).toBe('⌘9');
    expect(fmtHotkey(null)).toBeNull();
    expect(fmtHotkey(0)).toBeNull();
    expect(fmtHotkey(10)).toBeNull();
  });

  it('tildify, basename, fmtPct', () => {
    expect(tildify('/Users/demo/Projects/x', '/Users/demo')).toBe('~/Projects/x');
    expect(tildify('/Users/demo', '/Users/demo/')).toBe('~');
    expect(tildify('/Users/demox/a', '/Users/demo')).toBe('/Users/demox/a');
    expect(tildify('/tmp/a', '')).toBe('/tmp/a');
    expect(basename('/a/b/c.ts')).toBe('c.ts');
    expect(basename('/a/b/')).toBe('b');
    expect(basename('c')).toBe('c');
    expect(fmtPct(0.844)).toBe('%84');
    expect(fmtPct(1.3)).toBe('%100');
  });
});
