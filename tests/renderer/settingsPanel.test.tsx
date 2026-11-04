// 00/04 — ayarlar paneli: açma/kapama, iyimser güncelleme ve geri alma, hareket ayarı, hook onayı, gizli proje.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DijiApi } from '@shared/ipc';
import { DEFAULT_SETTINGS, mergeSettings } from '@shared/settings';
import type { AppSettings, HookInstallStatus } from '@shared/types';
import { SettingsPanel } from '@renderer/components/SettingsPanel';
import { resetBoard, useBoard } from '@renderer/state/board';
import { applyMotion, initSettingsBridge, useSettings } from '@renderer/state/settings';
import { makeSnapshot } from './__fixtures__/snapshot';

const HOOKS: HookInstallStatus = { installed: false, statusLine: 'none', settingsPath: '/Users/demo/.claude/settings.json', backupPath: null };

function mkApi(opts: { setFails?: boolean; initial?: AppSettings } = {}) {
  let value = opts.initial ?? DEFAULT_SETTINGS;
  const listeners = new Map<string, (p: unknown) => void>();
  const invoke = vi.fn(async (ch: string, arg?: unknown) => {
    switch (ch) {
      case 'settings:get':
        return { ok: true, data: value };
      case 'settings:set':
        if (opts.setFails) return { ok: false, error: { code: 'BAD_INPUT', message: 'Bu klasör bulunamadı.' } };
        value = mergeSettings(value, arg as never);
        return { ok: true, data: value };
      case 'hooks:status':
        return { ok: true, data: HOOKS };
      case 'hooks:install':
        return { ok: true, data: { ...HOOKS, installed: true, statusLine: 'ours' } };
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
  return { api, invoke, emit: (ch: string, p: unknown) => listeners.get(ch)?.(p) };
}

let dispose: (() => void) | null = null;
async function setup(o: Parameters<typeof mkApi>[0] = {}) {
  const m = mkApi(o);
  window.diji = m.api;
  dispose = initSettingsBridge(m.api);
  await waitFor(() => expect(useSettings.getState().value).not.toBeNull());
  render(<SettingsPanel />);
  return m;
}

beforeEach(() => {
  resetBoard();
  useSettings.setState({ value: null, open: false, errors: {}, hooks: null, hookBusy: false, hookError: null });
});
afterEach(() => {
  cleanup();
  dispose?.();
  dispose = null;
  delete window.diji;
  delete document.documentElement.dataset['motion'];
});

describe('SettingsPanel', () => {
  it('menüden (ui:openSettings) açılır, Esc ile kapanır; açılınca hook durumu sorulur', async () => {
    const m = await setup();
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => m.emit('ui:openSettings', null));
    expect(screen.getByRole('dialog', { name: 'Ayarlar' })).toBeTruthy();
    await waitFor(() => expect(screen.getByText('kurulu değil')).toBeTruthy());
    expect(m.invoke).toHaveBeenCalledWith('hooks:status');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('bildirim anahtarı settings:set çağırır ve değeri günceller', async () => {
    const m = await setup();
    act(() => useSettings.getState().setOpen(true));
    fireEvent.click(screen.getByLabelText('Ses'));
    await waitFor(() => expect(useSettings.getState().value?.notifications.sound).toBe(true));
    expect(m.invoke).toHaveBeenCalledWith('settings:set', { notifications: { sound: true } });
  });

  it('girişte başlat anahtarı launchAtLogin yamalar', async () => {
    const m = await setup();
    act(() => useSettings.getState().setOpen(true));
    fireEvent.click(screen.getByLabelText(/Girişte başlat/));
    await waitFor(() => expect(useSettings.getState().value?.launchAtLogin).toBe(true));
    expect(m.invoke).toHaveBeenCalledWith('settings:set', { launchAtLogin: true });
  });

  it('menü çubuğu: Dock gizleme yalnızca menü çubuğu açıkken seçilebilir', async () => {
    const m = await setup();
    act(() => useSettings.getState().setOpen(true));
    const dock = screen.getByLabelText(/Dock ikonunu gizle/) as HTMLInputElement;
    expect(dock.disabled).toBe(false);
    fireEvent.click(dock);
    await waitFor(() => expect(useSettings.getState().value?.menuBar.hideDock).toBe(true));
    expect(m.invoke).toHaveBeenCalledWith('settings:set', { menuBar: { hideDock: true } });
    fireEvent.click(screen.getByLabelText(/Menü çubuğunda göster/));
    await waitFor(() => expect(useSettings.getState().value?.menuBar.enabled).toBe(false));
    expect((screen.getByLabelText(/Dock ikonunu gizle/) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText(/Dock ikonunu gizle/) as HTMLInputElement).checked).toBe(false);
  });

  it('hata gelirse iyimser değer geri alınır ve alanın altında gösterilir', async () => {
    await setup({ setFails: true });
    act(() => useSettings.getState().setOpen(true));
    const input = screen.getByLabelText('Claude klasörü');
    fireEvent.change(input, { target: { value: '/yok' } });
    fireEvent.blur(input);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Bu klasör bulunamadı.'));
    expect(useSettings.getState().value?.claudeConfigDir).toBeNull();
  });

  it('hareket ayarı kökte data-motion olarak uygulanır', async () => {
    await setup();
    act(() => useSettings.getState().setOpen(true));
    fireEvent.click(screen.getByLabelText('Azalt'));
    await waitFor(() => expect(document.documentElement.dataset['motion']).toBe('reduce'));
    fireEvent.click(screen.getByLabelText('Sistem'));
    await waitFor(() => expect(document.documentElement.dataset['motion']).toBeUndefined());
    applyMotion('off');
    expect(document.documentElement.dataset['motion']).toBe('full');
  });

  it('hook kurulumu onay ister', async () => {
    const m = await setup();
    act(() => useSettings.getState().setOpen(true));
    await waitFor(() => expect(screen.getByText('kurulu değil')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Kur' }));
    expect(m.invoke).not.toHaveBeenCalledWith('hooks:install');
    fireEvent.click(screen.getByRole('button', { name: 'Onayla' }));
    await waitFor(() => expect(screen.getByText('kurulu')).toBeTruthy());
    expect(m.invoke).toHaveBeenCalledWith('hooks:install');
  });

  it('projeler: snapshot projeleri ve haritada gizli (snapshot\'ta olmayan) proje listelenir; renk seçimi yamalanır', async () => {
    const hiddenRoot = '/Users/demo/Projects/gizli-proje';
    const m = await setup({ initial: mergeSettings(DEFAULT_SETTINGS, { projects: { [hiddenRoot]: { hidden: true } } }) });
    act(() => useBoard.getState().setSnapshot(makeSnapshot(Date.now())));
    act(() => useSettings.getState().setOpen(true));
    expect(screen.getByText('gizli-proje')).toBeTruthy();
    expect(screen.getByText('gizli')).toBeTruthy();
    const first = useBoard.getState().snapshot.projects[0];
    expect(first).toBeTruthy();
    const swatches = screen.getAllByRole('button', { name: 'Renk #F5C29A' });
    fireEvent.click(swatches[0]!);
    await waitFor(() => expect(m.invoke).toHaveBeenCalledWith('settings:set', { projects: { [first!.root]: { color: '#F5C29A' } } }));
  });
});
