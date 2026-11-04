// 06/01 menü çubuğu açılır listesi: sıralama/özet (saf) ve bileşen davranışı (jsdom).
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DijiApi } from '@shared/ipc';
import { PopoverApp } from '@renderer/popover/PopoverApp';
import { popoverModel } from '@renderer/popover/model';
import { resetBoard } from '@renderer/state/board';
import { IDS, makeSnapshot } from './__fixtures__/snapshot';

const NOW = Date.now();

function mkApi(o: { focusFails?: boolean } = {}) {
  const snap = makeSnapshot(NOW);
  const listeners = new Map<string, (p: unknown) => void>();
  const invoke = vi.fn(async (ch: string, ..._args: unknown[]) => {
    switch (ch) {
      case 'board:getSnapshot':
        return { ok: true, data: snap };
      case 'action:focusTerminal':
        return o.focusFails
          ? { ok: false, error: { code: 'NOT_FOUND', message: 'Terminal bulunamadı.' } }
          : { ok: true, data: { app: 'iterm2' } };
      case 'tray:command':
        return { ok: true, data: null };
      default:
        return { ok: false, error: { code: 'NOT_IMPLEMENTED', message: '' } };
    }
  });
  const api = {
    invoke,
    on: (ch: string, cb: (p: unknown) => void) => {
      listeners.set(ch, cb);
      return () => listeners.delete(ch);
    },
  } as unknown as DijiApi;
  return { api, invoke, snap, emit: (ch: string, p: unknown) => listeners.get(ch)?.(p) };
}

beforeEach(() => resetBoard());
afterEach(() => cleanup());

describe('popoverModel', () => {
  it('bekleyenler (en eskisi) üstte, sonra çalışanlar, sonra boştakiler; sona erenler yok', () => {
    const m = popoverModel(makeSnapshot(NOW));
    const st = m.rows.map((r) => r.session.status);
    expect(st.indexOf('ended')).toBe(-1);
    expect(st).toEqual(
      [...st].sort((a, b) => ['waiting', 'busy', 'idle'].indexOf(a) - ['waiting', 'busy', 'idle'].indexOf(b)),
    );
    const waits = m.rows
      .filter((r) => r.session.status === 'waiting')
      .map((r) => r.session.waitingFor?.since ?? r.session.statusSince);
    expect(waits).toEqual([...waits].sort((a, b) => a - b));
    expect(m.rows.every((r) => r.project !== null)).toBe(true);
    expect(m.summary).toMatch(/bekliyor/);
  });
  it('özet: açılış, boş, hepsi boşta', () => {
    const s = makeSnapshot(NOW);
    expect(popoverModel({ ...s, booted: false }).summary).toBe('Başlatılıyor…');
    expect(popoverModel({ ...s, sessions: [] }).summary).toBe('Açık session yok');
    const idle = {
      ...s,
      sessions: s.sessions.map((x) => ({ ...x, status: 'idle' as const })),
      totals: { ...s.totals, waiting: 0 },
    };
    expect(popoverModel(idle).summary).toBe('Hepsi boşta');
  });
});

describe('PopoverApp', () => {
  it('satıra tıklayınca sekmeye gider ve listeyi kapatır', async () => {
    const m = mkApi();
    render(<PopoverApp api={m.api} />);
    const list = await screen.findByRole('list', { name: "Session'lar" });
    const first = within(list).getAllByTitle('iTerm2 sekmesine git')[0]!;
    fireEvent.click(first);
    await waitFor(() => expect(m.invoke).toHaveBeenCalledWith('tray:command', 'close'));
    const focusCall = m.invoke.mock.calls.find((c) => c[0] === 'action:focusTerminal');
    expect([IDS.waiting, IDS.waiting2]).toContain(focusCall?.[1]);
  });

  it('sekmeye gidilemezse liste açık kalır ve hata gösterilir', async () => {
    const m = mkApi({ focusFails: true });
    render(<PopoverApp api={m.api} />);
    const list = await screen.findByRole('list', { name: "Session'lar" });
    fireEvent.click(within(list).getAllByTitle('iTerm2 sekmesine git')[0]!);
    expect((await screen.findByRole('alert')).textContent).toBe('Terminal bulunamadı.');
    expect(m.invoke).not.toHaveBeenCalledWith('tray:command', 'close');
  });

  it("haritada göster, alt düğmeler ve Esc main'e komut gönderir", async () => {
    const m = mkApi();
    render(<PopoverApp api={m.api} />);
    await screen.findByRole('list', { name: "Session'lar" });
    fireEvent.click(screen.getAllByTitle('Haritada göster')[0]!);
    expect(m.invoke).toHaveBeenCalledWith('tray:command', 'showOnMap', expect.any(String));
    fireEvent.click(screen.getByText('Panoyu aç'));
    fireEvent.click(screen.getByText('Ayarlar'));
    fireEvent.click(screen.getByText('Çıkış'));
    fireEvent.keyDown(window, { key: 'Escape' });
    const cmds = m.invoke.mock.calls.filter((c) => c[0] === 'tray:command').map((c) => c[1]);
    expect(cmds).toEqual(['showOnMap', 'openBoard', 'openSettings', 'quit', 'close']);
  });

  it("main'den gelen snapshot listeyi günceller", async () => {
    const m = mkApi();
    render(<PopoverApp api={m.api} />);
    await screen.findByRole('list', { name: "Session'lar" });
    act(() => m.emit('board:snapshot', { ...m.snap, at: m.snap.at + 1, sessions: [] }));
    expect(screen.getByText(/açık session yok/)).toBeTruthy();
  });
});
