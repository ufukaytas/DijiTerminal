// Orta alan (Sprint 2): 3B harita (03/05) gelene kadar canlı session'ları proje kartlarında gösteren 2B görünüm.
import { memo, useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { CATEGORY_COLOR, STATUS_COLOR, THRESHOLDS } from '@shared/constants';
import type { HookInstallStatus, ProjectView, SessionView } from '@shared/types';
import { fmtCost, fmtHotkey, fmtPct } from '../../lib/format';
import { useBoard } from '../../state/board';
import { pushToast } from '../../state/toast';
import { AgentNow } from '../AgentNow';
import { STATUS_LABEL } from '../detail/parts';
import { mapScope } from '../../lib/mapScope';
import { emptyMapWarning } from '../../lib/compat';

const SessionCard = memo(function SessionCard({
  session,
  selected,
  onSelect,
}: {
  session: SessionView;
  selected: boolean;
  onSelect(id: string): void;
}) {
  const main = session.agents[0];
  const subs = session.agents.filter((a) => !a.isMain && !a.done);
  const key = fmtHotkey(session.hotkey);
  const warn = session.ctxRatio >= THRESHOLDS.ctxWarnRatio;
  return (
    <button
      type="button"
      className={['scard', `st-${session.status}`, selected ? 'sel' : null].filter(Boolean).join(' ')}
      aria-pressed={selected}
      onClick={() => onSelect(session.id)}
    >
      <span className="sc-top">
        <i className="dot" style={{ background: STATUS_COLOR[session.status] }} aria-hidden="true" />
        <b title={session.name}>{session.name || session.title || session.id.slice(0, 8)}</b>
        {key && <kbd>{key}</kbd>}
        <span className={`pill ${session.status}`}>{STATUS_LABEL[session.status]}</span>
      </span>
      {main && session.status !== 'ended' && <AgentNow agent={main} session={session} />}
      <span className="sc-meta">
        <span>{session.model}</span>
        {session.branch && <span>⎇ {session.branch}</span>}
        {subs.length > 0 && <span>{subs.length} alt ajan</span>}
        <span>{fmtCost(session.costUsd)}</span>
      </span>
      {session.ctxMax > 0 && (
        <span className={warn ? 'sc-ctx warn' : 'sc-ctx'} title={`context ${fmtPct(session.ctxRatio)}`}>
          <span style={{ width: `${Math.min(100, session.ctxRatio * 100)}%` }} />
        </span>
      )}
    </button>
  );
});

function ProjectCard({
  project,
  sessions,
  selectedId,
  onSelect,
}: {
  project: ProjectView;
  sessions: SessionView[];
  selectedId: string | null;
  onSelect(id: string): void;
}) {
  return (
    <section className="pcard" style={{ borderTopColor: project.color }} aria-label={project.name}>
      <header className="pc-h">
        <i className="dot" style={{ background: project.color }} aria-hidden="true" />
        <b title={project.root}>{project.name}</b>
        {project.tag && <span className="tag">{project.tag}</span>}
        <span className="pc-path">{project.displayPath}</span>
        <span className="pc-sum">
          {sessions.length} session · {fmtCost(project.costUsd)}
          {project.conflicts.length > 0 && <span className="pc-conf"> · {project.conflicts.length} çakışma</span>}
        </span>
      </header>
      <div className="pc-sessions">
        {sessions.map((s) => (
          <SessionCard key={s.id} session={s} selected={s.id === selectedId} onSelect={onSelect} />
        ))}
      </div>
    </section>
  );
}

export function Loading() {
  return (
    <div className="center-state" role="status">
      <p>Session&apos;lar okunuyor…</p>
      <div className="progress" aria-hidden="true">
        <i />
      </div>
    </div>
  );
}

export function EmptyState() {
  // 09/01: süreç var ama session dosyası yok → boş haritanın nedeni büyük olasılıkla format uyumsuzluğu.
  const compatError = useBoard((s) => {
    const c = s.snapshot.compat;
    return c?.signals.some((x) => x.id === 'processWithoutSession') ? (c.claudeVersion ?? '') : null;
  });
  const [hooks, setHooks] = useState<HookInstallStatus | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    void window.diji?.invoke('hooks:status').then((r) => {
      if (alive && r.ok) setHooks(r.data);
    });
    return () => {
      alive = false;
    };
  }, []);

  const install = async () => {
    const api = window.diji;
    if (!api) return;
    setBusy(true);
    const r = await api.invoke('hooks:install');
    setBusy(false);
    if (r.ok) {
      setHooks(r.data);
      pushToast('info', 'Hook’lar kuruldu. Yeni başlatılan session’larda anlık durum görünür.');
    } else pushToast('error', r.error.message);
  };

  return (
    <div className="center-state">
      {compatError !== null ? (
        <>
          <p className="compat-empty" role="alert">
            {emptyMapWarning(compatError || null)}
          </p>
          {/* "Henüz çalışan session yok" burada yanlış olur: süreç tablosu claude'un çalıştığını gösteriyor. */}
          <p>Ayrıntı ve paylaşılabilir rapor için üst bardaki ⚠ Uyumluluk rozetine tıklayın.</p>
        </>
      ) : (
        <p>
          Henüz çalışan Claude Code session&apos;ı yok. iTerm2&apos;de <code>claude</code> başlattığınızda burada görünür.
        </p>
      )}
      {hooks && !hooks.installed && (
        <button
          type="button"
          className="btn"
          onClick={() => void install()}
          disabled={busy}
          aria-busy={busy || undefined}
        >
          Anlık durum için hook&apos;ları kur
        </button>
      )}
    </div>
  );
}

const LEGEND: [string, string][] = [
  ['okuma/arama', CATEGORY_COLOR.read],
  ['düzenleme', CATEGORY_COLOR.edit],
  ['bash', CATEGORY_COLOR.bash],
  ['web', CATEGORY_COLOR.web],
  ['onay bekliyor', STATUS_COLOR.waiting],
];

export function SessionGrid() {
  const booted = useBoard((s) => s.snapshot.booted);
  const sessions = useBoard((s) => s.snapshot.sessions);
  const projects = useBoard(useShallow((s) => s.snapshot.projects));
  const focus = useBoard((s) => s.focusProjectId);
  const selectedId = useBoard((s) => s.selectedSessionId);
  const select = useBoard((s) => s.select);

  // Haritayla aynı kapsam: sona eren session ve yaşayanı kalmayan proje gösterilmez.
  const scope = useMemo(() => mapScope({ projects, sessions }), [projects, sessions]);
  const byId = useMemo(() => new Map(scope.sessions.map((s) => [s.id, s])), [scope]);
  const visible = focus === 'all' ? scope.projects : scope.projects.filter((p) => p.id === focus);

  let body;
  if (!booted) body = <Loading />;
  else if (scope.sessions.length === 0) body = <EmptyState />;
  else
    body = (
      <div className="pgrid">
        {visible.map((p) => {
          const ss = p.sessionIds.map((id) => byId.get(id)).filter((s): s is SessionView => Boolean(s));
          return <ProjectCard key={p.id} project={p} sessions={ss} selectedId={selectedId} onSelect={select} />;
        })}
      </div>
    );

  return (
    <div className="map2d" aria-label="Session haritası">
      <div className="hint">liste görünümü</div>
      <div className="map2d-b">{body}</div>
      <div className="legend" aria-hidden="true">
        {LEGEND.map(([l, c]) => (
          <span key={l}>
            <i style={{ background: c }} />
            {l}
          </span>
        ))}
      </div>
    </div>
  );
}
