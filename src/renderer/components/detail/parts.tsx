// Seçili session panelinin parçaları (03/02). Her biri memo'lu; zamanla değişen metinler <Elapsed> içinde.
import { memo, useEffect, useRef, useState } from 'react';
import { STATUS_COLOR, THRESHOLDS } from '@shared/constants';
import { focusLabel } from '@shared/terminalApp';
import type { ProjectView, SessionFlag, SessionStatus, SessionView, TerminalApp } from '@shared/types';
import { fmtCost, fmtHotkey, fmtPct, fmtTokens } from '../../lib/format';
import { openInApp } from '../../state/actions';
import { StopSessionButton } from '../terminal/StopSessionButton';
import { useTerminals } from '../../state/terminals';
import { pushToast } from '../../state/toast';
import { Elapsed } from '../Elapsed';

export const STATUS_LABEL: Record<SessionStatus, string> = {
  busy: 'çalışıyor',
  waiting: 'onay bekliyor',
  idle: 'boşta',
  ended: 'sona erdi',
};

export const DetailHeader = memo(function DetailHeader({ name, status }: { name: string; status: SessionStatus }) {
  return (
    <div className="d-head">
      <i className="dot" style={{ background: STATUS_COLOR[status] }} aria-hidden="true" />
      <h3 title={name}>{name}</h3>
      <span className={`pill ${status}`}>{STATUS_LABEL[status]}</span>
    </div>
  );
});

const BG_STATE_TEXT: Record<string, string> = { done: 'tamamlandı', failed: 'başarısız', blocked: 'girdi bekliyor', stopped: 'durduruldu' };

/** 07/01: arka plan session'ı satırı — rozet ve `claude attach` kimliği (iTerm2'den bağlanmak için). */
export const BackgroundLine = memo(function BackgroundLine({ id, state }: { id: string; state: string | null }) {
  return (
    <div className="d-bg" title="Arka plan session'ı (claude --bg): uygulamada açılabilir">
      <span className="bg-badge">ARKA PLAN</span>
      <span className="mono dim">claude attach {id}</span>
      {state && state !== 'running' && <span className="dim">· {BG_STATE_TEXT[state] ?? state}</span>}
    </div>
  );
});

export const ProjectLine = memo(function ProjectLine({
  project,
  worktree,
}: {
  project: ProjectView | null;
  worktree: string | null;
}) {
  if (!project) return null;
  return (
    <div className="d-proj" title={project.root}>
      <i className="dot sm" style={{ background: project.color }} aria-hidden="true" />
      {project.name} · {project.displayPath}
      {worktree && <> · worktree: {worktree}</>}
    </div>
  );
});

export const PromptLine = memo(function PromptLine({ prompt, title }: { prompt: string; title: string }) {
  const text = prompt || title;
  if (!text) return null;
  return (
    <p className="d-prompt" title={text}>
      {prompt ? `“${prompt}”` : title}
    </p>
  );
});

export const WaitingBox = memo(function WaitingBox({ session }: { session: SessionView }) {
  if (session.status !== 'waiting') return null;
  const w = session.waitingFor;
  return (
    <div className="d-wait" role="status">
      <span>
        Onayınızı bekliyor · <Elapsed since={w?.since ?? session.statusSince} />
      </span>
      {w && (
        <code title={w.label}>
          {w.tool} · {w.label}
        </code>
      )}
    </div>
  );
});

export const MetaList = memo(function MetaList({ session }: { session: SessionView }) {
  return (
    <dl className="d-meta">
      <dt>Model</dt>
      <dd>
        {session.model || '—'}
        {session.effort ? ` · ${session.effort}` : ''}
      </dd>
      <dt>Branch</dt>
      <dd>{session.branch ?? '—'}</dd>
      <dt>Süre</dt>
      <dd>
        <Elapsed since={session.startedAt} />
      </dd>
      <dt>Maliyet</dt>
      <dd>{fmtCost(session.costUsd)} bugün</dd>
      {(session.cpuPct !== null || session.memMb !== null) && (
        <>
          <dt>CPU/RAM</dt>
          <dd>
            {session.cpuPct !== null ? `%${Math.round(session.cpuPct)}` : '—'} ·{' '}
            {session.memMb !== null ? `${Math.round(session.memMb)} MB` : '—'}
          </dd>
        </>
      )}
    </dl>
  );
});

export const ContextBar = memo(function ContextBar({
  tokens,
  max,
  ratio,
}: {
  tokens: number;
  max: number;
  ratio: number;
}) {
  const warn = ratio >= THRESHOLDS.ctxWarnRatio;
  return (
    <div className={warn ? 'ctx warn' : 'ctx'}>
      <div className="ctx-l">
        <span>context</span>
        <span>{max > 0 ? `${fmtTokens(tokens)} · ${fmtPct(ratio)}` : `${fmtTokens(tokens)} token`}</span>
      </div>
      {max > 0 && (
        <div
          className="ctx-b"
          role="meter"
          aria-label="context doluluğu"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(ratio * 100)}
        >
          <div style={{ width: `${Math.min(100, ratio * 100)}%` }} />
        </div>
      )}
    </div>
  );
});

const FLAG_LABEL: Record<SessionFlag, string> = {
  'slow-tool': 'yavaş araç',
  'ctx-80': 'ctx %80+',
  'loop-suspect': 'döngü?',
  conflict: 'çakışma',
};

export const FlagChips = memo(
  function FlagChips({ flags }: { flags: SessionFlag[] }) {
    if (flags.length === 0) return null;
    return (
      <div className="flags">
        {flags.map((f) => (
          <span key={f} className={`flag f-${f}`}>
            {FLAG_LABEL[f]}
          </span>
        ))}
      </div>
    );
  },
  (a, b) => a.flags.join() === b.flags.join(),
);

type BtnState = 'idle' | 'pending' | 'done';
const DONE_MS = 1500;

/** "iTerm2 sekmesine git" / "Terminal sekmesine git" ve "Finder'da aç". Snapshot akarken DOM düğümleri yerinde kalır (hover/odak korunur). */
export const Actions = memo(function Actions({
  sessionId,
  projectId,
  waiting,
  hasTerminal,
  terminalApp = null,
  hotkey,
  ended,
  background = false,
}: {
  sessionId: string;
  projectId: string;
  waiting: boolean;
  hasTerminal: boolean;
  /** Session'ın bağlı olduğu terminal uygulaması; düğme etiketi buna göre. */
  terminalApp?: TerminalApp | null;
  hotkey: number | null;
  ended: boolean;
  /** 07/01: arka plan session'ı → "Uygulamada aç" birincil eylem. */
  background?: boolean;
}) {
  const terminalReady = useTerminals((s) => s.capability?.available ?? false);
  const capDetail = useTerminals((s) => s.capability?.detail ?? null);
  const [openBusy, setOpenBusy] = useState(false);
  const [focusState, setFocusState] = useState<BtnState>('idle');
  const [revealBusy, setRevealBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const focus = async () => {
    const api = window.diji;
    if (!api || focusState !== 'idle') return;
    setFocusState('pending');
    const res = await api.invoke('action:focusTerminal', sessionId);
    if (res.ok) {
      setFocusState('done');
      timer.current = setTimeout(() => setFocusState('idle'), DONE_MS);
    } else {
      setFocusState('idle');
      // Mesaj main'de session'ın terminaline göre üretilir (iTerm2 / Terminal).
      pushToast('error', res.error.message);
    }
  };

  const reveal = async () => {
    const api = window.diji;
    if (!api || revealBusy) return;
    setRevealBusy(true);
    const res = await api.invoke('action:revealProject', projectId);
    setRevealBusy(false);
    if (!res.ok) pushToast('error', res.error.message);
  };

  const openHere = async () => {
    if (openBusy) return;
    setOpenBusy(true);
    await openInApp(sessionId);
    setOpenBusy(false);
  };

  const key = fmtHotkey(hotkey);
  const disabled = ended || !hasTerminal || focusState === 'pending';
  if (background) {
    return (
      <div className="d-actions">
        <button
          type="button"
          className={waiting && !ended ? 'btn wait jump' : 'btn jump'}
          onClick={() => void openHere()}
          disabled={ended || !terminalReady || openBusy}
          aria-busy={openBusy || undefined}
          title="Session'ı bu pencerede aç. Başka bir terminalde açıksa oradaki bağlantı kapanır."
        >
          <span>Uygulamada aç</span>
          {key && <kbd>{key}</kbd>}
        </button>
        {!terminalReady && !ended && <p className="note">{capDetail ?? 'Gömülü terminal hazırlanıyor…'}</p>}
        <button
          type="button"
          className="btn ghost"
          onClick={() => void reveal()}
          disabled={revealBusy}
          aria-busy={revealBusy || undefined}
        >
          Finder&apos;da aç
        </button>
        {!ended && <StopSessionButton sessionId={sessionId} />}
      </div>
    );
  }
  return (
    <div className="d-actions">
      <button
        type="button"
        className={waiting && !ended ? 'btn wait jump' : 'btn jump'}
        onClick={() => void focus()}
        disabled={disabled}
        aria-busy={focusState === 'pending' || undefined}
      >
        <span>{focusState === 'done' ? 'Açıldı' : focusLabel(terminalApp)}</span>
        {key && <kbd>{key}</kbd>}
      </button>
      {!hasTerminal && !ended && <p className="note">Terminal bulunamadı</p>}
      {terminalReady && !ended && (
        <p className="note">Uygulamada açmak için session&apos;da /bg yazın (çalışan görev bitince).</p>
      )}
      <button
        type="button"
        className="btn ghost"
        onClick={() => void reveal()}
        disabled={revealBusy}
        aria-busy={revealBusy || undefined}
      >
        Finder&apos;da aç
      </button>
    </div>
  );
});
