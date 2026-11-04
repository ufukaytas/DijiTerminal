// WorkersPanel (03/03): tıklama select + setFocus, boş durum, iskelet, bitmiş kart, sayaçlar.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CATEGORY_COLOR, SLOW_COLOR } from '@shared/constants';
import { WorkersPanel } from '@renderer/components/WorkersPanel';
import { resetBoard, useBoard } from '@renderer/state/board';
import { IDS, makeSnapshot } from './__fixtures__/snapshot';

const NOW = 1_800_000_000_000;

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  resetBoard();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const panel = () => screen.getByRole('region', { name: 'Workers' });
const card = (key: string) => panel().querySelector<HTMLButtonElement>(`button[data-key="${key}"]`)!;

describe('WorkersPanel', () => {
  it('booted değilken iskelet, subagent yoksa boş durum', () => {
    render(<WorkersPanel />);
    expect(panel().querySelector('.skel')).toBeTruthy();
    act(() => {
      const s = makeSnapshot(NOW);
      s.sessions = s.sessions.map((x) => ({ ...x, agents: x.agents.filter((a) => a.isMain) }));
      useBoard.getState().setSnapshot(s);
    });
    expect(screen.getByText(/Şu an çalışan subagent yok/)).toBeTruthy();
    expect(panel().textContent).toContain('0 çalışıyor');
  });

  it('kartlar ve başlık sayaçları; bitmiş kart sönük', () => {
    render(<WorkersPanel />);
    act(() => useBoard.getState().setSnapshot(makeSnapshot(NOW)));
    expect(panel().textContent).toContain('2 çalışıyor · 1 yeni bitti');
    expect(card(`${IDS.team}:a3`).className).toContain('done');
    expect(card(`${IDS.team}:a1`).className).not.toContain('done');
    expect(card(`${IDS.team}:a3`).textContent).toContain('5:00 önce');
  });

  it('sol kenar o anki aracın kategori rengi; yavaş araç kırmızı', () => {
    render(<WorkersPanel />);
    act(() => useBoard.getState().setSnapshot(makeSnapshot(NOW)));
    const color = (k: string) => card(k).style.borderLeftColor;
    const rgb = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
    };
    expect(color(`${IDS.team}:a1`)).toBe(rgb(CATEGORY_COLOR.web));
    expect(color(`${IDS.team}:a2`)).toBe(rgb(SLOW_COLOR)); // bash 200 sn > 3 dk
  });

  it("karta tıklama session'ı seçer ve haritayı projeye odaklar", () => {
    render(<WorkersPanel />);
    act(() => useBoard.getState().setSnapshot(makeSnapshot(NOW)));
    act(() => useBoard.getState().select(IDS.waiting));
    fireEvent.click(card(`${IDS.team}:a1`));
    expect(useBoard.getState().selectedSessionId).toBe(IDS.team);
    expect(useBoard.getState().focusProjectId).toBe('p2agents');
    expect(card(`${IDS.team}:a1`).getAttribute('aria-current')).toBe('true');
  });

  it("bitenler 15 dk sonra listeden düşer (5 sn'lik saatle)", () => {
    render(<WorkersPanel />);
    act(() => useBoard.getState().setSnapshot(makeSnapshot(NOW)));
    expect(card(`${IDS.team}:a3`)).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(10 * 60_000 + 5_000); // a3 5 dk önce bitmişti → toplam 15 dk+
    });
    expect(panel().querySelector(`button[data-key="${IDS.team}:a3"]`)).toBeNull();
  });

  it('değişmeyen kart yeniden render olmaz', async () => {
    const { workerCardEqual } = await import('@renderer/components/workers/WorkerCard');
    const { selectWorkers } = await import('@renderer/state/selectors');
    const a = selectWorkers(makeSnapshot(NOW), NOW).items[0]!;
    const b = selectWorkers(makeSnapshot(NOW), NOW).items[0]!;
    const onPick = () => undefined;
    expect(a).not.toBe(b);
    expect(workerCardEqual({ item: a, selected: false, onPick }, { item: b, selected: false, onPick })).toBe(true);
    const c = { ...b, agent: { ...b.agent, toolCount: b.agent.toolCount + 1 } };
    expect(workerCardEqual({ item: a, selected: false, onPick }, { item: c, selected: false, onPick })).toBe(false);
  });
});
