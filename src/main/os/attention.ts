// "Kaç session beni bekliyor?" — Dock rozeti (04/02) ve menü çubuğu (06/01) aynı tanımı kullanır.
// Kaynak motorun BoardTotals.waiting sayacı: gizli projeler ve sona eren session'lar zaten dışarıda.
import type { BoardSnapshot } from '@shared/types';

export function waitingCount(snap: BoardSnapshot): number {
  return snap.totals.waiting;
}

/** Rozet/başlık metni: sıfırsa boş. */
export function attentionText(n: number): string {
  return n > 0 ? String(n) : '';
}
