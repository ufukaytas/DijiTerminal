// Tek örnek kilidi, app.lock, IPC handler doğrulaması ve menü şablonu (00/03).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireSingleInstance, APP_LOCK_FILE, removeAppLock, writeAppLock } from '@main/lock';
import { createActionHandlers, createWindowHandlers } from '@main/handlers';
import { buildMenuTemplate } from '@main/menu';

describe('acquireSingleInstance', () => {
  it('kilit alınamazsa çıkar ve false döner', () => {
    const app = { requestSingleInstanceLock: () => false, quit: vi.fn(), on: vi.fn() };
    expect(acquireSingleInstance(app as never, () => {})).toBe(false);
    expect(app.quit).toHaveBeenCalled();
    expect(app.on).not.toHaveBeenCalled();
  });

  it('kilidi alınca ikinci örnekte geri çağrı çalışır', () => {
    let handler: (() => void) | undefined;
    const app = {
      requestSingleInstanceLock: () => true,
      quit: vi.fn(),
      on: (_e: string, cb: () => void) => (handler = cb),
    };
    const onSecond = vi.fn();
    expect(acquireSingleInstance(app as never, onSecond)).toBe(true);
    handler?.();
    expect(onSecond).toHaveBeenCalledOnce();
  });
});

describe('app.lock', () => {
  let dir = '';
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('pid yazılır, eski dosyanın üzerine yazılır, yalnızca kendi kilidini siler', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diji-lock-'));
    const file = path.join(dir, APP_LOCK_FILE);
    fs.writeFileSync(file, '99999');
    writeAppLock(dir, 4242, 1_800_000_000_000);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ pid: 4242, startedAt: 1_800_000_000_000 });
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600');
    removeAppLock(dir, 1111);
    expect(fs.existsSync(file)).toBe(true);
    removeAppLock(dir, 4242);
    expect(fs.existsSync(file)).toBe(false);
    expect(() => removeAppLock(dir, 4242)).not.toThrow();
  });
});

describe('IPC handler doğrulaması', () => {
  it('window:setAlwaysOnTop yalnızca boolean kabul eder', async () => {
    const set = vi.fn((on: boolean) => on);
    const h = createWindowHandlers({ setAlwaysOnTop: set });
    expect(await h['window:setAlwaysOnTop'](true)).toEqual({ ok: true, data: true });
    expect(await h['window:setAlwaysOnTop']('true' as never)).toEqual({
      ok: false,
      error: { code: 'BAD_INPUT', message: 'Geçersiz değer.' },
    });
    expect(set).toHaveBeenCalledTimes(1);
  });

  it('action:revealProject kimliği doğrular, bilinmeyen projede NOT_FOUND döner', async () => {
    const reveal = vi.fn(async () => '');
    const h = createActionHandlers({ projectRoot: (id) => (id === 'abc123' ? '/Users/demo/p' : null), reveal });
    expect((await h['action:revealProject']('../../etc')).ok).toBe(false);
    expect((await h['action:revealProject'](42 as never)).ok).toBe(false);
    const nf = await h['action:revealProject']('zzz');
    expect(nf.ok === false && nf.error.code).toBe('NOT_FOUND');
    expect(await h['action:revealProject']('abc123')).toEqual({ ok: true, data: null });
    expect(reveal).toHaveBeenCalledWith('/Users/demo/p');
  });
});

describe('menü şablonu', () => {
  const labels = (t: ReturnType<typeof buildMenuTemplate>) => t.map((m) => m.label);

  it('beş üst menü; geliştirici öğeleri yalnızca dev modunda', () => {
    const base = { appName: 'DijiTerminal', alwaysOnTop: false, onToggleAlwaysOnTop: () => {} };
    const prod = buildMenuTemplate({ ...base, isDev: false });
    expect(labels(prod)).toEqual(['DijiTerminal', 'Düzen', 'Görünüm', 'Terminal', 'Pencere']);
    const viewProd = prod[2]!.submenu as { role?: string }[];
    expect(viewProd.some((i) => i.role === 'toggleDevTools')).toBe(false);
    const viewDev = buildMenuTemplate({ ...base, isDev: true })[2]!.submenu as { role?: string }[];
    expect(viewDev.some((i) => i.role === 'toggleDevTools')).toBe(true);
  });

  it('Terminal menüsü (07/01): komutlar renderer\'a iletilir; ⌘W pencerenin, sekme ⇧⌘W', () => {
    const cmd = vi.fn();
    const t = buildMenuTemplate({ appName: 'X', isDev: false, alwaysOnTop: false, onToggleAlwaysOnTop: () => {}, onTerminalCommand: cmd });
    const items = t[3]!.submenu as { label?: string; accelerator?: string; click?: () => void }[];
    const byAcc = (a: string) => items.find((i) => i.accelerator === a)!;
    byAcc('Command+J').click?.();
    byAcc('Shift+Command+W').click?.();
    byAcc('Shift+Command+]').click?.();
    byAcc('Shift+Command+[').click?.();
    byAcc('Shift+Command+J').click?.();
    expect(cmd.mock.calls.map((c) => c[0])).toEqual(['toggle', 'closeTab', 'nextTab', 'prevTab', 'toggleLayout']);
    expect(items.some((i) => i.accelerator === 'Command+W')).toBe(false);
  });

  it('Üstte Tut onay kutusu durumu yansıtır ve tıklanınca geri çağrıyı çalıştırır', () => {
    const toggle = vi.fn();
    const t = buildMenuTemplate({ appName: 'X', isDev: false, alwaysOnTop: true, onToggleAlwaysOnTop: toggle });
    const item = (t[2]!.submenu as { id?: string; checked?: boolean; accelerator?: string; click?: () => void }[]).find(
      (i) => i.id === 'always-on-top',
    )!;
    expect(item.checked).toBe(true);
    expect(item.accelerator).toBe('Alt+Command+T');
    item.click?.();
    expect(toggle).toHaveBeenCalled();
    const settings = (t[0]!.submenu as { label?: string; enabled?: boolean }[]).find((i) => i.label === 'Ayarlar…')!;
    expect(settings.enabled).toBe(false);
  });
});
