// Yapışkan session numaraları (04/03 Bölüm 4).
import { describe, expect, it } from 'vitest';
import { HotkeyPool } from '@main/engine/hotkeys';

const c = (id: string, startedAt: number, supersedes: string | null = null) => ({ id, startedAt, supersedes });
const obj = (m: Map<string, number>) => Object.fromEntries(m);

describe('HotkeyPool', () => {
  it('ilk dağıtım startedAt sırasıyla 1\'den', () => {
    const p = new HotkeyPool();
    expect(obj(p.assign([c('b', 20), c('a', 10), c('c', 30)]))).toEqual({ a: 1, b: 2, c: 3 });
  });

  it('yapışkan: biri kapanınca diğerlerinin numarası değişmez; yeni gelen boşluğu doldurur', () => {
    const p = new HotkeyPool();
    p.assign([c('a', 10), c('b', 20), c('c', 30)]);
    expect(obj(p.assign([c('a', 10), c('c', 30)]))).toEqual({ a: 1, c: 3 });
    expect(obj(p.assign([c('a', 10), c('c', 30), c('d', 40)]))).toEqual({ a: 1, c: 3, d: 2 });
  });

  it('10. canlı session numarasız', () => {
    const p = new HotkeyPool();
    const live = Array.from({ length: 10 }, (_, i) => c(`s${i}`, i));
    const m = p.assign(live);
    expect(m.size).toBe(9);
    expect(m.has('s9')).toBe(false);
    expect(p.get('s9')).toBeNull();
  });

  it('supersedes: devam eden session eski numarayı devralır', () => {
    const p = new HotkeyPool();
    p.assign([c('a', 10), c('b', 20)]);
    expect(obj(p.assign([c('a', 10), c('b2', 25, 'b')]))).toEqual({ a: 1, b2: 2 });
  });

  it('eski session hâlâ canlıysa devralma yok', () => {
    const p = new HotkeyPool();
    p.assign([c('a', 10)]);
    expect(obj(p.assign([c('a', 10), c('a2', 20, 'a')]))).toEqual({ a: 1, a2: 2 });
  });

  it('reset', () => {
    const p = new HotkeyPool();
    p.assign([c('a', 10)]);
    p.reset();
    expect(p.get('a')).toBeNull();
  });
});
