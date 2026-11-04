// 04/03 — ayarlar panelinde kısayollar: kaydetme alanı, hazır setler, çakışma işareti; etiket öneki.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DijiApi } from '@shared/ipc';
import { DEFAULT_SETTINGS, mergeSettings } from '@shared/settings';
import type { AppSettings, ShortcutReport } from '@shared/types';
import { SettingsPanel } from '@renderer/components/SettingsPanel';
import { fmtHotkey, setHotkeyPrefix } from '@renderer/lib/format';
import { resetBoard } from '@renderer/state/board';
import { initSettingsBridge, useSettings } from '@renderer/state/settings';

const REPORT: ShortcutReport = {
  enabled: true,
  items: [
    { command: 'focusWaiting', accelerator: 'Control+Alt+W', registered: false, reason: 'conflict' },
    { command: 'toggleBoard', accelerator: 'Control+Alt+D', registered: true },
    ...Array.from({ length: 9 }, (_, i) => ({ command: `session-${i + 1}` as const, accelerator: `Control+Alt+${i + 1}`, registered: true })),
  ] as ShortcutReport['items'],
};

function mkApi() {
  let value: AppSettings = DEFAULT_SETTINGS;
  const listeners = new Map<string, (p: unknown) => void>();
  const invoke = vi.fn(async (ch: string, arg?: unknown) => {
    if (ch === 'settings:get') return { ok: true, data: value };
    if (ch === 'settings:set') {
      value = mergeSettings(value, arg as never);
      return { ok: true, data: value };
    }
    if (ch === 'shortcuts:status') return { ok: true, data: REPORT };
    return { ok: false, error: { code: 'NOT_IMPLEMENTED', message: '' } };
  });
  const api = { invoke, on: (ch: string, cb: (p: unknown) => void) => (listeners.set(ch, cb), () => listeners.delete(ch)) } as unknown as DijiApi;
  return { api, invoke, emit: (ch: string, p: unknown) => listeners.get(ch)?.(p) };
}

let dispose: (() => void) | null = null;
async function setup() {
  const m = mkApi();
  window.diji = m.api;
  dispose = initSettingsBridge(m.api);
  await waitFor(() => expect(useSettings.getState().value).not.toBeNull());
  render(<SettingsPanel />);
  act(() => useSettings.getState().setOpen(true));
  await screen.findByText('Kısayollar');
  return m;
}

beforeEach(() => {
  resetBoard();
  useSettings.setState({ value: null, open: false, errors: {}, hooks: null, hookBusy: false, hookError: null, shortcutReport: null });
});
afterEach(() => {
  cleanup();
  dispose?.();
  dispose = null;
  setHotkeyPrefix('⌃⌥');
});

describe('Kısayol ayarları', () => {
  it('çakışan kısayol satırında uyarı', async () => {
    await setup();
    expect(await screen.findByText('⌃⌥W başka bir uygulama tarafından kullanılıyor')).toBeTruthy();
  });

  it('alana tıklayıp tuşa basınca kısayol kaydedilir; ⌥ ile değişen karakter sorun değil', async () => {
    const { invoke } = await setup();
    const field = screen.getByLabelText(/Kısayol ⌃⌥W/);
    fireEvent.click(field);
    fireEvent.keyDown(field, { key: 'œ', code: 'KeyQ', ctrlKey: true, altKey: true });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('settings:set', { shortcuts: { focusWaiting: 'Control+Alt+Q' } }));
  });

  it('önek alanı yalnızca değiştiricileri alır', async () => {
    const { invoke } = await setup();
    const field = screen.getByLabelText(/Kısayol ⌃⌥1 … ⌃⌥9/);
    fireEvent.click(field);
    fireEvent.keyDown(field, { key: '3', code: 'Digit3', metaKey: true, altKey: true });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('settings:set', { shortcuts: { sessionPrefix: 'Alt+Command' } }));
  });

  it('alternatif set uyarı gösterir ve etiket öneki ⌘ olur', async () => {
    await setup();
    fireEvent.click(screen.getByRole('button', { name: 'Alternatif (⌘)' }));
    expect(await screen.findByText(/iTerm2'nin ⌘⌥1–9/)).toBeTruthy();
    await waitFor(() => expect(fmtHotkey(3)).toBe('⌥⌘3'));
  });

  it('kısayollar kapatılınca numara etiketi gösterilmez', async () => {
    await setup();
    fireEvent.click(screen.getByLabelText(/Global kısayollar/));
    await waitFor(() => expect(fmtHotkey(2)).toBeNull());
  });

  it('shortcuts:report olayı raporu günceller', async () => {
    const { emit } = await setup();
    act(() => emit('shortcuts:report', { enabled: true, items: REPORT.items.map((i) => ({ ...i, registered: true, reason: undefined })) }));
    await waitFor(() => expect(screen.queryByText(/başka bir uygulama/)).toBeNull());
  });
});
