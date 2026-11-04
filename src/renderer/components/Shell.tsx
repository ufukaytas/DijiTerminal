// Üç sütunlu kabuk (00/03, 03/01): sol Seçili Session + Workers (eşit yükseklik), orta harita, sağ session.log.
import { useSyncExternalStore, type ReactNode } from 'react';
import { currentReducedMotion, onReducedMotionChange } from '../map3d/reducedMotion';

const subscribeMotion = (cb: () => void): (() => void) => onReducedMotionChange(() => cb());

/**
 * "Hareketi azalt" kararı: `<html data-motion>` (ayarlar, 00/04: 'reduce' | 'full') varsa o,
 * yoksa sistemin `prefers-reduced-motion` tercihi. İkisinden biri değişince yeniden render olur.
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeMotion, currentReducedMotion, () => false);
}

export interface ShellProps {
  header: ReactNode;
  detail: ReactNode;
  workers: ReactNode;
  map: ReactNode;
  log: ReactNode;
  /** 07/01: gömülü terminal paneli (altta; sekme yoksa hiç yer kaplamaz). */
  dock?: ReactNode;
}

export function Shell({ header, detail, workers, map, log, dock }: ShellProps) {
  const reduced = useReducedMotion();
  return (
    <div className="app" data-motion={reduced ? 'reduced' : 'full'}>
      {header}
      <main className="stage">
        <div className="side">
          {detail}
          {workers}
        </div>
        <div className="scene">{map}</div>
        {log}
      </main>
      {dock}
    </div>
  );
}
