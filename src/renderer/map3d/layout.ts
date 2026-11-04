// 3B harita yerleşim hesapları (03/05 Bölüm 4). Saf fonksiyonlar: three'ye bağımlı değil, birim testli.
import type { FileConflict, FileHeat } from '@shared/types';

export interface XZ {
  x: number;
  z: number;
}

/** Platform aralığı (prototip 2×2 düzeni). */
export const GRID_STEP_X = 16.8;
export const GRID_STEP_Z = 13.8;
/** Bir platformda gösterilen en fazla session ekibi; fazlası "+N" etiketiyle. */
export const MAX_SESSIONS_SHOWN = 6;
export const MAX_FILES_SHOWN = 5;
export const FILE_SPACING = 2.4;
export const FILE_Z = -3.1;

export function gridDims(n: number): { cols: number; rows: number } {
  if (n <= 0) return { cols: 0, rows: 0 };
  const cols = Math.ceil(Math.sqrt(n));
  return { cols, rows: Math.ceil(n / cols) };
}

/** `cols = ceil(sqrt(N))`, `rows = ceil(N/cols)`, merkez orijin; satır satır soldan sağa. */
export function gridLayout(n: number): XZ[] {
  const { cols, rows } = gridDims(n);
  const out: XZ[] = [];
  for (let i = 0; i < n; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    out.push({ x: (c - (cols - 1) / 2) * GRID_STEP_X, z: (r - (rows - 1) / 2) * GRID_STEP_Z });
  }
  return out;
}

/** Grid'in kapladığı alan ve proje sayısı (kamera ev konumu için, 03/07). */
export interface GridExtent {
  w: number;
  d: number;
  /** Gösterilen proje sayısı (en az 1). */
  n: number;
}

export function gridExtent(n: number): GridExtent {
  const k = Math.max(1, n);
  const { cols, rows } = gridDims(k);
  return { w: cols * GRID_STEP_X, d: rows * GRID_STEP_Z, n: k };
}

function row(n: number, z: number): XZ[] {
  if (n <= 0) return [];
  const step = n === 1 ? 0 : Math.min(5.6, 11.2 / (n - 1));
  return Array.from({ length: n }, (_, i) => ({ x: (i - (n - 1) / 2) * step, z }));
}

/**
 * Platform üzerindeki session ekiplerinin lider pedleri (yerel koordinat).
 * n ≤ 3 tek sıra z=-0.7 (dosya sırası arkada, boyalı ad önde); 4–6 iki sıra (z=-1.6 arka, +1.2 ön);
 * 6'dan fazlası için yalnızca ilk 6.
 */
export function sessionSlots(n: number): XZ[] {
  const k = Math.min(Math.max(0, n), MAX_SESSIONS_SHOWN);
  if (k <= 3) return row(k, -0.7);
  const back = Math.ceil(k / 2);
  return [...row(back, -1.6), ...row(k - back, 1.2)];
}

/** Gösterilemeyen session sayısı ("+N"). */
export function sessionOverflow(n: number): number {
  return Math.max(0, n - MAX_SESSIONS_SHOWN);
}

/** Dosya küpleri: çakışanlar önce (hot listede olmasalar da), en fazla 5, x ekseninde 2.4 aralık. */
export function fileSlots(
  files: readonly FileHeat[],
  conflicts: readonly FileConflict[],
): { path: string; x: number; conflict: boolean }[] {
  const conflictPaths = new Set(conflicts.map((c) => c.path));
  const ordered: string[] = [];
  for (const c of conflicts) if (!ordered.includes(c.path)) ordered.push(c.path);
  for (const f of files) if (!ordered.includes(f.path)) ordered.push(f.path);
  const shown = ordered.slice(0, MAX_FILES_SHOWN);
  const n = shown.length;
  return shown.map((path, i) => ({ path, x: (i - (n - 1) / 2) * FILE_SPACING, conflict: conflictPaths.has(path) }));
}
