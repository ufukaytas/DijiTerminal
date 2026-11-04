// Renderer'ın tek durum deposu (03/01). Snapshot'lar store'a yazılır; yüksek frekanslı olaylar
// React commit'i tetiklemesin diye store dışında ayrı bir yayın listesiyle dağıtılır.
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { useShallow } from 'zustand/react/shallow';
import type { BoardEvent, BoardSnapshot, SessionView } from '@shared/types';

export type Connection = 'connecting' | 'live' | 'error';

export interface BoardState {
  snapshot: BoardSnapshot;
  connection: Connection;
  selectedSessionId: string | null;
  /** Seçili session snapshot'ta artık yok (sona erdi ve listeden düştü). */
  selectedMissing: boolean;
  /** Seçili session'ın son görülen hali — sona erdiğinde panel bunu soluk gösterir. */
  lastSelected: SessionView | null;
  focusProjectId: string | 'all';
  /** Haritada tıklanan robot (03/08): Seçili Session panelinde satırı vurgulanır. */
  focusAgentId: string | null;
  /** Bu snapshot'ta ilk kez görülen log satırları (flash için). İlk dolu snapshot'ta boş. */
  newLogIds: ReadonlySet<string>;
  setSnapshot(s: BoardSnapshot): void;
  setConnection(c: Connection): void;
  /** `agentId`: haritada bir robota tıklandıysa o ajan; verilmezse vurgu kalkar. */
  select(sessionId: string | null, agentId?: string): void;
  setFocus(projectId: string | 'all'): void;
  /** En uzun süredir bekleyeni seçer; tekrar çağrılınca sıradakine geçer. Focus'u projesine çevirir. */
  goToNextWaiting(): void;
}

export function emptySnapshot(): BoardSnapshot {
  return {
    at: 0,
    booted: false,
    dayStart: 0,
    projects: [],
    sessions: [],
    log: [],
    limits: null,
    totals: {
      projects: 0,
      liveSessions: 0,
      waiting: 0,
      runningAgents: 0,
      conflicts: 0,
      slowTools: 0,
      toolsPerMin: 0,
      costTodayUsd: 0,
    },
  };
}

const EMPTY_SET: ReadonlySet<string> = new Set();

/** Otomatik seçim: önce bekleyen, sonra çalışan, sonra canlı herhangi bir session. */
function autoPick(sessions: SessionView[]): string | null {
  return (
    sessions.find((s) => s.status === 'waiting')?.id ??
    sessions.find((s) => s.status === 'busy')?.id ??
    sessions.find((s) => s.live)?.id ??
    null
  );
}

/** Kullanıcı bir seçim yaptıysa (null dahil) otomatik seçim bir daha devreye girmez. */
let userChose = false;

const initialState = () => ({
  snapshot: emptySnapshot(),
  connection: 'connecting' as Connection,
  selectedSessionId: null as string | null,
  selectedMissing: false,
  focusAgentId: null as string | null,
  lastSelected: null as SessionView | null,
  focusProjectId: 'all' as string | 'all',
  newLogIds: EMPTY_SET,
});

export const useBoard = create<BoardState>()(
  subscribeWithSelector((set, get) => ({
    ...initialState(),

    setSnapshot(snap) {
      const prev = get();
      let selectedSessionId = prev.selectedSessionId;
      if (selectedSessionId === null && !userChose) selectedSessionId = autoPick(snap.sessions);
      const found = selectedSessionId ? (snap.sessions.find((s) => s.id === selectedSessionId) ?? null) : null;

      // Flash: yalnızca önceki dolu snapshot'ta olmayan satırlar. İlk yüklemede hiçbiri.
      let newLogIds = EMPTY_SET;
      if (prev.snapshot.booted && prev.snapshot.log.length + snap.log.length > 0 && prev.snapshot.at > 0) {
        const before = new Set(prev.snapshot.log.map((e) => e.id));
        const fresh = snap.log.filter((e) => !before.has(e.id)).map((e) => e.id);
        if (fresh.length) newLogIds = new Set(fresh);
      }

      // Odaktaki proje kaybolduysa tümüne dön.
      const focusProjectId =
        prev.focusProjectId !== 'all' && snap.booted && !snap.projects.some((p) => p.id === prev.focusProjectId)
          ? 'all'
          : prev.focusProjectId;

      set({
        snapshot: snap,
        connection: 'live',
        selectedSessionId,
        selectedMissing: selectedSessionId !== null && found === null,
        lastSelected: found ?? (selectedSessionId !== null ? prev.lastSelected : null),
        newLogIds,
        focusProjectId,
      });
    },

    setConnection(connection) {
      set({ connection });
    },

    select(sessionId, agentId) {
      userChose = true;
      const found = sessionId ? (get().snapshot.sessions.find((s) => s.id === sessionId) ?? null) : null;
      set({
        focusAgentId: sessionId !== null ? (agentId ?? null) : null,
        selectedSessionId: sessionId,
        selectedMissing: sessionId !== null && found === null,
        lastSelected: found,
      });
    },

    setFocus(projectId) {
      set({ focusProjectId: projectId });
    },

    goToNextWaiting() {
      const { snapshot, selectedSessionId, select, setFocus } = get();
      const waiting = snapshot.sessions
        .filter((s) => s.status === 'waiting')
        .sort((a, b) => a.statusSince - b.statusSince || a.id.localeCompare(b.id));
      if (waiting.length === 0) return;
      const i = waiting.findIndex((s) => s.id === selectedSessionId);
      const next = waiting[(i + 1) % waiting.length]!; // i = -1 → ilk (en uzun bekleyen)
      select(next.id);
      setFocus(next.projectId);
    },
  })),
);

/** Testler için: store'u ve otomatik seçim bayrağını sıfırlar. */
export function resetBoard(): void {
  userChose = false;
  useBoard.setState(initialState());
}

// ---- Olay yayını (store dışı) ----

type EventListener = (events: BoardEvent[]) => void;
const listeners = new Set<EventListener>();

export function subscribeEvents(cb: EventListener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Yalnızca bridge.ts kullanır. Bir dinleyicinin hatası diğerlerini durdurmaz. */
export function emitEvents(events: BoardEvent[]): void {
  for (const cb of [...listeners]) {
    try {
      cb(events);
    } catch (e) {
      console.error('[board] olay dinleyicisi hata verdi:', e);
    }
  }
}

// ---- Seçiciler ----

const selectSelected = (s: BoardState): SessionView | null => {
  if (!s.selectedSessionId) return null;
  return s.snapshot.sessions.find((x) => x.id === s.selectedSessionId) ?? (s.selectedMissing ? s.lastSelected : null);
};

export const useSelectedSession = (): SessionView | null => useBoard(selectSelected);
export const useTotals = () => useBoard((s) => s.snapshot.totals);
export const useProjects = () => useBoard(useShallow((s) => s.snapshot.projects));

/** Session id → proje id (log ve harita tıklamaları için). */
export function projectOf(sessionId: string): string | 'all' {
  return useBoard.getState().snapshot.sessions.find((s) => s.id === sessionId)?.projectId ?? 'all';
}
