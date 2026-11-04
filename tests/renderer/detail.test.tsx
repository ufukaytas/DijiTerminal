import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { THRESHOLDS } from '@shared/constants';
import type { DijiApi } from '@shared/ipc';
import { DetailPanel } from '@renderer/components/detail/DetailPanel';
import { resetBoard, useBoard } from '@renderer/state/board';
import { useToasts } from '@renderer/state/toast';
import { IDS, makeSnapshot } from './__fixtures__/snapshot';

const NOW = 1_800_000_000_000;

function setApi(invoke: (...a: unknown[]) => Promise<unknown>) {
  window.diji = { invoke: vi.fn(invoke), on: () => () => {} } as unknown as DijiApi;
  return window.diji.invoke as unknown as ReturnType<typeof vi.fn>;
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  resetBoard();
  useToasts.setState({ toasts: [] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete window.diji;
});

const panel = () => screen.getByRole('region', { name: 'Seçili session' });

describe('DetailPanel', () => {
  it('seçim yokken boş durum, booted değilken iskelet', () => {
    render(<DetailPanel />);
    expect(panel().querySelector('.skel')).toBeTruthy();
    act(() => {
      const s = makeSnapshot(NOW);
      s.sessions = [];
      useBoard.getState().setSnapshot(s);
    });
    expect(screen.getByText('Haritada bir session seçin.')).toBeTruthy();
  });

  it('bekleyen session: başlık, rozet, bekleme kutusu, süre saniyede ilerliyor', () => {
    act(() => useBoard.getState().setSnapshot(makeSnapshot(NOW)));
    render(<DetailPanel />);
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('ödeme akışı');
    const box = panel().querySelector('.d-wait') as HTMLElement;
    expect(box.textContent).toContain('Onayınızı bekliyor · 1:35');
    expect(box.textContent).toContain('Bash · npm run migrate');
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(box.textContent).toContain('1:37');
  });

  it("bekleme kutusu yalnızca waiting'de", () => {
    act(() => {
      useBoard.getState().setSnapshot(makeSnapshot(NOW));
      useBoard.getState().select(IDS.busy);
    });
    render(<DetailPanel />);
    expect(panel().querySelector('.d-wait')).toBeNull();
    expect(panel().querySelector('.pill')?.textContent).toBe('çalışıyor');
  });

  it('3 dakikayı aşan araç satırı kırmızı "yavaş"', () => {
    act(() => {
      useBoard.getState().setSnapshot(makeSnapshot(NOW));
      useBoard.getState().select(IDS.team);
    });
    render(<DetailPanel />);
    const row = panel().querySelector('[data-agent="a2"] .a-now') as HTMLElement; // 200 sn'dir çalışan Bash
    expect(row.dataset['slow']).toBe('true');
    expect(row.textContent).toContain('yavaş');
    const fresh = panel().querySelector('[data-agent="a1"] .a-now') as HTMLElement; // 12 sn
    expect(fresh.dataset['slow']).toBeUndefined();
    act(() => {
      vi.advanceTimersByTime(THRESHOLDS.slowToolMs);
    });
    expect(fresh.dataset['slow']).toBe('true');
  });

  it('ctx %80 üstünde çubuk uyarı rengine geçer; ana ajan alt ajanları bekliyor', () => {
    act(() => {
      useBoard.getState().setSnapshot(makeSnapshot(NOW));
      useBoard.getState().select(IDS.team);
    });
    render(<DetailPanel />);
    expect(panel().querySelector('.ctx.warn')).toBeTruthy();
    expect(within(panel()).getByText('2 ajanın dönmesini bekliyor')).toBeTruthy();
    expect(within(panel()).getByText('çakışma')).toBeTruthy();
  });

  it('snapshot değişip aynı session kaldığında buton DOM düğümü aynı kalır', () => {
    act(() => useBoard.getState().setSnapshot(makeSnapshot(NOW)));
    render(<DetailPanel />);
    const before = screen.getByRole('button', { name: /iTerm2 sekmesine git/ });
    before.focus();
    act(() => useBoard.getState().setSnapshot(makeSnapshot(NOW + 1000)));
    const after = screen.getByRole('button', { name: /iTerm2 sekmesine git/ });
    expect(after).toBe(before);
    expect(document.activeElement).toBe(before);
  });

  it('focusTerminal başarılıysa 1.5 sn "Açıldı", hata dönerse toast', async () => {
    const invoke = setApi(async () => ({ ok: true, data: { app: 'iterm2' } }));
    act(() => useBoard.getState().setSnapshot(makeSnapshot(NOW)));
    render(<DetailPanel />);
    const btn = screen.getByRole('button', { name: /iTerm2 sekmesine git/ });
    expect(btn.textContent).toContain('⌃⌥1');
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(invoke).toHaveBeenCalledWith('action:focusTerminal', IDS.waiting);
    expect(btn.textContent).toContain('Açıldı');
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(btn.textContent).toContain('iTerm2 sekmesine git');

    invoke.mockImplementation(async () => ({ ok: false, error: { code: 'PERMISSION', message: 'izin yok' } }));
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(useToasts.getState().toasts.at(-1)?.message).toBe("iTerm2'yi kontrol etmek için Otomasyon izni gerekiyor.");
  });

  it('terminal yoksa buton pasif ve not görünür', () => {
    act(() => {
      useBoard.getState().setSnapshot(makeSnapshot(NOW));
      useBoard.getState().select(IDS.idle);
    });
    render(<DetailPanel />);
    expect((screen.getByRole('button', { name: /iTerm2 sekmesine git/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Terminal bulunamadı')).toBeTruthy();
  });

  it('seçili session düşerse "Bu session sona erdi" ve butonlar pasif', () => {
    act(() => {
      useBoard.getState().setSnapshot(makeSnapshot(NOW));
      useBoard.getState().select(IDS.busy);
    });
    render(<DetailPanel />);
    act(() => {
      const s = makeSnapshot(NOW + 1000);
      s.sessions = s.sessions.filter((x) => x.id !== IDS.busy);
      useBoard.getState().setSnapshot(s);
    });
    expect(screen.getByText('Bu session sona erdi')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('api refaktör');
    expect((screen.getByRole('button', { name: /iTerm2 sekmesine git/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("8'den fazla bitmiş ajan katlanır, tıklayınca açılır", () => {
    const s = makeSnapshot(NOW);
    const team = s.sessions.find((x) => x.id === IDS.team)!;
    const done = team.agents.find((a) => a.id === 'a3')!;
    team.agents = [
      ...team.agents,
      ...Array.from({ length: 11 }, (_, i) => ({ ...done, id: `d${i}`, name: `bitti-${i}` })),
    ];
    act(() => {
      useBoard.getState().setSnapshot(s);
      useBoard.getState().select(IDS.team);
    });
    render(<DetailPanel />);
    const fold = screen.getByRole('button', { name: '+4 bitti' });
    fireEvent.click(fold);
    expect(screen.queryByRole('button', { name: /bitti$/ })).toBeNull();
    expect(screen.getByText('bitti-10')).toBeTruthy();
  });

  it('haritada robota tıklanan ajanın satırı vurgulanır (katlanmış olsa da görünür); başka seçimde kalkar', () => {
    const s = makeSnapshot(NOW);
    const team = s.sessions.find((x) => x.id === IDS.team)!;
    const done = team.agents.find((a) => a.id === 'a3')!;
    team.agents = [
      ...team.agents,
      ...Array.from({ length: 11 }, (_, i) => ({ ...done, id: `d${i}`, name: `bitti-${i}` })),
    ];
    act(() => {
      useBoard.getState().setSnapshot(s);
      useBoard.getState().select(IDS.team, 'd10');
    });
    render(<DetailPanel />);
    const row = panel().querySelector('li[data-agent="d10"]') as HTMLElement;
    expect(row.classList.contains('focus')).toBe(true);
    expect(row.getAttribute('aria-current')).toBe('true');
    expect(panel().querySelectorAll('li.focus')).toHaveLength(1);
    act(() => useBoard.getState().select(IDS.team));
    expect(panel().querySelectorAll('li.focus')).toHaveLength(0);
  });
});
