// Pencere geometrisi: yükleme, kaydetme, görünür alana sığdırma (00/03).
// Electron'a bağımlı değildir; ekran bilgisi parametre olarak gelir, böylece node ortamında test edilir.
import fs from 'node:fs';
import path from 'node:path';

export type WindowState = {
  x?: number;
  y?: number;
  width: number;
  height: number;
  displayId?: number;
  isMaximized: boolean;
  /** 00/04 SettingsStore gelene kadar geçici olarak burada (bkz. brief 11. bölüm). */
  alwaysOnTop: boolean;
};

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Electron `Display`'inin bu modülün kullandığı kısmı. */
export interface DisplayInfo {
  id: number;
  workArea: Rect;
}

export const WINDOW_STATE_FILE = 'window-state.json';
export const MIN_SIZE = { width: 900, height: 600 } as const;
export const DEFAULT_WINDOW_STATE: Readonly<WindowState> = {
  width: 1600,
  height: 1000,
  isMaximized: false,
  alwaysOnTop: false,
};
/** Kayıtlı dikdörtgenin bir ekranla en az bu kadar kesişmesi gerekir; yoksa pencere kayıp sayılır. */
export const MIN_VISIBLE_PX = 100;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** JSON metnini doğrular. Bozuksa `corrupt: true` ile varsayılanı döner. */
export function parseWindowState(raw: string | null): { state: WindowState; corrupt: boolean } {
  if (raw === null) return { state: { ...DEFAULT_WINDOW_STATE }, corrupt: false };
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { state: { ...DEFAULT_WINDOW_STATE }, corrupt: true };
  }
  if (!v || typeof v !== 'object') return { state: { ...DEFAULT_WINDOW_STATE }, corrupt: true };
  const o = v as Record<string, unknown>;
  if (!isNum(o['width']) || !isNum(o['height'])) return { state: { ...DEFAULT_WINDOW_STATE }, corrupt: true };
  const state: WindowState = {
    width: Math.max(MIN_SIZE.width, Math.round(o['width'])),
    height: Math.max(MIN_SIZE.height, Math.round(o['height'])),
    isMaximized: o['isMaximized'] === true,
    alwaysOnTop: o['alwaysOnTop'] === true,
  };
  if (isNum(o['x']) && isNum(o['y'])) {
    state.x = Math.round(o['x']);
    state.y = Math.round(o['y']);
  }
  if (isNum(o['displayId'])) state.displayId = o['displayId'];
  return { state, corrupt: false };
}

export function loadWindowState(dir: string): WindowState {
  const file = path.join(dir, WINDOW_STATE_FILE);
  let raw: string | null;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    raw = null; // ilk açılış
  }
  const { state, corrupt } = parseWindowState(raw);
  if (corrupt) {
    console.warn('[window] window-state.json bozuk, varsayılana dönüldü.');
    saveWindowState(dir, state);
  }
  return state;
}

/** Geçici dosyaya yazıp yeniden adlandırır; yarım yazılmış dosya kalmaz. */
export function saveWindowState(dir: string, state: WindowState): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, WINDOW_STATE_FILE);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    console.warn('[window] pencere durumu kaydedilemedi:', e);
  }
}

export function intersection(a: Rect, b: Rect): { width: number; height: number } {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return { width: Math.max(0, width), height: Math.max(0, height) };
}

const visibleOn = (r: Rect, d: DisplayInfo) => {
  const i = intersection(r, d.workArea);
  return i.width >= MIN_VISIBLE_PX && i.height >= MIN_VISIBLE_PX;
};

/**
 * Kayıtlı dikdörtgen hâlâ bir ekranda görünüyorsa olduğu gibi bırakır.
 * Kayıtlı monitör yoksa ya da dikdörtgen hiçbir çalışma alanıyla ≥100×100 px kesişmiyorsa
 * birincil ekranın çalışma alanına sığdırıp ortalar.
 */
export function ensureVisible(state: WindowState, displays: readonly DisplayInfo[], primary: DisplayInfo): WindowState {
  const hasPos = state.x !== undefined && state.y !== undefined;
  if (hasPos) {
    const rect: Rect = { x: state.x!, y: state.y!, width: state.width, height: state.height };
    const saved = state.displayId === undefined ? undefined : displays.find((d) => d.id === state.displayId);
    const target = saved && visibleOn(rect, saved) ? saved : displays.find((d) => visibleOn(rect, d));
    if (target) return { ...state, displayId: target.id };
  }
  const wa = primary.workArea;
  const width = Math.min(Math.max(state.width, MIN_SIZE.width), wa.width);
  const height = Math.min(Math.max(state.height, MIN_SIZE.height), wa.height);
  return {
    ...state,
    width,
    height,
    x: Math.round(wa.x + (wa.width - width) / 2),
    y: Math.round(wa.y + (wa.height - height) / 2),
    displayId: primary.id,
  };
}

/** Son çağrıdan `ms` sonra bir kez çalışır; `flush` bekleyeni hemen çalıştırır (çıkışta). */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: A | null = null;
  const run = () => {
    timer = null;
    if (pending) {
      const args = pending;
      pending = null;
      fn(...args);
    }
  };
  return {
    call(...args: A) {
      pending = args;
      if (timer) clearTimeout(timer);
      timer = setTimeout(run, ms);
    },
    flush() {
      if (timer) clearTimeout(timer);
      run();
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}
