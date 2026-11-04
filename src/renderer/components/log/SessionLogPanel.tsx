// session.log paneli (03/04): sanallaştırılmış liste, kaydırma çapası, "N yeni satır" hapı, filtreler.
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useShallow } from 'zustand/react/shallow';
import type { LogEntry, SessionView } from '@shared/types';
import { projectOf, useBoard } from '../../state/board';
import { Panel } from '../Panel';
import {
  filterLog,
  isFilterActive,
  loadLogFilter,
  saveLogFilter,
  DEFAULT_LOG_FILTER,
  type LogFilter,
} from './filterLog';
import { LogFilters } from './LogFilters';
import { LogRow, ROW_HEIGHT } from './LogRow';

const TOP_EPS = 4;

/** Effect içinden güncellenen küçük sayaç (render dışı değer; React yalnızca değişince çizer). */
function createCounter() {
  let v = 0;
  const ls = new Set<() => void>();
  return {
    get: () => v,
    set(n: number) {
      if (n === v) return;
      v = n;
      for (const l of ls) l();
    },
    sub(cb: () => void) {
      ls.add(cb);
      return () => {
        ls.delete(cb);
      };
    },
  };
}

function SkeletonRows() {
  return (
    <div className="skel log-skel" aria-hidden="true">
      {Array.from({ length: 6 }, (_, i) => (
        <i key={i} style={{ width: `${90 - i * 7}%` }} />
      ))}
    </div>
  );
}

export function SessionLogPanel() {
  const log = useBoard((s) => s.snapshot.log);
  const booted = useBoard((s) => s.snapshot.booted);
  const sessions = useBoard((s) => s.snapshot.sessions);
  const projects = useBoard(useShallow((s) => s.snapshot.projects));
  const newLogIds = useBoard((s) => s.newLogIds);

  const [filter, setFilterState] = useState<LogFilter>(loadLogFilter);
  const setFilter = useCallback((f: LogFilter) => {
    setFilterState(f);
    saveLogFilter(f);
  }, []);

  const sessionsById = useMemo(() => new Map<string, SessionView>(sessions.map((s) => [s.id, s])), [sessions]);
  const rows = useMemo(() => filterLog(log, filter, sessionsById), [log, filter, sessionsById]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [counter] = useState(createCounter);
  const pendingNew = useSyncExternalStore(counter.sub, counter.get);
  const [activeRaw, setActive] = useState(0);
  const active = Math.max(0, Math.min(activeRaw, rows.length - 1)); // liste kısalınca sınırda kalır

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual memo'lanamaz; bu bileşen derleyiciye bırakılmıyor.
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    initialRect: { width: 320, height: 800 },
    getItemKey: (i) => rows[i]?.id ?? i,
  });

  // Kaydırma çapası: kullanıcı en üstte değilse baktığı satır yerinde kalır, üste eklenenler sayılır.
  const prev = useRef<{ rows: LogEntry[]; filter: LogFilter } | null>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const before = prev.current;
    prev.current = { rows, filter };
    if (!el || !before || before.rows === rows) return;
    if (before.filter !== filter) {
      el.scrollTop = 0;
      counter.set(0);
      return;
    }
    const top = el.scrollTop;
    if (top <= TOP_EPS) {
      counter.set(0);
      return;
    }
    const oldIdx = Math.min(Math.floor(top / ROW_HEIGHT), Math.max(0, before.rows.length - 1));
    const anchorId = before.rows[oldIdx]?.id;
    const newIdx = anchorId ? rows.findIndex((r) => r.id === anchorId) : -1;
    if (newIdx > oldIdx) {
      el.scrollTop = top + (newIdx - oldIdx) * ROW_HEIGHT;
      counter.set(counter.get() + (newIdx - oldIdx));
    }
  }, [rows, filter, counter]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el && el.scrollTop <= TOP_EPS) counter.set(0);
  };

  const jumpTop = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = 0;
    virtualizer.scrollToOffset(0);
    counter.set(0);
  };

  const onPick = useCallback((e: LogEntry, index: number) => {
    setActive(index);
    const st = useBoard.getState();
    st.select(e.sessionId);
    const pid = projectOf(e.sessionId);
    if (pid !== 'all') st.setFocus(pid);
  }, []);

  const onKeyDown = (ev: KeyboardEvent<HTMLDivElement>) => {
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    ev.preventDefault();
    const next = Math.max(0, Math.min(rows.length - 1, active + (ev.key === 'ArrowDown' ? 1 : -1)));
    setActive(next);
    virtualizer.scrollToIndex(next, { align: 'auto' });
    requestAnimationFrame(() => {
      scrollRef.current?.querySelector<HTMLElement>(`[data-index="${next}"]`)?.focus();
    });
  };

  const filtered = isFilterActive(filter);
  const meta = filtered ? `filtreli · ${rows.length}/${log.length}` : 'canlı araç akışı · tüm projeler';

  let body;
  if (!booted && log.length === 0) body = <SkeletonRows />;
  else if (log.length === 0) body = <p className="empty">Henüz araç çağrısı yok.</p>;
  else if (rows.length === 0)
    body = (
      <p className="empty">
        Bu filtreyle kayıt yok.{' '}
        <button type="button" className="linkish" onClick={() => setFilter({ ...DEFAULT_LOG_FILTER })}>
          Filtreyi temizle
        </button>
      </p>
    );
  else {
    const items = virtualizer.getVirtualItems();
    body = (
      <div className="log-list" role="list" aria-label="Araç akışı" style={{ height: virtualizer.getTotalSize() }}>
        {items.map((vi) => {
          const e = rows[vi.index]!;
          const s = sessionsById.get(e.sessionId) ?? null;
          const agent = e.agentId && s ? s.agents.find((a) => a.id === e.agentId && !a.isMain) : null;
          return (
            <LogRow
              key={vi.key}
              entry={e}
              index={vi.index}
              top={vi.start}
              sessionName={s ? s.name || s.title || s.id.slice(0, 8) : null}
              sessionStatus={s ? s.status : null}
              agentName={agent ? agent.name : !s && e.agentId && e.agentId !== 'main' ? e.agentId : null}
              isNew={newLogIds.has(e.id)}
              tabIndex={vi.index === active ? 0 : -1}
              onPick={onPick}
            />
          );
        })}
      </div>
    );
  }

  return (
    <Panel
      title="SESSION.LOG"
      aria-label="session.log"
      meta={meta}
      className="log-panel"
      bodyClassName="log-b"
      toolbar={<LogFilters filter={filter} onChange={setFilter} projects={projects} sessions={sessions} />}
    >
      {pendingNew > 0 && (
        <button type="button" className="new-pill" onClick={jumpTop}>
          {pendingNew} yeni satır ↑
        </button>
      )}
      <div className="log-scroll" ref={scrollRef} onScroll={onScroll} onKeyDown={onKeyDown} data-testid="log-scroll">
        {body}
      </div>
    </Panel>
  );
}
