import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_WINDOW_STATE,
  debounce,
  ensureVisible,
  loadWindowState,
  parseWindowState,
  saveWindowState,
  WINDOW_STATE_FILE,
  type DisplayInfo,
  type WindowState,
} from '@main/window-state';

const primary: DisplayInfo = { id: 1, workArea: { x: 0, y: 25, width: 1512, height: 920 } };
const right: DisplayInfo = { id: 2, workArea: { x: 1512, y: 0, width: 2560, height: 1415 } };
const left: DisplayInfo = { id: 3, workArea: { x: -1920, y: 0, width: 1920, height: 1055 } };

const st = (o: Partial<WindowState>): WindowState => ({ ...DEFAULT_WINDOW_STATE, ...o });

describe('ensureVisible', () => {
  it('kayıtlı monitör bağlıysa konum korunur', () => {
    const s = st({ x: 1700, y: 100, width: 1600, height: 1000, displayId: 2 });
    expect(ensureVisible(s, [primary, right], primary)).toEqual(s);
  });

  it('monitör çıkarılmışsa birincil ekrana sığdırılıp ortalanır', () => {
    const s = st({ x: 1700, y: 100, width: 2400, height: 1300, displayId: 2 });
    const r = ensureVisible(s, [primary], primary);
    expect(r.displayId).toBe(1);
    expect(r.width).toBe(1512);
    expect(r.height).toBe(920);
    expect(r.x).toBe(0);
    expect(r.y).toBe(25);
  });

  it('yalnızca 100 px altında kesişen pencere kayıp sayılır', () => {
    const edge = st({ x: 1450, y: 100, width: 1200, height: 800, displayId: 1 }); // birincil ile 62 px
    expect(ensureVisible(edge, [primary], primary).x).not.toBe(1450);
    const ok = st({ x: 1300, y: 100, width: 1200, height: 800, displayId: 1 }); // 212 px
    expect(ensureVisible(ok, [primary], primary).x).toBe(1300);
  });

  it('negatif koordinatlı (solda) ikinci monitör geçerlidir', () => {
    const s = st({ x: -1800, y: 40, width: 1600, height: 1000, displayId: 3 });
    expect(ensureVisible(s, [primary, left], primary)).toEqual(s);
  });

  it('kimlik değişmiş ama aynı yerde bir ekran varsa onu kullanır', () => {
    const s = st({ x: 1700, y: 100, width: 1600, height: 1000, displayId: 99 });
    expect(ensureVisible(s, [primary, right], primary).displayId).toBe(2);
  });

  it('konumu olmayan durum (ilk açılış) birincilde ortalanır', () => {
    const r = ensureVisible(st({}), [primary, right], primary);
    expect(r.x).toBe(0);
    expect(r.displayId).toBe(1);
  });
});

describe('parse/load/save', () => {
  let dir = '';
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('bozuk JSON varsayılana döner ve dosyayı yeniden yazar', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diji-win-'));
    fs.writeFileSync(path.join(dir, WINDOW_STATE_FILE), '{bozuk');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(loadWindowState(dir)).toEqual(DEFAULT_WINDOW_STATE);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    expect(JSON.parse(fs.readFileSync(path.join(dir, WINDOW_STATE_FILE), 'utf8'))).toEqual(DEFAULT_WINDOW_STATE);
  });

  it('dosya yoksa varsayılan, kaydedilen geri okunur', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diji-win-'));
    expect(loadWindowState(dir)).toEqual(DEFAULT_WINDOW_STATE);
    const s = st({ x: -10, y: 5, width: 1200, height: 800, displayId: 7, isMaximized: true, alwaysOnTop: true });
    saveWindowState(dir, s);
    expect(loadWindowState(dir)).toEqual(s);
  });

  it('eksik/yanlış alanlar ayıklanır, minimum boyut uygulanır', () => {
    const { state, corrupt } = parseWindowState(
      JSON.stringify({ width: 300, height: 200, x: 'a', isMaximized: 'evet' }),
    );
    expect(corrupt).toBe(false);
    expect(state).toEqual({ width: 900, height: 600, isMaximized: false, alwaysOnTop: false });
    expect(parseWindowState('[]').corrupt).toBe(true);
    expect(parseWindowState('null').corrupt).toBe(true);
  });
});

describe('debounce', () => {
  it('son çağrıdan sonra bir kez çalışır; flush bekleyeni hemen çalıştırır', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 500);
    d.call(1);
    d.call(2);
    vi.advanceTimersByTime(499);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(2);
    d.call(3);
    d.flush();
    expect(fn).toHaveBeenLastCalledWith(3);
    d.flush();
    expect(fn).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
