// Girişte başlatma (05/03). `electron` yalnızca tip olarak kullanılır; app nesnesi parametreyle gelir (test edilebilir).
// macOS'un yerleşik mekanizması (Electron 45: SMAppService 'mainAppService'); ek launch agent dosyası yazılmaz.
import os from 'node:os';
import type { App } from 'electron';
import type { AppSettings } from '@shared/types';

export type LoginApp = Pick<App, 'isPackaged' | 'setLoginItemSettings' | 'getLoginItemSettings'>;

export type LoginItemStatus = 'not-registered' | 'enabled' | 'requires-approval' | 'not-found';

export interface LoginItemResult {
  /** setLoginItemSettings çağrıldı mı (durum zaten istenen gibiyse çağrılmaz). */
  changed: boolean;
  /** İşletim sisteminin bildirdiği son durum. */
  openAtLogin: boolean;
  status: LoginItemStatus | null;
  /** Uygulanmadıysa neden. */
  skipped?: 'not-packaged' | 'unsupported' | 'error';
}

/**
 * Ayardaki `launchAtLogin`'i sisteme uygular. Yalnızca paketli uygulamada ve macOS'ta: geliştirmede (`npm run dev`)
 * login item `Electron.app` olarak kaydolurdu. Durum zaten istenen gibiyse sisteme dokunmaz.
 * `status: 'requires-approval'` → kullanıcının Sistem Ayarları › Genel › Giriş Öğeleri'nde onaylaması gerekir.
 */
export function applyLoginItem(
  app: LoginApp,
  s: Pick<AppSettings, 'launchAtLogin'>,
  platform: NodeJS.Platform = process.platform,
): LoginItemResult {
  const want = s.launchAtLogin === true;
  if (platform !== 'darwin') return { changed: false, openAtLogin: false, status: null, skipped: 'unsupported' };
  if (!app.isPackaged) return { changed: false, openAtLogin: false, status: null, skipped: 'not-packaged' };
  try {
    const before = app.getLoginItemSettings();
    let changed = false;
    if (before.openAtLogin !== want) {
      app.setLoginItemSettings({ openAtLogin: want });
      changed = true;
    }
    const after = changed ? app.getLoginItemSettings() : before;
    return { changed, openAtLogin: after.openAtLogin, status: (after.status as LoginItemStatus | undefined) ?? null };
  } catch (e) {
    console.warn('[login-item] uygulanamadı:', e);
    return { changed: false, openAtLogin: false, status: null, skipped: 'error' };
  }
}

/** Girişten bu kadar saniye içinde açılmış ve login item açıksa "girişte açıldı" sayılır (yedek sezgi). */
export const LOGIN_LAUNCH_WINDOW_SEC = 180;

/**
 * Uygulama girişte otomatik mi açıldı? Öyleyse pencere gösterilmez (yalnızca Dock + motor + bildirimler);
 * Dock ikonuna tıklanınca `activate` olayında pencere açılır.
 * macOS 13+ (SMAppService) `wasOpenedAtLogin`'i her zaman doldurmuyor; login item açık ve sistem yeni
 * başlamışsa da girişte açılmış sayılır.
 */
export function wasOpenedAtLogin(
  app: LoginApp,
  platform: NodeJS.Platform = process.platform,
  uptimeSec: number = os.uptime(),
): boolean {
  if (platform !== 'darwin' || !app.isPackaged) return false;
  try {
    const s = app.getLoginItemSettings();
    if (s.wasOpenedAtLogin) return true;
    return s.openAtLogin && uptimeSec < LOGIN_LAUNCH_WINDOW_SEC;
  } catch {
    return false;
  }
}
