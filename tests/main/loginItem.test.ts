// 05/03: girişte başlatma (electron app mock'u ile).
import { describe, expect, it, vi } from 'vitest';
import { applyLoginItem, LOGIN_LAUNCH_WINDOW_SEC, wasOpenedAtLogin, type LoginApp } from '@main/loginItem';

function fakeApp(
  o: { packaged?: boolean; openAtLogin?: boolean; wasOpenedAtLogin?: boolean; status?: string; throws?: boolean } = {},
) {
  let open = o.openAtLogin ?? false;
  const set = vi.fn((s: { openAtLogin?: boolean }) => {
    if (o.throws) throw new Error('izin yok');
    open = s.openAtLogin === true;
  });
  const app = {
    isPackaged: o.packaged ?? true,
    setLoginItemSettings: set,
    getLoginItemSettings: () => ({
      openAtLogin: open,
      wasOpenedAtLogin: o.wasOpenedAtLogin ?? false,
      status: open ? (o.status ?? 'enabled') : 'not-registered',
    }),
  } as unknown as LoginApp;
  return { app, set };
}

describe('applyLoginItem', () => {
  it('paketli macOS: açar, durumu döndürür; zaten açıksa dokunmaz', () => {
    const { app, set } = fakeApp();
    expect(applyLoginItem(app, { launchAtLogin: true }, 'darwin')).toEqual({
      changed: true,
      openAtLogin: true,
      status: 'enabled',
    });
    expect(set).toHaveBeenCalledWith({ openAtLogin: true });
    expect(applyLoginItem(app, { launchAtLogin: true }, 'darwin').changed).toBe(false);
    expect(set).toHaveBeenCalledTimes(1);
  });

  it('kapatır', () => {
    const { app, set } = fakeApp({ openAtLogin: true });
    expect(applyLoginItem(app, { launchAtLogin: false }, 'darwin')).toMatchObject({
      changed: true,
      openAtLogin: false,
    });
    expect(set).toHaveBeenCalledWith({ openAtLogin: false });
  });

  it('onay bekleyen durum (requires-approval) iletilir', () => {
    const { app } = fakeApp({ status: 'requires-approval' });
    expect(applyLoginItem(app, { launchAtLogin: true }, 'darwin').status).toBe('requires-approval');
  });

  it('geliştirmede ve macOS dışında sisteme dokunmaz; hata yutulur', () => {
    const dev = fakeApp({ packaged: false });
    expect(applyLoginItem(dev.app, { launchAtLogin: true }, 'darwin').skipped).toBe('not-packaged');
    expect(dev.set).not.toHaveBeenCalled();
    const linux = fakeApp();
    expect(applyLoginItem(linux.app, { launchAtLogin: true }, 'linux').skipped).toBe('unsupported');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(applyLoginItem(fakeApp({ throws: true }).app, { launchAtLogin: true }, 'darwin').skipped).toBe('error');
    warn.mockRestore();
  });
});

describe('wasOpenedAtLogin', () => {
  it('işletim sistemi bildiriyorsa true', () => {
    expect(wasOpenedAtLogin(fakeApp({ wasOpenedAtLogin: true }).app, 'darwin', 99_999)).toBe(true);
  });
  it('yedek sezgi: login item açık ve sistem yeni başlamış', () => {
    const { app } = fakeApp({ openAtLogin: true });
    expect(wasOpenedAtLogin(app, 'darwin', 30)).toBe(true);
    expect(wasOpenedAtLogin(app, 'darwin', LOGIN_LAUNCH_WINDOW_SEC + 1)).toBe(false);
  });
  it('login item kapalıysa, geliştirmede ya da macOS dışında false', () => {
    expect(wasOpenedAtLogin(fakeApp().app, 'darwin', 10)).toBe(false);
    expect(wasOpenedAtLogin(fakeApp({ packaged: false, wasOpenedAtLogin: true }).app, 'darwin', 10)).toBe(false);
    expect(wasOpenedAtLogin(fakeApp({ wasOpenedAtLogin: true }).app, 'linux', 10)).toBe(false);
  });
});
