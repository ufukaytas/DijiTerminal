import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DijiApi, IpcEventMap } from '@shared/ipc';
import { emitEvents, emptySnapshot, resetBoard, subscribeEvents, useBoard } from '@renderer/state/board';
import { initBoardBridge, RETRY_MS } from '@renderer/state/bridge';
import { useToasts } from '@renderer/state/toast';
import { IDS, makeSnapshot } from './__fixtures__/snapshot';

const NOW = 1_800_000_000_000;

beforeEach(() => {
  resetBoard();
  useToasts.setState({ toasts: [] });
});

describe('setSnapshot seçim kuralları', () => {
  it("ilk snapshot'ta seçim yoksa ilk bekleyeni seçer", () => {
    useBoard.getState().setSnapshot(makeSnapshot(NOW));
    const s = useBoard.getState();
    expect(s.selectedSessionId).toBe(IDS.waiting);
    expect(s.connection).toBe('live');
    expect(s.selectedMissing).toBe(false);
  });

  it('bekleyen yoksa ilk çalışanı seçer', () => {
    const snap = makeSnapshot(NOW);
    snap.sessions = snap.sessions.filter((x) => x.status !== 'waiting');
    useBoard.getState().setSnapshot(snap);
    expect(useBoard.getState().selectedSessionId).toBe(IDS.team);
  });

  it('booted:false boş snapshot seçim yapmaz; sonraki dolu snapshot yapar', () => {
    useBoard.getState().setSnapshot(emptySnapshot());
    expect(useBoard.getState().selectedSessionId).toBeNull();
    useBoard.getState().setSnapshot(makeSnapshot(NOW));
    expect(useBoard.getState().selectedSessionId).toBe(IDS.waiting);
  });

  it('kullanıcı seçimi korunur; session düşerse selectedMissing ve son bilinen hal', () => {
    const st = useBoard.getState();
    st.setSnapshot(makeSnapshot(NOW));
    st.select(IDS.idle);
    const next = makeSnapshot(NOW + 1000);
    next.sessions = next.sessions.filter((x) => x.id !== IDS.idle);
    useBoard.getState().setSnapshot(next);
    const s = useBoard.getState();
    expect(s.selectedSessionId).toBe(IDS.idle);
    expect(s.selectedMissing).toBe(true);
    expect(s.lastSelected?.name).toBe('docs düzeltmeleri');
  });

  it('kullanıcı seçimi kaldırdıysa otomatik seçim tekrar devreye girmez', () => {
    const st = useBoard.getState();
    st.setSnapshot(makeSnapshot(NOW));
    st.select(null);
    useBoard.getState().setSnapshot(makeSnapshot(NOW + 1000));
    expect(useBoard.getState().selectedSessionId).toBeNull();
  });

  it('odaktaki proje kaybolursa focus "all"a döner', () => {
    const st = useBoard.getState();
    st.setSnapshot(makeSnapshot(NOW));
    st.setFocus('p3docs');
    const next = makeSnapshot(NOW + 1000);
    next.projects = next.projects.filter((p) => p.id !== 'p3docs');
    useBoard.getState().setSnapshot(next);
    expect(useBoard.getState().focusProjectId).toBe('all');
  });

  it("newLogIds: ilk dolu snapshot'ta boş, sonra yalnızca yeni satırlar", () => {
    useBoard.getState().setSnapshot(makeSnapshot(NOW));
    expect(useBoard.getState().newLogIds.size).toBe(0);
    const next = makeSnapshot(NOW + 1000);
    next.log = [{ ...next.log[0]!, id: 'yeni-1' }, ...next.log];
    useBoard.getState().setSnapshot(next);
    expect([...useBoard.getState().newLogIds]).toEqual(['yeni-1']);
  });
});

describe('goToNextWaiting', () => {
  it("en uzun bekleyenden başlar, döngüyle sıradakine geçer, focus'u projeye çevirir", () => {
    useBoard.getState().setSnapshot(makeSnapshot(NOW));
    useBoard.getState().select(IDS.busy);
    useBoard.getState().goToNextWaiting();
    expect(useBoard.getState().selectedSessionId).toBe(IDS.waiting); // 95 sn bekliyor
    expect(useBoard.getState().focusProjectId).toBe('p1demoapp');
    useBoard.getState().goToNextWaiting();
    expect(useBoard.getState().selectedSessionId).toBe(IDS.waiting2);
    expect(useBoard.getState().focusProjectId).toBe('p3docs');
    useBoard.getState().goToNextWaiting();
    expect(useBoard.getState().selectedSessionId).toBe(IDS.waiting);
  });

  it('bekleyen yoksa hiçbir şey yapmaz', () => {
    const snap = makeSnapshot(NOW);
    snap.sessions = snap.sessions.filter((x) => x.status !== 'waiting');
    useBoard.getState().setSnapshot(snap);
    useBoard.getState().select(IDS.idle);
    useBoard.getState().goToNextWaiting();
    expect(useBoard.getState().selectedSessionId).toBe(IDS.idle);
  });
});

describe('subscribeEvents', () => {
  it('bir dinleyicinin hatası diğerlerini durdurmaz; abonelikten çıkış çalışır', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = vi.fn(() => {
      throw new Error('patladı');
    });
    const b = vi.fn();
    const offA = subscribeEvents(a);
    const offB = subscribeEvents(b);
    const ev = [{ type: 'prompt' as const, sessionId: IDS.busy, label: 'x', at: NOW }];
    emitEvents(ev);
    expect(b).toHaveBeenCalledWith(ev);
    expect(err).toHaveBeenCalled();
    offA();
    offB();
    emitEvents(ev);
    expect(b).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it("olaylar store'u değiştirmez (React commit'i yok)", () => {
    const spy = vi.fn();
    const off = useBoard.subscribe(spy);
    emitEvents([{ type: 'prompt', sessionId: IDS.busy, label: 'x', at: NOW }]);
    expect(spy).not.toHaveBeenCalled();
    off();
  });
});

describe('initBoardBridge', () => {
  type Handlers = { [K in keyof IpcEventMap]?: (p: IpcEventMap[K]) => void };
  function fakeApi(result: () => Promise<unknown>) {
    const handlers: Handlers = {};
    const offs: string[] = [];
    const api = {
      invoke: vi.fn(result),
      on: (ch: keyof IpcEventMap, cb: never) => {
        (handlers as Record<string, unknown>)[ch] = cb;
        return () => offs.push(ch);
      },
    } as unknown as DijiApi;
    return { api, handlers, offs };
  }

  afterEach(() => vi.useRealTimers());

  it("ilk snapshot'ı alır, olayları yayar, ui:selectSession seçer ve focus'u değiştirir", async () => {
    const snap = makeSnapshot(NOW);
    const { api, handlers, offs } = fakeApi(async () => ({ ok: true, data: snap }));
    const dispose = initBoardBridge(api);
    await vi.waitFor(() => expect(useBoard.getState().connection).toBe('live'));
    expect(useBoard.getState().snapshot).toBe(snap);

    const seen = vi.fn();
    const off = subscribeEvents(seen);
    handlers['board:events']?.([{ type: 'prompt', sessionId: IDS.busy, label: 'x', at: NOW }]);
    expect(seen).toHaveBeenCalledOnce();
    off();

    handlers['ui:selectSession']?.({ sessionId: IDS.idle });
    expect(useBoard.getState().selectedSessionId).toBe(IDS.idle);
    expect(useBoard.getState().focusProjectId).toBe('p3docs');

    handlers['app:toast']?.({ level: 'warn', message: 'dikkat' });
    expect(useToasts.getState().toasts.at(-1)?.message).toBe('dikkat');

    dispose();
    expect(offs.sort()).toEqual(['app:toast', 'board:events', 'board:snapshot', 'ui:selectSession']);
  });

  it('hata dönerse connection:error + toast, 5 sn sonra bir kez yeniden dener', async () => {
    vi.useFakeTimers();
    const { api } = fakeApi(async () => ({
      ok: false,
      error: { code: 'NOT_IMPLEMENTED', message: 'Henüz hazır değil.' },
    }));
    const dispose = initBoardBridge(api);
    await vi.advanceTimersByTimeAsync(0);
    expect(useBoard.getState().connection).toBe('error');
    expect(useToasts.getState().toasts.map((t) => t.message)).toContain('Motora bağlanılamadı, yeniden deneniyor.');
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(api.invoke).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(RETRY_MS * 3);
    expect(api.invoke).toHaveBeenCalledTimes(2);
    dispose();
  });

  it('window.diji yoksa connection:error', () => {
    initBoardBridge(undefined);
    expect(useBoard.getState().connection).toBe('error');
  });
});
