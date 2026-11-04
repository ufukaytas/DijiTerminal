// Üst barda limit çubukları (02/08): veri yoksa hiç yok; seviye sınıfı; bayat veri soluk.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { Header } from '@renderer/components/Header';
import { resetBoard, useBoard } from '@renderer/state/board';
import { makeSnapshot } from './__fixtures__/snapshot';

beforeEach(() => resetBoard());
afterEach(() => cleanup());

describe('Header limitleri', () => {
  it('limits null → bölüm yok', () => {
    act(() => useBoard.getState().setSnapshot({ ...makeSnapshot(), limits: null }));
    render(<Header />);
    expect(screen.queryByLabelText('Kullanım limitleri')).toBeNull();
  });

  it('5s ve hafta; ≥85 uyarı rengi; 6 saatten eski soluk', () => {
    const now = Date.now();
    act(() =>
      useBoard.getState().setSnapshot({
        ...makeSnapshot(now),
        limits: { fiveHour: { pct: 88.4, resetsAt: now + 3_600_000 }, week: { pct: 61, resetsAt: now + 86_400_000 * 3 }, at: now - 7 * 3_600_000 },
      }),
    );
    const { container } = render(<Header />);
    const box = screen.getByLabelText('Kullanım limitleri');
    expect(box.className).toContain('stale');
    expect(screen.getByText('%88')).toBeTruthy();
    expect(screen.getByText('%61')).toBeTruthy();
    expect(container.querySelector('.limit.l-warn .limit-label')?.textContent).toBe('5s');
  });
});
