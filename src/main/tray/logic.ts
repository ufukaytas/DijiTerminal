// Menü çubuğu modu (06/01) — saf kararlar: ikon durumu, başlık, ipucu ve açılır listenin konumu.
// Electron'a bağlı değildir; tray/controller.ts ve testler kullanır.
import type { BoardSnapshot } from '@shared/types';
import { attentionText, waitingCount } from '../os/attention';

/** Template image renklendirilemez; durum ikonun şekliyle anlatılır (resources/tray). */
export type TrayIconState = 'idle' | 'busy' | 'waiting';

export interface TrayView {
  icon: TrayIconState;
  /** `tray.setTitle` — ikonun sağındaki bekleyen sayısı; sıfırsa boş. */
  title: string;
  tooltip: string;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export const POPOVER_SIZE: Size = { width: 360, height: 480 };
/** İkon ile liste arasındaki boşluk ve ekran kenarından en az uzaklık (px). */
export const POPOVER_GAP = 4;
export const POPOVER_MARGIN = 8;

export function trayView(snap: BoardSnapshot): TrayView {
  const waiting = waitingCount(snap);
  const busy = snap.sessions.filter((s) => s.status === 'busy').length;
  const icon: TrayIconState = waiting > 0 ? 'waiting' : busy > 0 ? 'busy' : 'idle';
  const title = waiting > 0 ? ` ${attentionText(waiting)}` : '';
  let tooltip = 'DijiTerminal';
  if (!snap.booted) tooltip += ' · başlatılıyor…';
  else {
    const parts: string[] = [];
    if (waiting > 0) parts.push(`${waiting} onay bekliyor`);
    if (busy > 0) parts.push(`${busy} çalışıyor`);
    tooltip += parts.length ? ` · ${parts.join(' · ')}` : ' · boşta';
  }
  return { icon, title, tooltip };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/**
 * Açılır listenin sol üst köşesi. macOS'ta ikon ekranın üstündeki menü çubuğundadır: liste ikonun altına,
 * ikona ortalanır; ekranın sağ/sol kenarına taşarsa içeri itilir. İkon çalışma alanının alt yarısındaysa
 * (ör. alt kenardaki görev çubuğu) liste ikonun üstüne açılır. İkon konumu bilinmiyorsa (0×0) sağ üst köşe.
 */
export function popoverPosition(
  tray: Rect,
  size: Size,
  workArea: Rect,
  gap = POPOVER_GAP,
  margin = POPOVER_MARGIN,
): { x: number; y: number } {
  const minX = workArea.x + margin;
  const maxX = workArea.x + workArea.width - size.width - margin;
  const minY = workArea.y + gap;
  const maxY = workArea.y + workArea.height - size.height - margin;
  if (tray.width <= 0 || tray.height <= 0) {
    return { x: Math.round(maxX), y: Math.round(minY) };
  }
  const x = clamp(Math.round(tray.x + tray.width / 2 - size.width / 2), minX, maxX);
  const below = tray.y + tray.height / 2 < workArea.y + workArea.height / 2;
  const y = below ? Math.max(tray.y + tray.height + gap, minY) : tray.y - size.height - gap;
  return { x: Math.round(x), y: Math.round(clamp(y, minY, maxY)) };
}
