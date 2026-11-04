// Geçmiş (07/01): haritada olmayan arka plan session'ları — kapatılan, durdurulan, başarısız, 24 saatten eski.
// "Aktif et" session'ı haritaya geri getirir ve gömülü terminalde açar (`claude attach` işçiyi yeniden başlatır).
// Konuşmalar Claude Code'da durur; bu tablo yalnızca `claude agents --json --all` listesini gösterir.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BackgroundHistoryItem } from '@shared/types';
import { useBoard } from '../../state/board';
import { useTerminals } from '../../state/terminals';
import { pushToast } from '../../state/toast';

const REASON: Record<BackgroundHistoryItem['reason'], string> = {
  closed: 'kapatıldı',
  stopped: 'durduruldu',
  failed: 'başarısız',
  old: 'eski',
};

const DATE = new Intl.DateTimeFormat('tr-TR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtDate = (t: number | null): string => (t ? DATE.format(t) : '—');
const shortPath = (p: string): string => p.replace(/^\/Users\/[^/]+/, '~');

export function HistoryDialog({ onClose }: { onClose(): void }) {
  const [items, setItems] = useState<BackgroundHistoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const projects = useBoard((s) => s.snapshot.projects);
  const search = useRef<HTMLInputElement | null>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    search.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    let alive = true;
    const api = window.diji;
    if (api) {
      void api
        .invoke('session:history')
        .then((r) => {
          if (!alive) return;
          if (r.ok) setItems(r.data);
          else setError(r.error.message);
        })
        .catch(() => alive && setError('Geçmiş alınamadı.'));
    }
    return () => {
      alive = false;
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const color = useMemo(() => new Map(projects.map((p) => [p.id, p.color])), [projects]);
  const rows = useMemo(() => {
    const q = query.trim().toLocaleLowerCase('tr');
    if (!items) return [];
    if (!q) return items;
    return items.filter((it) => `${it.name} ${it.title} ${it.cwd} ${it.id}`.toLocaleLowerCase('tr').includes(q));
  }, [items, query]);

  const restore = async (it: BackgroundHistoryItem) => {
    const api = window.diji;
    if (!api || busy) return;
    setBusy(it.id);
    let r;
    try {
      r = await api.invoke('session:restoreBackground', it.id);
    } catch {
      r = null;
    }
    setBusy(null);
    if (!r || !r.ok) {
      pushToast('error', r && !r.ok ? r.error.message : 'Session aktif edilemedi.');
      return;
    }
    closeRef.current();
    useBoard.getState().select(r.data.sessionId);
    void useTerminals.getState().openSession(r.data.sessionId);
  };

  const copy = (it: BackgroundHistoryItem) => {
    void navigator.clipboard
      ?.writeText(`claude attach ${it.id}`)
      .then(() => pushToast('info', `Kopyalandı: claude attach ${it.id}`))
      .catch(() => undefined);
  };

  return (
    <div className="ns-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ns hist" role="dialog" aria-modal="true" aria-label="Session geçmişi">
        <div className="hist-head">
          <h2>Geçmiş</h2>
          <input
            ref={search}
            type="search"
            placeholder="Ad, klasör ya da kimlik ara"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Geçmişte ara"
          />
          <button type="button" className="toast-x" aria-label="Kapat" onClick={onClose}>
            ×
          </button>
        </div>
        {error ? (
          <p className="note">{error}</p>
        ) : !items ? (
          <p className="note">Yükleniyor…</p>
        ) : rows.length === 0 ? (
          <p className="note">
            {items.length === 0 ? 'Haritada olmayan arka plan session’ı yok.' : 'Eşleşen session yok.'}
          </p>
        ) : (
          <div className="hist-scroll">
            <table className="hist-table">
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Klasör</th>
                  <th>Durum</th>
                  <th>Son etkinlik</th>
                  <th aria-label="Eylemler" />
                </tr>
              </thead>
              <tbody>
                {rows.map((it) => (
                  <tr key={it.id}>
                    <td>
                      <div className="hist-name">
                        {it.projectId && color.get(it.projectId) && (
                          <i className="dot sm" style={{ background: color.get(it.projectId) }} aria-hidden="true" />
                        )}
                        <span title={it.name}>{it.name}</span>
                      </div>
                      {it.title && it.title !== it.name && (
                        <div className="hist-sub" title={it.title}>
                          {it.title}
                        </div>
                      )}
                      <div className="hist-sub mono">{it.id}</div>
                    </td>
                    <td className="mono dim" title={it.cwd}>
                      {shortPath(it.cwd)}
                    </td>
                    <td>
                      <span className={`hist-reason r-${it.reason}`}>{REASON[it.reason]}</span>
                    </td>
                    <td className="mono dim">{fmtDate(it.lastTs ?? it.startedAt)}</td>
                    <td className="hist-act">
                      <button
                        type="button"
                        className="btn"
                        disabled={!it.restorable || busy !== null}
                        aria-busy={busy === it.id || undefined}
                        onClick={() => void restore(it)}
                        title="Haritaya geri getir ve uygulamada aç (claude attach)"
                      >
                        {busy === it.id ? 'Açılıyor…' : 'Aktif et'}
                      </button>
                      <button
                        type="button"
                        className="btn ghost"
                        onClick={() => copy(it)}
                        title="claude attach komutunu kopyala"
                      >
                        Kopyala
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="note">
          Yalnızca arka plan session&apos;ları (claude --bg, /bg). Konuşmalar silinmez; &quot;Aktif et&quot;
          session&apos;ı haritaya geri getirir ve burada açar. iTerm2 session&apos;ları için:{' '}
          <code>claude --resume</code>.
        </p>
      </div>
    </div>
  );
}
