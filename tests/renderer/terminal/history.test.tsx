// 07/01: Geçmiş penceresi — liste, arama, "Aktif et" → haritaya geri getirip terminalde açar.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { DijiApi } from '@shared/ipc';
import type { BackgroundHistoryItem } from '@shared/types';
import { HistoryDialog } from '@renderer/components/terminal/HistoryDialog';
import { resetBoard } from '@renderer/state/board';
import { __resetTerminals, useTerminals } from '@renderer/state/terminals';

const SID = '77777777-7777-4777-8777-777777777777';
const item = (p: Partial<BackgroundHistoryItem>): BackgroundHistoryItem => ({
  id: '1a2b3c4d',
  sessionId: SID,
  name: 'turkish-greeting-wait',
  title: 'merhaba de ve bekle',
  cwd: '/Users/demo/tmp',
  projectId: null,
  state: 'done',
  reason: 'closed',
  startedAt: 1_800_000_000_000,
  lastTs: 1_800_000_100_000,
  restorable: true,
  ...p,
});

let invoke: ReturnType<typeof vi.fn>;
beforeEach(() => {
  resetBoard();
  invoke = vi.fn(async (ch: string) => {
    if (ch === 'session:history')
      return {
        ok: true,
        data: [
          item({}),
          item({
            id: '2a2b3c4d',
            name: 'say-hello',
            reason: 'stopped',
            sessionId: '66666666-6666-4666-8666-666666666666',
          }),
        ],
      };
    if (ch === 'session:restoreBackground') return { ok: true, data: { sessionId: SID } };
    if (ch === 'term:open') return { ok: true, data: { termId: 't-00000001', sessionId: SID, reused: false } };
    return { ok: true, data: null };
  });
  const api = { invoke, on: () => () => undefined } as unknown as DijiApi;
  window.diji = api;
  __resetTerminals(api);
});
afterEach(() => {
  cleanup();
  delete window.diji;
});

describe('HistoryDialog', () => {
  it('listeler, arar; Aktif et haritaya getirir, terminalde açar ve pencereyi kapatır', async () => {
    const onClose = vi.fn();
    render(<HistoryDialog onClose={onClose} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText('turkish-greeting-wait')).toBeTruthy();
    expect(screen.getByText('kapatıldı')).toBeTruthy();
    expect(screen.getByText('durduruldu')).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'say' } });
    expect(screen.queryByText('turkish-greeting-wait')).toBeNull();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Aktif et' })[0] as HTMLElement);
    });
    expect(invoke).toHaveBeenCalledWith('session:restoreBackground', '1a2b3c4d');
    expect(onClose).toHaveBeenCalled();
    await act(async () => {
      await Promise.resolve();
    });
    expect(invoke).toHaveBeenCalledWith('term:open', SID, 120, 24);
    expect(useTerminals.getState().tabs).toHaveLength(1);
  });
});
