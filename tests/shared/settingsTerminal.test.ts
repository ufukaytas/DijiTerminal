// 07/01: ayarlar — gömülü terminal alanları (varsayılan, doğrulama, derin birleştirme).
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, mergeSettings, validateSettings } from '@shared/settings';

describe('terminal ayarları', () => {
  it('varsayılan: açık, yol otomatik, 13 pt', () => {
    expect(DEFAULT_SETTINGS.terminal).toEqual({ enabled: true, claudePath: null, fontSize: 13 });
    expect(validateSettings({}).value.terminal).toEqual(DEFAULT_SETTINGS.terminal);
  });
  it('geçersiz yol ve boyut varsayılana döner, sorun bildirilir', () => {
    const r = validateSettings({ terminal: { enabled: false, claudePath: 'claude', fontSize: 40 } });
    expect(r.value.terminal).toEqual({ enabled: false, claudePath: null, fontSize: 13 });
    expect(r.issues).toHaveLength(2);
    expect(
      validateSettings({ terminal: { claudePath: ' /Users/u/.local/bin/claude ', fontSize: 15 } }).value.terminal,
    ).toEqual({
      enabled: true,
      claudePath: '/Users/u/.local/bin/claude',
      fontSize: 15,
    });
    expect(validateSettings({ terminal: 'x' }).issues).toContain('terminal: nesne olmalı.');
  });
  it('yama derin birleşir', () => {
    const next = mergeSettings(DEFAULT_SETTINGS, { terminal: { fontSize: 16 } });
    expect(next.terminal).toEqual({ enabled: true, claudePath: null, fontSize: 16 });
  });
});
