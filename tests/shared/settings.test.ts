// 00/04 — ayar doğrulama, birleştirme, göç (saf).
import { describe, expect, it } from 'vitest';
import { PROJECT_PALETTE, STATUS_COLOR } from '@shared/constants';
import { changedKeys, clashesWithStatusColors, DEFAULT_SETTINGS, mergeSettings, migrate, validateSettings } from '@shared/settings';

const ROOT = '/Users/demo/Projects/demo-app';

describe('validateSettings', () => {
  it('boş/eksik girdi → varsayılanlar; nesne değilse açıklama', () => {
    expect(validateSettings(undefined)).toEqual({ value: DEFAULT_SETTINGS, issues: [] });
    expect(validateSettings({}).value).toEqual(DEFAULT_SETTINGS);
    expect(validateSettings('x').issues).toHaveLength(1);
  });

  it('bilinmeyen alanlar atılır, yanlış tipler varsayılana döner ve Türkçe açıklanır', () => {
    const r = validateSettings({ schemaVersion: 1, foo: 1, alwaysOnTop: 'evet', notifications: { sound: 1, waiting: false }, reducedMotion: 'fast' });
    expect(r.value.alwaysOnTop).toBe(false);
    expect(r.value.notifications).toEqual({ ...DEFAULT_SETTINGS.notifications, waiting: false });
    expect(r.value.reducedMotion).toBe('system');
    expect(r.issues.join('\n')).toMatch(/foo: bilinmeyen alan/);
    expect(r.issues.join('\n')).toMatch(/alwaysOnTop/);
    expect(r.issues.join('\n')).toMatch(/notifications\.sound/);
    expect(r.issues.join('\n')).toMatch(/reducedMotion/);
  });

  it('proje: renk #RRGGBB, amblem listede, kök mutlak yol', () => {
    const r = validateSettings({
      projects: {
        [ROOT]: { color: '#zzzzzz', emblem: 'dragon', alias: '  Demo  ', hidden: true },
        'relative/path': { color: '#112233' },
        '/ok': { color: '#a5b4fc', emblem: 'ring' },
      },
    });
    expect(r.value.projects).toEqual({ [ROOT]: { alias: 'Demo', hidden: true }, '/ok': { color: '#A5B4FC', emblem: 'ring' } });
    expect(r.issues).toContain('Geçersiz renk değeri: #zzzzzz');
    expect(r.issues).toContain('Geçersiz amblem: dragon');
    expect(r.issues.some((i) => i.includes('relative/path'))).toBe(true);
  });

  it('claudeConfigDir: mutlak yol ya da null; sondaki / atılır', () => {
    expect(validateSettings({ claudeConfigDir: '/Users/demo/.claude/' }).value.claudeConfigDir).toBe('/Users/demo/.claude');
    expect(validateSettings({ claudeConfigDir: '' }).value.claudeConfigDir).toBeNull();
    const r = validateSettings({ claudeConfigDir: '~/.claude' });
    expect(r.value.claudeConfigDir).toBeNull();
    expect(r.issues[0]).toMatch(/mutlak/);
  });
});

describe('mergeSettings', () => {
  it('notifications derin birleşir; projects[root] = null kaydı siler; boş değer alanı temizler', () => {
    const base = mergeSettings(DEFAULT_SETTINGS, { projects: { [ROOT]: { color: '#112233', alias: 'x' }, '/b': { hidden: true } } });
    const next = mergeSettings(base, { notifications: { sound: true }, projects: { [ROOT]: { alias: '' }, '/b': null } });
    expect(next.notifications).toEqual({ ...DEFAULT_SETTINGS.notifications, sound: true });
    expect(next.projects).toEqual({ [ROOT]: { color: '#112233' } });
    expect(mergeSettings(next, { projects: { [ROOT]: { color: undefined } } }).projects).toEqual({});
    expect(DEFAULT_SETTINGS.projects).toEqual({}); // girdi değişmez
  });

  it('claudeConfigDir null ile sıfırlanabilir', () => {
    const a = mergeSettings(DEFAULT_SETTINGS, { claudeConfigDir: '/x' });
    expect(mergeSettings(a, { claudeConfigDir: null }).claudeConfigDir).toBeNull();
  });
});

describe('yardımcılar', () => {
  it('migrate: schemaVersion yoksa olduğu gibi (v1)', () => {
    expect(migrate({ alwaysOnTop: true })).toEqual({ alwaysOnTop: true });
  });

  it('durum renklerine yakın proje rengi uyarı verir; palet vermez', () => {
    expect(clashesWithStatusColors(STATUS_COLOR.waiting)).toBe(true);
    expect(clashesWithStatusColors('#F3B236')).toBe(true);
    for (const c of PROJECT_PALETTE) expect(clashesWithStatusColors(c)).toBe(false);
  });

  it('changedKeys yalnızca değişen üst düzey alanları verir', () => {
    expect(changedKeys(DEFAULT_SETTINGS, mergeSettings(DEFAULT_SETTINGS, { notifications: { sound: true } }))).toEqual(['notifications']);
  });
});

describe('renderQuality', () => {
  it('varsayılan Yüksek; geçersiz değer varsayılana döner ve uyarı verir; yama uygulanır', () => {
    expect(DEFAULT_SETTINGS.renderQuality).toBe('high');
    const bad = validateSettings({ renderQuality: 'ultra' });
    expect(bad.value.renderQuality).toBe('high');
    expect(bad.issues.some((i) => i.startsWith('renderQuality'))).toBe(true);
    expect(validateSettings({ renderQuality: 'balanced' }).value.renderQuality).toBe('balanced');
    expect(mergeSettings(DEFAULT_SETTINGS, { renderQuality: 'balanced' }).renderQuality).toBe('balanced');
  });
});

describe('menuBar (06/01)', () => {
  it('varsayılan açık, Dock görünür; geçersiz alan varsayılana döner; yama derin birleşir', () => {
    expect(DEFAULT_SETTINGS.menuBar).toEqual({ enabled: true, hideDock: false });
    const bad = validateSettings({ menuBar: { enabled: 'evet', hideDock: true } });
    expect(bad.value.menuBar).toEqual({ enabled: true, hideDock: true });
    expect(bad.issues.some((i) => i.startsWith('menuBar.enabled'))).toBe(true);
    expect(validateSettings({ menuBar: 3 }).issues).toContain('menuBar: nesne olmalı.');
    const merged = mergeSettings(DEFAULT_SETTINGS, { menuBar: { hideDock: true } });
    expect(merged.menuBar).toEqual({ enabled: true, hideDock: true });
    expect(changedKeys(DEFAULT_SETTINGS, merged)).toEqual(['menuBar']);
  });
});
