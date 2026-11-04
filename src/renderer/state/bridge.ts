// window.diji ↔ store köprüsü (03/01). App.tsx'te useEffect içinde çağrılır; dönen fonksiyon
// tüm abonelikleri kaldırır (HMR'de çift dinleyici olmaz).
import type { DijiApi } from '@shared/ipc';
import { emitEvents, projectOf, useBoard } from './board';
import { pushToast } from './toast';

export const RETRY_MS = 5000;

export function initBoardBridge(
  api: DijiApi | undefined = typeof window !== 'undefined' ? window.diji : undefined,
): () => void {
  const board = useBoard.getState();
  if (!api) {
    board.setConnection('error');
    return () => {};
  }

  let disposed = false;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const load = async (attempt: number) => {
    let res: Awaited<ReturnType<DijiApi['invoke']>> | null;
    try {
      res = await api.invoke('board:getSnapshot');
    } catch {
      res = null;
    }
    if (disposed) return;
    if (res && res.ok) {
      // Canlı bir snapshot olayı daha önce geldiyse eskisini yazma.
      const cur = useBoard.getState();
      if (cur.connection !== 'live' || cur.snapshot.at <= res.data.at) cur.setSnapshot(res.data);
      return;
    }
    if (useBoard.getState().connection === 'live') return; // bu arada olay akışı başladı
    useBoard.getState().setConnection('error');
    if (attempt === 0) {
      pushToast('error', 'Motora bağlanılamadı, yeniden deneniyor.');
      retry = setTimeout(() => void load(1), RETRY_MS);
    }
  };

  const offs = [
    api.on('board:snapshot', (s) => useBoard.getState().setSnapshot(s)),
    api.on('board:events', (events) => emitEvents(events)),
    api.on('ui:selectSession', ({ sessionId }) => {
      const st = useBoard.getState();
      st.select(sessionId);
      st.setFocus(projectOf(sessionId));
    }),
    api.on('app:toast', ({ level, message, action }) => pushToast(level, message, action)),
  ];
  void load(0);

  return () => {
    disposed = true;
    if (retry) clearTimeout(retry);
    for (const off of offs) off();
  };
}
