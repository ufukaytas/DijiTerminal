// Üst bar uyumluluk rozeti (09/01): warn → sarı, error → kırmızı, ok → gizli. Tıklayınca panel.
import { useState } from 'react';
import { compatView } from '../lib/compat';
import { useBoard } from '../state/board';
import { useCompatUi } from '../state/compat';
import { CompatPanel } from './CompatPanel';

export function CompatBadge() {
  const report = useBoard((s) => s.snapshot.compat);
  const hidden = useCompatUi((s) => s.hidden);
  const [open, setOpen] = useState(false);
  const view = compatView(report, hidden);
  if (!view || !report) return null;
  return (
    <>
      <button
        type="button"
        className={view.level === 'error' ? 'chip compat c-slow' : 'chip compat c-wait'}
        onClick={() => setOpen(true)}
        title={view.summary}
        aria-haspopup="dialog"
      >
        ⚠ Uyumluluk
      </button>
      {open && <CompatPanel report={report} view={view} onClose={() => setOpen(false)} />}
    </>
  );
}
