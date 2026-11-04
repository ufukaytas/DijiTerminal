// 00/04 — ayar deposu: ilk açılış, bozuk dosya, atomik yazım, dış değişiklik, IPC handler'ları.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@shared/settings';
import type { HookInstallStatus } from '@shared/types';
import { createHookHandlers, createSettingsHandlers } from '@main/handlers';
import { SettingsStore } from '@main/settings';

const dirs: string[] = [];
const stores: SettingsStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.dispose();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function make(opts: { dirExists?: (p: string) => boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diji-set-'));
  dirs.push(dir);
  const s = new SettingsStore({ dir, watch: false, now: () => 1700000000000, ...opts });
  stores.push(s);
  return { dir, s, file: path.join(dir, 'settings.json') };
}

describe('SettingsStore', () => {
  it('ilk açılış: varsayılanlar 0600 ile yazılır, schemaVersion eklenir', () => {
    const { s, file } = make();
    expect(s.load()).toEqual(DEFAULT_SETTINGS);
    expect(s.outcome).toBe('created');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ schemaVersion: 1, alwaysOnTop: false });
  });

  it('bozuk JSON: corrupt yedeği alınır, varsayılanlarla devam', () => {
    const { s, dir, file } = make();
    fs.writeFileSync(file, '{ bozuk');
    expect(s.load()).toEqual(DEFAULT_SETTINGS);
    expect(s.outcome).toBe('corrupt');
    expect(fs.readFileSync(path.join(dir, 'settings.corrupt-1700000000000.json'), 'utf8')).toBe('{ bozuk');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).schemaVersion).toBe(1);
  });

  it('set: doğrular, atomik yazar, abonelere önceki/yeni değerle yayar; geçersizde BAD_INPUT ve değişiklik yok', () => {
    const { s, dir, file } = make();
    s.load();
    const seen: [boolean, boolean][] = [];
    s.onChange((next, prev) => seen.push([next.notifications.sound, prev.notifications.sound]));
    const r = s.set({ notifications: { sound: true } });
    expect(r.ok && r.data.notifications.sound).toBe(true);
    expect(seen).toEqual([[true, false]]);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).notifications.sound).toBe(true);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);

    const bad = s.set({ projects: { '/x': { color: '#ZZZ' } } });
    expect(bad).toEqual({ ok: false, error: { code: 'BAD_INPUT', message: 'Geçersiz renk değeri: #ZZZ' } });
    expect(s.get().projects).toEqual({});
    expect(seen).toHaveLength(1);
  });

  it('aynı değer yazılmaz ve yayılmaz', () => {
    const { s } = make();
    s.load();
    const cb = vi.fn();
    s.onChange(cb);
    s.set({ alwaysOnTop: false });
    expect(cb).not.toHaveBeenCalled();
  });

  it('claudeConfigDir: var olmayan klasör kaydedilmez', () => {
    const { s } = make({ dirExists: (p) => p === '/Users/demo/.claude-work' });
    s.load();
    expect(s.set({ claudeConfigDir: '/yok' })).toEqual({ ok: false, error: { code: 'BAD_INPUT', message: 'Bu klasör bulunamadı.' } });
    const r = s.set({ claudeConfigDir: '/Users/demo/.claude-work' });
    expect(r.ok && r.data.claudeConfigDir).toBe('/Users/demo/.claude-work');
  });

  it('dış değişiklik yeniden yüklenir; kendi yazımımız ve yarım (bozuk) kayıt yok sayılır', () => {
    const { s, file } = make();
    s.load();
    s.set({ alwaysOnTop: true });
    const cb = vi.fn();
    s.onChange(cb);
    expect(s.reloadFromDisk()).toBe(false); // kendi yazımımız
    fs.writeFileSync(file, '{ "alwaysOnTop": fals');
    expect(s.reloadFromDisk()).toBe(false);
    expect(s.get().alwaysOnTop).toBe(true);
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, alwaysOnTop: false, reducedMotion: 'on' }));
    expect(s.reloadFromDisk()).toBe(true);
    expect(s.get()).toMatchObject({ alwaysOnTop: false, reducedMotion: 'on' });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('fs.watch: dosya elle düzenlenince 300 ms sonra yeniden yüklenir', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diji-set-'));
    dirs.push(dir);
    const s = new SettingsStore({ dir });
    stores.push(s);
    s.load();
    const changed = new Promise<boolean>((resolve) => s.onChange((n) => resolve(n.notifications.sound)));
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ notifications: { sound: true } }));
    await expect(changed).resolves.toBe(true);
  });
});

describe('IPC: ayarlar ve hook kurulumu', () => {
  it('settings:set nesne olmayan yamayı reddeder; diğerlerini depoya iletir', async () => {
    const set = vi.fn(() => ({ ok: true as const, data: DEFAULT_SETTINGS }));
    const h = createSettingsHandlers({ get: () => DEFAULT_SETTINGS, set, pickDirectory: async () => null });
    expect(await h['settings:set'](null as never)).toMatchObject({ ok: false, error: { code: 'BAD_INPUT' } });
    expect(await h['settings:set']([] as never)).toMatchObject({ ok: false });
    expect(await h['settings:set']({ alwaysOnTop: true })).toMatchObject({ ok: true });
    expect(set).toHaveBeenCalledWith({ alwaysOnTop: true });
    expect(await h['settings:pickDirectory']()).toEqual({ ok: true, data: null });
  });

  it('hooks:*: ayardaki Claude klasörü ve kaynak klasörle çağrılır; InstallError kodları Türkçe hataya çevrilir', async () => {
    const st: HookInstallStatus = { installed: true, statusLine: 'ours', settingsPath: '/c/settings.json', backupPath: null };
    const installer = {
      status: vi.fn(() => st),
      install: vi.fn(async () => ({ status: st })),
      uninstall: vi.fn(async () => {
        throw Object.assign(new Error('x'), { code: 'INVALID_JSON' });
      }),
    };
    const onChanged = vi.fn();
    const h = createHookHandlers({ installer, configDir: () => '/c', sourceDir: () => '/app/hooks', onChanged });
    expect(await h['hooks:status']()).toEqual({ ok: true, data: st });
    expect(installer.status).toHaveBeenCalledWith({ configDir: '/c' });
    expect(await h['hooks:install']()).toEqual({ ok: true, data: st });
    expect(installer.install).toHaveBeenCalledWith({ configDir: '/c', sourceDir: '/app/hooks' });
    expect(onChanged).toHaveBeenCalledWith(st);
    const r = await h['hooks:uninstall']();
    expect(r).toMatchObject({ ok: false, error: { code: 'BAD_INPUT' } });
  });
});
