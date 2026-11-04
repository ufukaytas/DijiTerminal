import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { DijiApi } from '@shared/ipc';
import { App } from '@renderer/App';
import { Shell } from '@renderer/components/Shell';
import { Header, MAX_SEGMENTS } from '@renderer/components/Header';
import { activeClockCount } from '@renderer/hooks/useNow';
import { resetBoard, useBoard } from '@renderer/state/board';
import { IDS, makeSnapshot } from './__fixtures__/snapshot';

const NOW = 1_800_000_000_000;

beforeEach(() => resetBoard());
afterEach(() => {
  cleanup();
  delete window.diji;
});

describe('Shell', () => {
  it('beş yuvayı doğru sütunlara yerleştirir', () => {
    render(<Shell header={<header>H</header>} detail={<i>D</i>} workers={<i>W</i>} map={<i>M</i>} log={<i>L</i>} />);
    const app = document.querySelector('.app')!;
    expect(app.getAttribute('data-motion')).toBe('full');
    const side = app.querySelector('.stage > .side')!;
    expect(side.textContent).toBe('DW');
    expect(app.querySelector('.stage > .scene')!.textContent).toBe('M');
    expect(app.querySelector('.stage')!.lastElementChild!.textContent).toBe('L');
  });

  it('sistem "hareketi azalt" tercihinde data-motion=reduced', () => {
    const mm = vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const orig = window.matchMedia;
    window.matchMedia = mm as unknown as typeof window.matchMedia;
    render(<Shell header={null} detail={null} workers={null} map={null} log={null} />);
    expect(document.querySelector('.app')!.getAttribute('data-motion')).toBe('reduced');
    window.matchMedia = orig;
  });
});

describe('Header', () => {
  it('booted değilken sayaçlar —, bekleyen yokken buton pasif', () => {
    render(<Header />);
    expect(screen.getByText('— proje · — session')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Bekleyene git' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("sayaçlar snapshot'la güncellenir; segment focus'u, buton bekleyeni seçer", () => {
    act(() => useBoard.getState().setSnapshot(makeSnapshot(NOW)));
    render(<Header />);
    expect(screen.getByText('3 proje · 5 session')).toBeTruthy();
    expect(screen.getByText('2 bekliyor').className).toContain('c-wait');
    const seg = screen.getByRole('group', { name: 'Proje odağı' });
    act(() => fireEvent.click(within(seg).getByRole('button', { name: /agent-lab/ })));
    expect(useBoard.getState().focusProjectId).toBe('p2agents');
    expect(
      within(seg)
        .getByRole('button', { name: /agent-lab/ })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    act(() => useBoard.getState().select(IDS.busy));
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Bekleyene git' })));
    expect(useBoard.getState().selectedSessionId).toBe(IDS.waiting);
    expect(useBoard.getState().focusProjectId).toBe('p1demoapp');
  });

  it('8\'den fazla projede kalanlar "+N" menüsüne düşer', () => {
    const snap = makeSnapshot(NOW);
    const base = snap.projects[0]!;
    snap.projects = Array.from({ length: 12 }, (_, i) => ({
      ...base,
      id: `proj${i}`,
      name: `proje-${i}`,
      sessionIds: [],
    }));
    act(() => useBoard.getState().setSnapshot(snap));
    render(<Header />);
    const seg = screen.getByRole('group', { name: 'Proje odağı' });
    expect(within(seg).getAllByRole('button')).toHaveLength(MAX_SEGMENTS + 1);
    const more = within(seg).getByRole('combobox', { name: 'Diğer 4 proje' });
    act(() => fireEvent.change(more, { target: { value: 'proj10' } }));
    expect(useBoard.getState().focusProjectId).toBe('proj10');
  });
});

describe('App', () => {
  it('köprüden snapshot alır; harita, detay ve log dolar; saat tek timer kullanır', async () => {
    const snap = makeSnapshot(Date.now());
    window.diji = {
      invoke: vi.fn(async (ch: string) =>
        ch === 'board:getSnapshot'
          ? { ok: true, data: snap }
          : { ok: false, error: { code: 'NOT_IMPLEMENTED', message: 'x' } },
      ),
      on: () => () => {},
    } as unknown as DijiApi;
    render(<App />);
    await screen.findByRole('heading', { level: 3, name: 'ödeme akışı' });
    const map = screen.getByLabelText('Session haritası');
    expect(within(map).getAllByRole('button', { pressed: true })).toHaveLength(1);
    act(() => fireEvent.click(within(map).getByRole('button', { name: /docs düzeltmeleri/ })));
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('docs düzeltmeleri');
    expect(activeClockCount()).toBe(1);
  });

  it('booted:false iken "okunuyor", session yokken boş durum ve hook kurulum butonu', async () => {
    const install = vi.fn(async () => ({
      ok: true,
      data: { installed: true, statusLine: 'ours', settingsPath: '', backupPath: null },
    }));
    window.diji = {
      invoke: vi.fn(async (ch: string) => {
        if (ch === 'board:getSnapshot')
          return { ok: true, data: { ...makeSnapshot(NOW), booted: false, sessions: [], projects: [], log: [] } };
        if (ch === 'hooks:status')
          return { ok: true, data: { installed: false, statusLine: 'none', settingsPath: '', backupPath: null } };
        if (ch === 'hooks:install') return install();
        return { ok: false, error: { code: 'NOT_IMPLEMENTED', message: 'x' } };
      }),
      on: () => () => {},
    } as unknown as DijiApi;
    render(<App />);
    expect(await screen.findByText("Session'lar okunuyor…")).toBeTruthy();
    act(() => useBoard.getState().setSnapshot({ ...makeSnapshot(NOW), sessions: [], projects: [], log: [] }));
    expect(screen.getByText(/Henüz çalışan Claude Code session'ı yok/)).toBeTruthy();
    const btn = await screen.findByRole('button', { name: "Anlık durum için hook'ları kur" });
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(install).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: "Anlık durum için hook'ları kur" })).toBeNull();
  });
});
