// İki satırlık log kaydı (03/04): saat · session ▸ ajan · sonuç / araç · etiket.
import { memo } from 'react';
import { CATEGORY_COLOR, SLOW_COLOR, STATUS_COLOR, THRESHOLDS } from '@shared/constants';
import type { LogEntry, SessionStatus } from '@shared/types';
import { fmtClock, fmtDuration } from '../../lib/format';
import { Elapsed } from '../Elapsed';

export const ROW_HEIGHT = 44;

export interface LogRowProps {
  entry: LogEntry;
  index: number;
  /** Session snapshot'ta yoksa null (gri ad). */
  sessionName: string | null;
  sessionStatus: SessionStatus | null;
  agentName: string | null;
  isNew: boolean;
  tabIndex: number;
  top: number;
  onPick(entry: LogEntry, index: number): void;
}

function Result({ e }: { e: LogEntry }) {
  if (e.kind === 'agent' || e.kind === 'sys' || e.kind === 'prompt' || e.kind === 'say') {
    if (e.state === 'err') return <span className="r slow">✕ hata</span>;
    return <span className="r" />;
  }
  switch (e.state) {
    case 'run':
      return (
        <span className="r run">
          ▶ <Elapsed since={e.ts} slowAfter={THRESHOLDS.slowToolMs} />
        </span>
      );
    case 'ok': {
      const d = e.durationMs;
      const txt = d === null ? '' : d < 1000 ? `${(d / 1000).toFixed(1)}s` : fmtDuration(d);
      return <span className="r ok">✓ {txt}</span>;
    }
    case 'err':
      return (
        <span className="r slow" style={{ color: SLOW_COLOR }}>
          ✕ hata
        </span>
      );
    case 'wait':
      return <span className="r w">⏸ izin</span>;
  }
}

function kindLabel(e: LogEntry): { text: string; color: string | undefined } {
  if (e.kind === 'tool' && e.toolName) {
    return { text: e.toolName.toLowerCase(), color: e.category ? CATEGORY_COLOR[e.category] : undefined };
  }
  return { text: e.kind, color: undefined };
}

export const LogRow = memo(
  function LogRow({
    entry: e,
    index,
    sessionName,
    sessionStatus,
    agentName,
    isNew,
    tabIndex,
    top,
    onPick,
  }: LogRowProps) {
    const k = kindLabel(e);
    const cls = ['log-row', isNew ? 'new' : null, e.state === 'wait' ? 'w' : null, e.state === 'err' ? 'err' : null]
      .filter(Boolean)
      .join(' ');
    const who = sessionName ?? e.sessionId.slice(0, 8);
    return (
      <button
        type="button"
        className={cls}
        data-index={index}
        data-id={e.id}
        tabIndex={tabIndex}
        style={{ transform: `translateY(${top}px)` }}
        onClick={() => onPick(e, index)}
      >
        <span className="t">{fmtClock(e.ts)}</span>
        <span
          className="s"
          style={{ color: sessionStatus ? STATUS_COLOR[sessionStatus] : 'var(--dim)' }}
          title={agentName ? `${who} ▸ ${agentName}` : who}
        >
          {who}
          {agentName && ` ▸ ${agentName}`}
        </span>
        <Result e={e} />
        <span className={e.kind === 'tool' ? 'k' : 'k dim'} style={k.color ? { color: k.color } : undefined}>
          {k.text}
        </span>
        <span className={e.kind === 'say' ? 'l say' : 'l'} title={e.label}>
          {e.label}
        </span>
      </button>
    );
  },
  (a, b) =>
    a.entry.id === b.entry.id &&
    a.entry.state === b.entry.state &&
    a.entry.durationMs === b.entry.durationMs &&
    a.entry.label === b.entry.label &&
    a.index === b.index &&
    a.top === b.top &&
    a.sessionName === b.sessionName &&
    a.sessionStatus === b.sessionStatus &&
    a.agentName === b.agentName &&
    a.isNew === b.isNew &&
    a.tabIndex === b.tabIndex &&
    a.onPick === b.onPick,
);
