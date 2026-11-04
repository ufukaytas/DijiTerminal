import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { BoardSnapshot, LogEntry } from '@shared/types';
import { SessionLogPanel } from '@renderer/components/log/SessionLogPanel';
import { LOG_FILTER_KEY } from '@renderer/components/log/filterLog';
import { ROW_HEIGHT } from '@renderer/components/log/LogRow';
import { resetBoard, useBoard } from '@renderer/state/board';
import { IDS, makeSnapshot } from './__fixtures__/snapshot';

const NOW = 1_800_000_000_000;

function withNew(base: BoardSnapshot, n: number, at: number): BoardSnapshot {
  const fresh: LogEntry[] = Array.from({ length: n }, (_, i) => ({
    id: `new-${at}-${i}`,
    ts: at - i,
    sessionId: IDS.busy,
    agentId: null,
    kind: 'tool',
    category: 'read',
    toolName: 'Read',
    label: `src/yeni-${i}.ts`,
    state: 'ok',
    durationMs: 50,
  }));
  return { ...base, at, log: [...fresh, ...base.log] };
}

const scroller = () => screen.getByTestId('log-scroll');
const rowIds = () => [...document.querySelectorAll<HTMLElement>('.log-row')].map((r) => r.dataset['id']);

// jsdom yerleşim yapmaz (offsetHeight = 0); sanallaştırıcının göreceği kaydırma alanı boyutunu veriyoruz.
const desc = {
  h: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight'),
  w: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth'),
};
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('log-scroll') ? 600 : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('log-scroll') ? 320 : 0;
    },
  });
});
afterAll(() => {
  if (desc.h) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', desc.h);
  if (desc.w) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', desc.w);
});

beforeEach(() => {
  resetBoard();
  window.localStorage.clear();
});
afterEach(() => cleanup());

describe('SessionLogPanel', () => {
  it('boş log ve booted:false durumları', () => {
    render(<SessionLogPanel />);
    expect(document.querySelector('.log-skel')).toBeTruthy();
    act(() => useBoard.getState().setSnapshot({ ...makeSnapshot(NOW), log: [] }));
    expect(screen.getByText('Henüz araç çağrısı yok.')).toBeTruthy();
  });

  it("yalnızca görünen satırlar DOM'da; ilk yüklemede flash yok, yeni kayıt en üstteyken flash alır", () => {
    act(() => useBoard.getState().setSnapshot(makeSnapshot(NOW)));
    render(<SessionLogPanel />);
    const total = useBoard.getState().snapshot.log.length;
    const rows = document.querySelectorAll('.log-row');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(total);
    expect(document.querySelectorAll('.log-row.new').length).toBe(0);

    act(() => useBoard.getState().setSnapshot(withNew(useBoard.getState().snapshot, 2, NOW + 1000)));
    const fresh = document.querySelectorAll<HTMLElement>('.log-row.new');
    expect([...fresh].map((r) => r.dataset['id'])).toEqual([`new-${NOW + 1000}-0`, `new-${NOW + 1000}-1`]);
    expect(screen.queryByText(/yeni satır/)).toBeNull();
  });

  it('aşağı kaydırılmışken hap görünür ve bakılan satır yerinde kalır', () => {
    act(() => useBoard.getState().setSnapshot(makeSnapshot(NOW)));
    render(<SessionLogPanel />);
    const el = scroller();
    const before = useBoard.getState().snapshot.log;
    act(() => {
      el.scrollTop = ROW_HEIGHT * 10;
      fireEvent.scroll(el);
    });
    const anchorId = before[10]!.id;

    act(() => useBoard.getState().setSnapshot(withNew(useBoard.getState().snapshot, 3, NOW + 1000)));
    expect(el.scrollTop).toBe(ROW_HEIGHT * 13);
    expect(useBoard.getState().snapshot.log[Math.floor(el.scrollTop / ROW_HEIGHT)]!.id).toBe(anchorId);
    expect(screen.getByRole('button', { name: '3 yeni satır ↑' })).toBeTruthy();

    act(() => useBoard.getState().setSnapshot(withNew(useBoard.getState().snapshot, 2, NOW + 2000)));
    const pill = screen.getByRole('button', { name: '5 yeni satır ↑' });
    act(() => fireEvent.click(pill));
    expect(el.scrollTop).toBe(0);
    expect(screen.queryByText(/yeni satır/)).toBeNull();
  });

  it("satır tıklaması session'ı seçer ve haritayı projesine odaklar", () => {
    act(() => useBoard.getState().setSnapshot(makeSnapshot(NOW)));
    render(<SessionLogPanel />);
    const row = document.querySelector<HTMLElement>('.log-row[data-id="l-wait-1"]')!;
    act(() => fireEvent.click(row));
    expect(useBoard.getState().selectedSessionId).toBe(IDS.waiting2);
    expect(useBoard.getState().focusProjectId).toBe('p3docs');
  });

  it('satır biçimi: çalışan, bekleyen, hata ve tamamlanan sonuçlar', () => {
    act(() => useBoard.getState().setSnapshot(makeSnapshot(NOW)));
    render(<SessionLogPanel />);
    const byId = (id: string) => document.querySelector<HTMLElement>(`.log-row[data-id="${id}"]`)!;
    expect(byId('l-run-1').querySelector('.r')!.textContent).toMatch(/^▶ /);
    expect(byId('l-wait-1').classList.contains('w')).toBe(true);
    expect(byId('l-wait-1').querySelector('.r')!.textContent).toBe('⏸ izin');
    expect(byId('l-err-1').querySelector('.r')!.textContent).toBe('✕ hata');
    expect(byId('l-0').querySelector('.r')!.textContent).toBe('✓ 0.3s');
    expect(byId('l-run-2').querySelector('.s')!.textContent).toBe('pazar araştırması ▸ audience-persona-writer');
    expect(byId('l-say-1').querySelector('.l')!.classList.contains('say')).toBe(true);
  });

  it('filtre: bash çipi, "filtreli · N/M" başlığı, tercih localStorage\'a yazılır, temizle', () => {
    act(() => useBoard.getState().setSnapshot(makeSnapshot(NOW)));
    render(<SessionLogPanel />);
    act(() => fireEvent.click(screen.getByRole('button', { name: 'bash' })));
    const ids = rowIds();
    const log = useBoard.getState().snapshot.log;
    expect(ids.every((id) => log.find((e) => e.id === id)?.category === 'bash')).toBe(true);
    expect(screen.getByText(/^filtreli · \d+\/\d+$/)).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem(LOG_FILTER_KEY)!).categories).toEqual(['bash']);

    act(() => fireEvent.click(screen.getByRole('button', { name: 'sadece hatalar' })));
    expect(rowIds()).toEqual(['l-err-1']);
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Temizle' })));
    expect(screen.getByText('canlı araç akışı · tüm projeler')).toBeTruthy();
  });

  it('filtre sonucu boşsa mesaj ve temizleme bağlantısı; tercih yeniden açılışta korunur', () => {
    window.localStorage.setItem(
      LOG_FILTER_KEY,
      JSON.stringify({ projectId: null, sessionId: IDS.idle, categories: ['mcp'], errorsOnly: false }),
    );
    act(() => useBoard.getState().setSnapshot(makeSnapshot(NOW)));
    render(<SessionLogPanel />);
    expect(screen.getByText(/Bu filtreyle kayıt yok/)).toBeTruthy();
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Filtreyi temizle' })));
    expect(rowIds().length).toBeGreaterThan(0);
  });

  it('klavye: ↓ sonraki satıra odak taşır (roving tabindex)', async () => {
    act(() => useBoard.getState().setSnapshot(makeSnapshot(NOW)));
    render(<SessionLogPanel />);
    const first = document.querySelector<HTMLElement>('.log-row[data-index="0"]')!;
    expect(first.tabIndex).toBe(0);
    first.focus();
    act(() => fireEvent.keyDown(first, { key: 'ArrowDown' }));
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    const second = document.querySelector<HTMLElement>('.log-row[data-index="1"]')!;
    expect(second.tabIndex).toBe(0);
    expect(first.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(second);
  });
});
