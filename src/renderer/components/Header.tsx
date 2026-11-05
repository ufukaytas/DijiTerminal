// Üst bar (03/01): marka, sayaçlar, proje odak segmenti, "Bekleyene git", saat.
import { memo, useState } from 'react';
import type { BoardTotals, ProjectView, UsageLimits } from '@shared/types';
import { useNow } from '../hooks/useNow';
import { fmtClock } from '../lib/format';
import { limitsView } from '../lib/limits';
import { useBoard, useProjects, useTotals } from '../state/board';
import { useSettings } from '../state/settings';
import { useTerminals } from '../state/terminals';
import { CompatBadge } from './CompatBadge';
import { HistoryDialog } from './terminal/HistoryDialog';
import { NewSessionDialog } from './terminal/NewSessionDialog';

export const MAX_SEGMENTS = 8;

function Chips({ totals, booted }: { totals: BoardTotals; booted: boolean }) {
  const n = (v: number) => (booted ? String(v) : '—');
  const risky = totals.conflicts + totals.slowTools > 0;
  return (
    <div className="chips" aria-label="Özet">
      <span className="chip">
        {n(totals.projects)} proje · {n(totals.liveSessions)} session
      </span>
      <span className={totals.runningAgents > 0 ? 'chip c-busy' : 'chip'}>
        {n(totals.runningAgents)} ajan çalışıyor
      </span>
      <span className={totals.waiting > 0 ? 'chip c-wait' : 'chip'}>{n(totals.waiting)} bekliyor</span>
      <span className={risky ? 'chip c-slow' : 'chip'}>
        {n(totals.conflicts)} çakışma · {n(totals.slowTools)} yavaş
      </span>
      <span className="chip c-rate">{booted ? Math.round(totals.toolsPerMin) : '—'} araç/dk</span>
    </div>
  );
}

const ProjectSegment = memo(function ProjectSegment({
  projects,
  focus,
  onFocus,
}: {
  projects: ProjectView[];
  focus: string;
  onFocus(id: string): void;
}) {
  const shown = projects.slice(0, MAX_SEGMENTS);
  const rest = projects.slice(MAX_SEGMENTS);
  const restSelected = rest.some((p) => p.id === focus);
  return (
    <div className="seg" role="group" aria-label="Proje odağı">
      <button type="button" aria-pressed={focus === 'all'} onClick={() => onFocus('all')}>
        Tümü
      </button>
      {shown.map((p) => (
        <button key={p.id} type="button" aria-pressed={focus === p.id} onClick={() => onFocus(p.id)} title={p.name}>
          <i className="dot sm" style={{ background: p.color }} aria-hidden="true" />
          <span className="seg-name">{p.name}</span>
        </button>
      ))}
      {rest.length > 0 && (
        <select
          className={restSelected ? 'seg-more on' : 'seg-more'}
          aria-label={`Diğer ${rest.length} proje`}
          value={restSelected ? focus : ''}
          onChange={(e) => e.target.value && onFocus(e.target.value)}
        >
          <option value="" disabled>
            +{rest.length}
          </option>
          {rest.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
});

/** 02/08: "5s %42 · 14:30 · hafta %61" çubukları; veri yoksa hiç yer kaplamaz. */
function Limits({ limits }: { limits: UsageLimits | null }) {
  const now = useNow(1000);
  const v = limitsView(limits, now);
  if (!v) return null;
  return (
    <div className={v.stale ? 'limits stale' : 'limits'} aria-label="Kullanım limitleri" title={v.updatedLabel}>
      {v.items.map((it) => (
        <span key={it.key} className={`limit l-${it.level}`}>
          {/* .limit display:contents olduğundan ipucu her hücrede */}
          <span className="limit-label" title={`${it.title}\n${v.updatedLabel}`}>
            {it.label}
          </span>
          <span className="limit-bar" aria-hidden="true" title={`${it.title}\n${v.updatedLabel}`}>
            <i style={{ width: `${it.pct}%` }} />
          </span>
          <span className="limit-pct" title={`${it.title}\n${v.updatedLabel}`}>
            {it.reset ? 'sıfır' : `%${it.pct}`}
          </span>
        </span>
      ))}
    </div>
  );
}

function Clock() {
  const now = useNow(1000);
  return <span className="clock">{fmtClock(now)}</span>;
}

export function Header() {
  const totals = useTotals();
  const projects = useProjects();
  const booted = useBoard((s) => s.snapshot.booted);
  const connection = useBoard((s) => s.connection);
  const focus = useBoard((s) => s.focusProjectId);
  const setFocus = useBoard((s) => s.setFocus);
  const goToNextWaiting = useBoard((s) => s.goToNextWaiting);
  const limits = useBoard((s) => s.snapshot.limits);
  const canStart = useTerminals((s) => s.capability?.available ?? false);
  const [newOpen, setNewOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  return (
    <header className="bar">
      <div className="brand">
        <h1>DijiTerminal</h1>
        <span>v{__APP_VERSION__}</span>
      </div>
      <Chips totals={totals} booted={booted} />
      <Limits limits={limits} />
      <CompatBadge />
      {connection === 'error' && <span className="chip c-slow">motor bağlantısı yok</span>}
      <div className="spacer" />
      <ProjectSegment projects={projects} focus={focus} onFocus={setFocus} />
      <button
        type="button"
        className={totals.waiting > 0 ? 'btn wait' : 'btn'}
        disabled={totals.waiting === 0}
        onClick={goToNextWaiting}
      >
        Bekleyene git
      </button>
      {canStart && (
        <button
          type="button"
          className="btn"
          onClick={() => setNewOpen(true)}
          title="Arka planda yeni bir Claude Code session'ı başlat ve burada aç"
        >
          + Yeni oturum
        </button>
      )}
      {canStart && (
        <button
          type="button"
          className="btn icon"
          onClick={() => setHistoryOpen(true)}
          aria-label="Geçmiş"
          title="Geçmiş: kapatılan ve eski arka plan session'ları"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
            <path d="M3 3v5h5" />
            <path d="M12 7v5l3 2" />
          </svg>
        </button>
      )}
      {newOpen && <NewSessionDialog onClose={() => setNewOpen(false)} />}
      {historyOpen && <HistoryDialog onClose={() => setHistoryOpen(false)} />}
      <Clock />
      <button
        type="button"
        className="btn icon"
        aria-label="Ayarlar"
        title="Ayarlar (⌘,)"
        onClick={() => useSettings.getState().setOpen(true)}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
        </svg>
      </button>
    </header>
  );
}
