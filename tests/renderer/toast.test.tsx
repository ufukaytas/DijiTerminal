// Eylem düğmeli toast (04/02 → 'app:toastAction').
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastHost } from '@renderer/components/ToastHost';
import { pushToast, useToasts } from '@renderer/state/toast';

afterEach(() => {
  cleanup();
  useToasts.setState({ toasts: [] });
  delete (window as { diji?: unknown }).diji;
});

describe('ToastHost', () => {
  it('eylem varsa düğme gösterir; tıklanınca app:toastAction çağrılır ve toast kapanır', () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, data: null });
    (window as { diji?: unknown }).diji = { invoke, on: () => () => undefined };
    render(<ToastHost />);
    act(() => pushToast('warn', 'iTerm2 izni yok', { id: 'open-automation-settings', label: 'Ayarları aç' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ayarları aç' }));
    expect(invoke).toHaveBeenCalledWith('app:toastAction', 'open-automation-settings');
    expect(useToasts.getState().toasts).toHaveLength(0);
  });

  it('eylem yoksa yalnızca kapat düğmesi', () => {
    render(<ToastHost />);
    act(() => pushToast('info', 'merhaba'));
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Kapat']);
  });
});
