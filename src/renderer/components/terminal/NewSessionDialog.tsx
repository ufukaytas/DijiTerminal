// "Yeni oturum" (07/01): bilinen bir projede `claude --bg [görev]` başlatır, session haritada belirince panelde açar.
// İzin modu kullanıcının varsayılanıdır; görev metni yalnızca main'e gider, saklanmaz.
import { useEffect, useMemo, useRef, useState } from 'react';
import { BG_TASK_MAX } from '@shared/ipc';
import { waitForBackground } from '../../state/actions';
import { useBoard } from '../../state/board';
import { useTerminals } from '../../state/terminals';
import { pushToast } from '../../state/toast';

export function NewSessionDialog({ onClose }: { onClose(): void }) {
  const projects = useBoard((s) => s.snapshot.projects);
  const focus = useBoard((s) => s.focusProjectId);
  const [extra, setExtra] = useState<string[]>([]);
  const options = useMemo(() => {
    const list = projects.map((p) => ({ root: p.root, label: `${p.name} · ${p.displayPath}` }));
    for (const r of extra) if (!list.some((o) => o.root === r)) list.push({ root: r, label: r });
    return list;
  }, [projects, extra]);
  const initial = projects.find((p) => p.id === focus)?.root ?? options[0]?.root ?? '';
  const [cwd, setCwd] = useState(initial);
  const [task, setTask] = useState('');
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLSelectElement | null>(null);

  // onClose her render'da yeni bir fonksiyon (Header snapshot'larla yeniden çizilir): efekt ona bağlı olursa
  // odak her snapshot'ta proje seçimine geri sıçrar. Odak yalnızca açılışta; Escape güncel onClose'u ref'ten okur.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const pick = async () => {
    const api = window.diji;
    if (!api) return;
    const r = await api.invoke('session:pickProjectDir');
    if (r.ok && r.data) {
      const dir = r.data;
      setExtra((x) => (x.includes(dir) ? x : [...x, dir]));
      setCwd(dir);
    }
  };

  const start = async () => {
    const api = window.diji;
    if (!api || !cwd || busy) return;
    setBusy(true);
    let r: Awaited<ReturnType<typeof api.invoke<'session:newBackground'>>> | null;
    try {
      r = await api.invoke('session:newBackground', cwd, task.trim() || null);
    } catch {
      r = null;
    }
    if (!r || !r.ok) {
      setBusy(false);
      pushToast('error', r && !r.ok ? r.error.message : 'Session başlatılamadı.');
      return;
    }
    onClose();
    pushToast('info', `Arka plan session'ı başlatıldı (${r.data.bgId}).`);
    const sid = await waitForBackground(r.data.bgId);
    if (sid) void useTerminals.getState().openSession(sid);
    else pushToast('warn', `Session haritada görünmedi. Terminalde: claude attach ${r.data.bgId}`);
  };

  return (
    <div className="ns-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="ns"
        role="dialog"
        aria-modal="true"
        aria-label="Yeni arka plan session'ı"
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <h2>Yeni oturum</h2>
        <label className="ns-field">
          <span>Proje</span>
          <div className="ns-row">
            <select ref={first} value={cwd} onChange={(e) => setCwd(e.target.value)} required>
              {options.length === 0 && <option value="">Proje yok — klasör seçin</option>}
              {options.map((o) => (
                <option key={o.root} value={o.root}>
                  {o.label}
                </option>
              ))}
            </select>
            <button type="button" className="btn ghost" onClick={() => void pick()}>
              Klasör seç…
            </button>
          </div>
        </label>
        <label className="ns-field">
          <span>İlk görev (isteğe bağlı)</span>
          <textarea
            value={task}
            maxLength={BG_TASK_MAX}
            rows={3}
            onChange={(e) => setTask(e.target.value)}
            placeholder="Boş bırakırsanız session görev beklemeden açılır."
          />
        </label>
        <p className="note">
          <code>claude --bg</code> ile başlatılır ve bu pencerede açılır. İzin modu Claude Code&apos;daki
          varsayılanınızdır. Sekmeyi kapatmak session&apos;ı durdurmaz.
        </p>
        <div className="ns-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Vazgeç
          </button>
          <button type="submit" className="btn primary" disabled={!cwd || busy} aria-busy={busy || undefined}>
            {busy ? 'Başlatılıyor…' : 'Başlat'}
          </button>
        </div>
      </form>
    </div>
  );
}
