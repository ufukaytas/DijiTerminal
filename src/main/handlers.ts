// Pencere ve eylem IPC handler'ları (00/03, 03/02). Electron'a doğrudan bağımlı değil:
// yan etkiler bağımlılık olarak gelir, böylece girdi doğrulaması node ortamında test edilir.
import { fail, ok, SESSION_ID_RE, TOAST_ACTION_IDS, type IpcErrorCode, type IpcResult, type ToastActionId } from '@shared/ipc';
import type { SettingsPatch } from '@shared/settings';
import type { AppSettings, HookInstallStatus, TerminalApp, TerminalRef } from '@shared/types';
import type { IpcHandlers } from './ipc';
import { focusErrorMessage, type FocusFailure, type FocusResult } from './os/iterm';

export interface WindowDeps {
  /** Üstte tut durumunu uygular ve kaydeder; yeni durumu döner. */
  setAlwaysOnTop(on: boolean): boolean;
}

export function createWindowHandlers(deps: WindowDeps): Pick<IpcHandlers, 'window:setAlwaysOnTop'> {
  return {
    'window:setAlwaysOnTop': async (on: unknown) => {
      if (typeof on !== 'boolean') return fail('BAD_INPUT', 'Geçersiz değer.');
      return ok(deps.setAlwaysOnTop(on));
    },
  };
}

/** Proje kimliği motorun ürettiği kısa hash; başka bir şey kabul edilmez. */
export const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface ActionDeps {
  /** Motorun bildiği proje kökü; bilinmiyorsa null. */
  projectRoot(projectId: string): string | null;
  /** Klasörü Finder'da gösterir (shell.openPath). Hata metni döner, başarıda boş string. */
  reveal(dir: string): Promise<string>;
}

export function createActionHandlers(deps: ActionDeps): Pick<IpcHandlers, 'action:revealProject'> {
  return {
    'action:revealProject': async (projectId: unknown) => {
      if (typeof projectId !== 'string' || !PROJECT_ID_RE.test(projectId)) return fail('BAD_INPUT', 'Geçersiz proje.');
      const root = deps.projectRoot(projectId);
      if (!root) return fail('NOT_FOUND', 'Proje bulunamadı.');
      const err = await deps.reveal(root);
      if (err) return fail('INTERNAL', 'Klasör açılamadı.');
      return ok(null);
    },
  };
}

// ---------- 04/01: sekmeye git ----------

export interface TerminalDeps {
  /** undefined → session snapshot'ta yok (ya da bitti); null → terminale bağlı değil. */
  terminalOf(sessionId: string): TerminalRef | null | undefined;
  focus(ref: TerminalRef): Promise<FocusResult>;
  /** Otomasyon izni reddedildi (ilk seferde toast + Ayarlar düğmesi). */
  onPermissionDenied?(app: TerminalApp): void;
}

const FAILURE_CODE: Record<FocusFailure, IpcErrorCode> = {
  'no-tty': 'NOT_FOUND',
  'not-running': 'NOT_FOUND',
  'not-found': 'NOT_FOUND',
  permission: 'PERMISSION',
  timeout: 'INTERNAL',
  error: 'INTERNAL',
  busy: 'INTERNAL',
  unsupported: 'NOT_IMPLEMENTED',
};

export function createTerminalHandlers(deps: TerminalDeps): Pick<IpcHandlers, 'action:focusTerminal'> {
  return {
    'action:focusTerminal': async (sessionId: unknown) => {
      if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return fail('BAD_INPUT', 'Geçersiz session kimliği.');
      const ref = deps.terminalOf(sessionId);
      if (ref === undefined) return fail('NOT_FOUND', 'Session artık çalışmıyor.');
      if (ref === null) return fail('NOT_FOUND', 'Bu session bir terminale bağlı değil.');
      const r = await deps.focus(ref);
      if (r.ok) return ok({ app: r.app });
      if (r.reason === 'permission') deps.onPermissionDenied?.(r.app ?? ref.app);
      return fail(FAILURE_CODE[r.reason], focusErrorMessage(r, ref.app));
    },
  };
}

// ---------- toast eylemleri ----------

/** Açılacak adresler sabit; renderer yalnızca kimlik gönderir. */
export const TOAST_ACTION_URLS: Record<ToastActionId, string> = {
  'open-automation-settings': 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
  'open-notification-settings': 'x-apple.systempreferences:com.apple.preference.notifications',
};

export function createToastActionHandlers(deps: { openExternal(url: string): Promise<void> }): Pick<IpcHandlers, 'app:toastAction'> {
  return {
    'app:toastAction': async (id: unknown) => {
      if (typeof id !== 'string' || !(TOAST_ACTION_IDS as readonly string[]).includes(id)) return fail('BAD_INPUT', 'Geçersiz eylem.');
      await deps.openExternal(TOAST_ACTION_URLS[id as ToastActionId]);
      return ok(null);
    },
  };
}


// ---------- 00/04: ayarlar ----------

export interface SettingsDeps {
  get(): AppSettings;
  set(patch: SettingsPatch): IpcResult<AppSettings>;
  /** Klasör seçme penceresi; iptal → null. */
  pickDirectory(): Promise<string | null>;
}

export function createSettingsHandlers(deps: SettingsDeps): Pick<IpcHandlers, 'settings:get' | 'settings:set' | 'settings:pickDirectory'> {
  return {
    'settings:get': async () => ok(deps.get()),
    'settings:set': async (patch: unknown) => {
      if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return fail('BAD_INPUT', 'Geçersiz ayar.');
      return deps.set(patch as SettingsPatch);
    },
    'settings:pickDirectory': async () => ok(await deps.pickDirectory()),
  };
}

// ---------- 01/02: hook kurulumu (ayarlar ekranından) ----------

/** hooks/lib/installer.mjs yüzeyi (testlerde sahte). */
export interface HookInstallerLike {
  status(o: { configDir?: string | null }): HookInstallStatus;
  install(o: { configDir?: string | null; sourceDir: string }): Promise<{ status: HookInstallStatus }>;
  uninstall(o: { configDir?: string | null; sourceDir: string }): Promise<{ status: HookInstallStatus }>;
}

export interface HookDeps {
  installer: HookInstallerLike;
  configDir(): string | null;
  /** Kopyalanacak betiklerin klasörü (paketli: resourcesPath/hooks). */
  sourceDir(): string;
  onChanged?(s: HookInstallStatus): void;
}

const INSTALL_ERROR: Record<string, { code: IpcErrorCode; message: string }> = {
  INVALID_JSON: { code: 'BAD_INPUT', message: 'Claude ayar dosyası (settings.json) geçerli JSON değil; elle düzeltin ve tekrar deneyin.' },
  NOT_WRITABLE: { code: 'PERMISSION', message: 'Claude ayar dosyasına yazılamadı (izin yok).' },
  SOURCE_MISSING: { code: 'INTERNAL', message: 'Hook betikleri uygulama paketinde bulunamadı.' },
};

function installFailure(e: unknown): IpcResult<never> {
  const code = (e as { code?: unknown }).code;
  const m = typeof code === 'string' ? INSTALL_ERROR[code] : undefined;
  if (m) return fail(m.code, m.message);
  console.error('[hooks] kurulum hatası:', e);
  return fail('INTERNAL', 'Hook kurulumu başarısız.');
}

export function createHookHandlers(deps: HookDeps): Pick<IpcHandlers, 'hooks:status' | 'hooks:install' | 'hooks:uninstall'> {
  const base = () => ({ configDir: deps.configDir() });
  return {
    'hooks:status': async () => {
      try {
        return ok(deps.installer.status(base()));
      } catch (e) {
        return installFailure(e);
      }
    },
    'hooks:install': async () => {
      try {
        const r = await deps.installer.install({ ...base(), sourceDir: deps.sourceDir() });
        deps.onChanged?.(r.status);
        return ok(r.status);
      } catch (e) {
        return installFailure(e);
      }
    },
    'hooks:uninstall': async () => {
      try {
        const r = await deps.installer.uninstall({ ...base(), sourceDir: deps.sourceDir() });
        deps.onChanged?.(r.status);
        return ok(r.status);
      } catch (e) {
        return installFailure(e);
      }
    },
  };
}
