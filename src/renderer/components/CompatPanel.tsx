// Uyumluluk paneli (09/01): ne bozuldu, Claude Code sürümü, test edilen aralık; rapor kopyala / issue aç / gizle.
// Rapor main'de üretilir (yalnızca şema); renderer yalnızca gösterir ve IPC çağırır.
import { useEffect, useRef, useState } from 'react';
import type { CompatReport } from '@shared/compat';
import { detailLine, signalLabel, type CompatView } from '../lib/compat';
import { useCompatUi } from '../state/compat';
import { pushToast } from '../state/toast';

export function CompatPanel({ report, view, onClose }: { report: CompatReport; view: CompatView; onClose(): void }) {
  const [busy, setBusy] = useState(false);
  const hide = useCompatUi((s) => s.hide);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const copy = async () => {
    const api = window.diji;
    if (!api || busy) return;
    setBusy(true);
    const r = await api.invoke('compat:copyReport').catch(() => null);
    setBusy(false);
    if (r?.ok) pushToast('info', 'Uyumluluk raporu panoya kopyalandı (yalnızca şema bilgisi).');
    else pushToast('error', r && !r.ok ? r.error.message : 'Rapor kopyalanamadı.');
  };

  const issue = async () => {
    const api = window.diji;
    if (!api || busy) return;
    setBusy(true);
    const r = await api.invoke('compat:openIssue').catch(() => null);
    setBusy(false);
    if (!r?.ok) pushToast('error', r && !r.ok ? r.error.message : 'Issue sayfası açılamadı.');
    else if (r.data.truncated) pushToast('info', 'Rapor uzun: issue gövdesi kısaltıldı, tam rapor panoda.');
  };

  const dismiss = () => {
    hide(report.signals.map((s) => s.id));
    onClose();
  };

  return (
    <div className="ns-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ns compat-panel" role="dialog" aria-modal="true" aria-labelledby="compat-title">
        <div className="hist-head">
          <h2 id="compat-title" className={view.level === 'error' ? 'lv-error' : 'lv-warn'}>
            ⚠ Uyumluluk
          </h2>
          <button type="button" className="toast-x" aria-label="Kapat" onClick={onClose}>
            ×
          </button>
        </div>
        <p className="compat-summary">{view.summary}</p>
        <p className="note">{view.versionLine}</p>
        <table className="hist-table compat-table">
          <thead>
            <tr>
              <th>Sinyal</th>
              <th>Sayı</th>
              <th>Ayrıntı</th>
            </tr>
          </thead>
          <tbody>
            {report.signals.map((s) => (
              <tr key={s.id} className={s.level === 'error' ? 'lv-error' : 'lv-warn'}>
                <td>{signalLabel(s.id)}</td>
                <td className="mono">{s.count}</td>
                <td className="mono">{detailLine(s)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="note">
          Rapor yalnızca şema bilgisi içerir (kayıt tipleri, anahtar adları, sayılar); prompt, dosya yolu ya da kimlik
          içermez. Gönderim yalnızca sizin tıklamanızla, tarayıcınızdan yapılır.
        </p>
        <div className="ns-actions">
          <button type="button" className="btn" onClick={dismiss}>
            Bu oturumda gizle
          </button>
          <div className="spacer" />
          <button type="button" className="btn" onClick={() => void copy()} disabled={busy}>
            Rapor kopyala
          </button>
          <button type="button" className="btn wait" onClick={() => void issue()} disabled={busy}>
            GitHub’da issue aç
          </button>
        </div>
      </div>
    </div>
  );
}
