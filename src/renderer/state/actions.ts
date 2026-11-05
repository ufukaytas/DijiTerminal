// Main sürecine giden kullanıcı eylemleri (harita ve paneller paylaşır).
import { useBoard } from './board';
import { useTerminals } from './terminals';
import { pushToast } from './toast';

/** Session'ın terminal sekmesini öne getir (04/01). Hata toast olarak gösterilir. true → başarılı. */
export async function focusTerminal(sessionId: string): Promise<boolean> {
  const api = typeof window !== 'undefined' ? window.diji : undefined;
  if (!api) return false;
  let res;
  try {
    res = await api.invoke('action:focusTerminal', sessionId);
  } catch {
    pushToast('error', 'Terminal öne getirilemedi.');
    return false;
  }
  if (res.ok) return true;
  pushToast('error', res.error.message); // main'de session'ın terminaline göre (iTerm2 / Terminal)
  return false;
}

/** Arka plan session'ını gömülü terminalde aç (07/01). */
export function openInApp(sessionId: string): Promise<boolean> {
  return useTerminals.getState().openSession(sessionId);
}

/**
 * Haritada çift tıklama / Enter: arka plan session'ı ve terminal kullanılabilirse uygulamada açar,
 * değilse terminal sekmesine (iTerm2 / Terminal) gider (07/01).
 */
export function activateSession(sessionId: string): Promise<boolean> {
  const s = useBoard.getState().snapshot.sessions.find((x) => x.id === sessionId);
  if (s?.background && useTerminals.getState().capability?.available) return openInApp(sessionId);
  return focusTerminal(sessionId);
}

// 07/01 "Yeni oturum": bileşen dosyasında durursa Fast Refresh çalışmıyordu (bileşen dışı export).
/** Session haritada görünene kadar en fazla bu kadar beklenir. */
export const APPEAR_TIMEOUT_MS = 20_000;

/** bgId'li session snapshot'ta belirince çağrılır; süre dolarsa false. */
export function waitForBackground(bgId: string, timeoutMs = APPEAR_TIMEOUT_MS): Promise<string | null> {
  const find = () => useBoard.getState().snapshot.sessions.find((s) => s.background?.id === bgId)?.id ?? null;
  const now = find();
  if (now) return Promise.resolve(now);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      off();
      resolve(null);
    }, timeoutMs);
    const off = useBoard.subscribe(() => {
      const id = find();
      if (!id) return;
      clearTimeout(timer);
      off();
      resolve(id);
    });
  });
}

/**
 * 07/01: "Session'ı kapat": çalışıyorsa `claude stop`, sonra haritadan kaldırılır; uygulamadaki sekmesi de kapanır.
 * Konuşma silinmez. Çağıran iki adımlı onay gösterir.
 */
export async function stopBackground(sessionId: string): Promise<boolean> {
  const api = typeof window !== 'undefined' ? window.diji : undefined;
  if (!api) return false;
  let res;
  try {
    res = await api.invoke('session:stopBackground', sessionId);
  } catch {
    pushToast('error', 'Session durdurulamadı.');
    return false;
  }
  if (!res.ok) {
    pushToast('error', res.error.message);
    return false;
  }
  const tab = useTerminals.getState().tabs.find((t) => t.sessionId === sessionId);
  if (tab) useTerminals.getState().close(tab.termId);
  pushToast('info', 'Session kapatıldı.');
  return true;
}
