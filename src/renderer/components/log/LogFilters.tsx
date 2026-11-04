// session.log filtre çubuğu (03/04).
import type { ProjectView, SessionView } from '@shared/types';
import { CATEGORY_CHIPS, isFilterActive, toggleChip, DEFAULT_LOG_FILTER, type LogFilter } from './filterLog';

export function LogFilters({
  filter,
  onChange,
  projects,
  sessions,
}: {
  filter: LogFilter;
  onChange(f: LogFilter): void;
  projects: ProjectView[];
  sessions: SessionView[];
}) {
  const sessionOptions = filter.projectId ? sessions.filter((s) => s.projectId === filter.projectId) : sessions;
  const selectedSessionGone = filter.sessionId !== null && !sessions.some((s) => s.id === filter.sessionId);
  const projectGone = filter.projectId !== null && !projects.some((p) => p.id === filter.projectId);

  return (
    <div className="log-filters" role="group" aria-label="Log filtreleri">
      <div className="lf-row">
        <select
          aria-label="Proje"
          value={filter.projectId ?? ''}
          onChange={(e) => onChange({ ...filter, projectId: e.target.value || null, sessionId: null })}
        >
          <option value="">Tüm projeler</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          {projectGone && <option value={filter.projectId!}>(kapandı)</option>}
        </select>
        <select
          aria-label="Session"
          value={filter.sessionId ?? ''}
          onChange={(e) => onChange({ ...filter, sessionId: e.target.value || null })}
        >
          <option value="">Tüm session&apos;lar</option>
          {sessionOptions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name || s.title || s.id.slice(0, 8)}
              {s.status === 'ended' ? ' (sona erdi)' : ''}
            </option>
          ))}
          {selectedSessionGone && <option value={filter.sessionId!}>(sona erdi)</option>}
        </select>
      </div>
      <div className="lf-row chips-row">
        {CATEGORY_CHIPS.map((c) => {
          const on = c.cats.every((x) => filter.categories.includes(x));
          return (
            <button
              key={c.key}
              type="button"
              className="fchip"
              aria-pressed={on}
              onClick={() => onChange(toggleChip(filter, c.cats))}
            >
              <i style={{ background: c.color }} aria-hidden="true" />
              {c.label}
            </button>
          );
        })}
        <button
          type="button"
          className="fchip err"
          aria-pressed={filter.errorsOnly}
          onClick={() => onChange({ ...filter, errorsOnly: !filter.errorsOnly })}
        >
          sadece hatalar
        </button>
        {isFilterActive(filter) && (
          <button type="button" className="linkish" onClick={() => onChange({ ...DEFAULT_LOG_FILTER })}>
            Temizle
          </button>
        )}
      </div>
    </div>
  );
}
