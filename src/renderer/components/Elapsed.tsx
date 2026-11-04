// Saniyede bir ilerleyen süre; yalnızca bu span yeniden render olur (03/01).
import { memo } from 'react';
import { useNow } from '../hooks/useNow';
import { fmtDuration } from '../lib/format';

export interface ElapsedProps {
  since: number;
  /** Bu süreyi aşınca `slow` sınıfı eklenir. */
  slowAfter?: number;
  className?: string;
}

export const Elapsed = memo(function Elapsed({ since, slowAfter, className }: ElapsedProps) {
  const now = useNow(1000);
  const ms = Math.max(0, now - since);
  const slow = slowAfter !== undefined && ms >= slowAfter;
  const cls = [className, slow ? 'slow' : null].filter(Boolean).join(' ') || undefined;
  return (
    <span className={cls} data-slow={slow || undefined}>
      {fmtDuration(ms)}
    </span>
  );
});

/** `since`'ten bu yana `ms` geçti mi? Satırın tamamını boyamak isteyen bileşenler için. */
export function useIsOlder(since: number | null | undefined, ms: number): boolean {
  const now = useNow(1000);
  return since !== null && since !== undefined && now - since >= ms;
}
