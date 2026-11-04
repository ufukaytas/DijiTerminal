// Gömülü terminal paneli (07/01): pencerenin altında yeniden boyutlanabilir panel ya da haritanın üstünde pencere
// (modal), sekmeli. Görünüm değişince xterm örnekleri yeniden kurulmaz (aynı DOM ağacı; yalnızca sınıf değişir).
// Sekmeyi kapatmak yalnızca uygulamanın bağlantısını kapatır; session arka planda çalışmaya devam eder.
// Modal Escape ile kapanmaz: Escape Claude Code'da işi durdurur, terminale gitmeli.
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { STATUS_COLOR } from '@shared/constants';
import { useBoard } from '../../state/board';
import { useSettings } from '../../state/settings';
import { StopSessionButton } from './StopSessionButton';
import {
  clampModalRect,
  defaultModalRect,
  exitText,
  applyGesture,
  MIN_HEIGHT,
  RESIZE_DIRS,
  type Gesture,
  useTerminals,
  type ModalRect,
  type TermTab,
} from '../../state/terminals';
// xterm.js (~440 KB) yalnızca ilk sekme açılınca yüklenir; açılış ve hiç terminal kullanmayan kullanıcı etkilenmez.
const XtermView = lazy(() => import('./XtermView').then((m) => ({ default: m.XtermView })));

const HINT_MS = 3500;

function useViewport(): { w: number; h: number } {
  const [vp, setVp] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const on = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return vp;
}

function TabButton({
  tab,
  active,
  onSelect,
  onClose,
}: {
  tab: TermTab;
  active: boolean;
  onSelect(): void;
  onClose(): void;
}) {
  const session = useBoard((s) => s.snapshot.sessions.find((x) => x.id === tab.sessionId) ?? null);
  const color = useBoard((s) =>
    session ? (s.snapshot.projects.find((p) => p.id === session.projectId)?.color ?? null) : null,
  );
  const name = session?.name ?? tab.sessionId.slice(0, 8);
  const dot =
    tab.status === 'exited' ? STATUS_COLOR.ended : session ? STATUS_COLOR[session.status] : STATUS_COLOR.ended;
  return (
    <div className={active ? 'tt-tab on' : 'tt-tab'} role="tab" aria-selected={active}>
      <button type="button" className="tt-sel" onClick={onSelect} title={name}>
        {color && <i className="dot sm" style={{ background: color }} aria-hidden="true" />}
        <span className="tt-name">{name}</span>
        <i
          className="tt-st"
          style={{ background: dot }}
          aria-label={tab.status === 'exited' ? 'bağlantı kapalı' : (session?.status ?? '')}
        />
      </button>
      <button
        type="button"
        className="tt-x"
        aria-label={`${name} sekmesini kapat`}
        title="Sekmeyi kapat (⇧⌘W) — session arka planda çalışmaya devam eder"
        onClick={onClose}
      >
        ×
      </button>
    </div>
  );
}

export function TerminalDock() {
  const tabs = useTerminals((s) => s.tabs);
  const activeId = useTerminals((s) => s.activeId);
  const open = useTerminals((s) => s.open);
  const pending = useTerminals((s) => s.pendingSessionId);
  const height = useTerminals((s) => s.height);
  const layout = useTerminals((s) => s.layout);
  const modal = layout === 'modal';
  const fontSize = useSettings((s) => s.value?.terminal.fontSize ?? 13);
  const webgl = useSettings((s) => s.value?.renderQuality === 'high');
  const [hint, setHint] = useState<string | null>(null);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [dragH, setDragH] = useState<number | null>(null);
  const modalRect = useTerminals((s) => s.modalRect);
  const vp = useViewport();
  const [liveRect, setLiveRect] = useState<ModalRect | null>(null);
  const rect = clampModalRect(liveRect ?? modalRect ?? defaultModalRect(vp.w, vp.h), vp.w, vp.h);

  const showHint = useCallback((text: string) => {
    setHint(text);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHint(null), HINT_MS);
  }, []);
  useEffect(
    () => () => {
      if (hintTimer.current) clearTimeout(hintTimer.current);
    },
    [],
  );
  const onSuspend = useCallback(
    () => showHint('Ctrl+Z terminale gönderilmez. Sekmeyi kapatmak için ⇧⌘W; session arka planda devam eder.'),
    [showHint],
  );

  const onDragStart = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startY = e.clientY;
    const start = height;
    const max = Math.round(window.innerHeight * 0.8);
    const move = (ev: PointerEvent) => setDragH(Math.min(max, Math.max(MIN_HEIGHT, start + (startY - ev.clientY))));
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDragH(null);
      useTerminals.getState().setHeight(Math.min(max, Math.max(MIN_HEIGHT, start + (startY - ev.clientY))));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /** Pencereyi taşı (çubuktan) ya da boyutlandır (kenar/köşe). Bırakınca konum ve boyut hatırlanır. */
  const startGesture = (g: Gesture, e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    if (g === 'move' && (e.target as HTMLElement).closest('button, select, input')) return;
    e.preventDefault();
    const sx = e.clientX;
    const sy = e.clientY;
    const start = rect;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    document.body.classList.add('tdock-gesture');
    const next = (ev: PointerEvent) => clampModalRect(applyGesture(g, start, ev.clientX - sx, ev.clientY - sy), vw, vh);
    const move = (ev: PointerEvent) => setLiveRect(next(ev));
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('tdock-gesture');
      setLiveRect(null);
      useTerminals.getState().setModalRect(next(ev));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  if (tabs.length === 0 && !pending) return null;
  const st = useTerminals.getState();
  const active = tabs.find((t) => t.termId === activeId) ?? null;

  return (
    <div className={`tdock-wrap ${layout}${open ? '' : ' hidden'}`}>
      {modal && <div className="tdock-backdrop" onMouseDown={() => st.setOpen(false)} aria-hidden="true" />}
      <section
        className="tdock"
        style={
          modal
            ? { left: rect.x, top: rect.y, width: rect.w, height: rect.h }
            : { height: open ? (dragH ?? height) : undefined }
        }
        aria-label="Terminal"
        role={modal ? 'dialog' : undefined}
        aria-modal={modal || undefined}
      >
        {!modal && (
          <div
            className="tdock-grip"
            onPointerDown={onDragStart}
            role="separator"
            aria-orientation="horizontal"
            aria-label="Terminal yüksekliği"
          />
        )}
        <div
          className="tdock-bar"
          role="tablist"
          onPointerDown={modal ? (e) => startGesture('move', e) : undefined}
          onDoubleClick={
            modal
              ? (e) => {
                  if (!(e.target as HTMLElement).closest('button')) st.setModalRect(null);
                }
              : undefined
          }
          title={modal ? 'Sürükleyerek taşıyın · çift tıklayınca ortalanır' : undefined}
        >
          {tabs.map((t) => (
            <TabButton
              key={t.termId}
              tab={t}
              active={t.termId === activeId}
              onSelect={() => st.activate(t.termId)}
              onClose={() => st.close(t.termId)}
            />
          ))}
          {pending && <span className="tt-pending">Bağlanıyor…</span>}
          <div className="spacer" />
          {hint && <span className="tdock-hint">{hint}</span>}
          {active && <StopSessionButton key={active.sessionId} sessionId={active.sessionId} compact />}
          <button
            type="button"
            className="btn icon tdock-min"
            aria-label={modal ? 'Alttaki panele al' : 'Pencere olarak aç'}
            title={modal ? 'Alttaki panele al (⇧⌘J)' : 'Haritanın üstünde pencere olarak aç (⇧⌘J)'}
            onClick={() => st.setLayout(modal ? 'dock' : 'modal')}
          >
            {modal ? (
              <svg
                width="13"
                height="13"
                viewBox="0 0 16 16"
                aria-hidden="true"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
              >
                <rect x="1.5" y="2" width="13" height="12" rx="2" />
                <path d="M1.5 9.5h13" />
              </svg>
            ) : (
              <svg
                width="13"
                height="13"
                viewBox="0 0 16 16"
                aria-hidden="true"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
              >
                <rect x="3" y="3" width="10" height="10" rx="2" />
                <path d="M1 6V1h5M15 10v5h-5" />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="btn icon tdock-min"
            aria-label={modal ? 'Pencereyi kapat' : 'Paneli gizle'}
            title={modal ? "Kapat (⌘J) — sekmeler ve session'lar açık kalır" : 'Paneli gizle (⌘J)'}
            onClick={() => st.setOpen(false)}
          >
            {modal ? '×' : '▾'}
          </button>
        </div>
        <div className="tdock-body">
          <Suspense fallback={<span className="tt-pending">Terminal yükleniyor…</span>}>
            {tabs.map((t) => (
              <XtermView
                key={t.termId}
                termId={t.termId}
                active={open && t.termId === activeId}
                fontSize={fontSize}
                webgl={webgl}
                onSuspendKey={onSuspend}
              />
            ))}
          </Suspense>
          {active && active.status === 'exited' && (
            <div className="tdock-exit" role="status">
              <span>{exitText(active.exitReason)}</span>
              {active.exitReason !== 'not-found' && (
                <button type="button" className="btn" onClick={() => void st.reconnect(active.termId)}>
                  {active.exitReason === 'taken-over' ? 'Buraya geri al' : 'Yeniden bağlan'}
                </button>
              )}
              <button type="button" className="btn ghost" onClick={() => st.close(active.termId)}>
                Kapat
              </button>
            </div>
          )}
        </div>
      </section>
      {/* Tutamaçlar pencerenin dışında bir çerçevede: section'ın overflow/border-radius kırpması tıklamayı yutmasın. */}
      {modal && (
        <div className="tdock-frame" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}>
          {RESIZE_DIRS.map((d) => (
            <div key={d} className={`tdock-rz rz-${d}`} onPointerDown={(e) => startGesture(d, e)} aria-hidden="true" />
          ))}
        </div>
      )}
    </div>
  );
}

/** Panel gizliyken alt kenarda küçük bir çubuk: açık sekme sayısı, tıklayınca açılır. */
export function TerminalPeek() {
  const count = useTerminals((s) => s.tabs.length);
  const open = useTerminals((s) => s.open);
  if (open || count === 0) return null;
  return (
    <button
      type="button"
      className="tpeek"
      onClick={() => useTerminals.getState().setOpen(true)}
      title="Terminali aç (⌘J)"
    >
      ▴ Terminal · {count} sekme
    </button>
  );
}
