// 07/01: Yeni oturum penceresi — odak yalnızca açılışta (üst bar yeniden çizilince görev kutusundan kaçmaz).
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { NewSessionDialog } from '@renderer/components/terminal/NewSessionDialog';
import { resetBoard, useBoard } from '@renderer/state/board';
import { makeSnapshot } from '../__fixtures__/snapshot';

afterEach(() => cleanup());

describe('NewSessionDialog', () => {
  it('açılışta proje seçimi odaklanır; yeniden render (yeni onClose) odağı görev kutusundan almaz', () => {
    resetBoard();
    act(() => useBoard.getState().setSnapshot(makeSnapshot(1_800_000_000_000)));
    const { rerender } = render(<NewSessionDialog onClose={() => undefined} />);
    expect(document.activeElement?.tagName).toBe('SELECT');
    const task = screen.getByRole('textbox');
    act(() => task.focus());
    rerender(<NewSessionDialog onClose={() => undefined} />);
    act(() => useBoard.getState().setSnapshot(makeSnapshot(1_800_000_001_000)));
    expect(document.activeElement).toBe(task);
  });
});
