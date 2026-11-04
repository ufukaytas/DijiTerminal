// Main tarafı IPC yardımcıları (00/02).
import { ipcMain, type BrowserWindow } from 'electron';
import { fail, ok, type EventChannel, type InvokeChannel, type IpcEventMap, type IpcInvokeMap } from '@shared/ipc';

export type IpcHandlers = {
  [K in InvokeChannel]: (...args: IpcInvokeMap[K]['args']) => Promise<IpcInvokeMap[K]['result']>;
};

/**
 * Her kanal için handler kaydeder; exception'ları yakalayıp IpcResult hatasına çevirir.
 * Verilmeyen kanallar stub'la doldurulur; motor (02/07) ve diğer brief'ler kendi handler'larını
 * `registerIpc({ ...createWindowHandlers(..), ...engineHandlers })` biçiminde ekler.
 * Tekrar çağrılabilir: önceki handler'lar kaldırılıp yeniden kaydedilir.
 */
export function registerIpc(overrides: Partial<IpcHandlers> = {}): void {
  const handlers: IpcHandlers = { ...stubHandlers(), ...overrides };
  for (const channel of Object.keys(handlers) as InvokeChannel[]) {
    const handler = handlers[channel] as (...args: unknown[]) => Promise<unknown>;
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
      try {
        return await handler(...args);
      } catch (e) {
        console.error(`[ipc] ${channel} hata verdi:`, e);
        return fail('INTERNAL', 'Beklenmeyen bir hata oluştu.');
      }
    });
  }
}

/** Renderer'a tipli olay gönderir. Pencere kapanmışsa sessizce atlar. */
export function broadcast<K extends EventChannel>(
  win: BrowserWindow | null,
  channel: K,
  payload: IpcEventMap[K],
): void {
  if (!win || win.isDestroyed()) return;
  win.webContents.send(channel, payload);
}

const notReady = async () => fail('NOT_IMPLEMENTED', 'Henüz hazır değil.');

/** Gerçek uygulamalar ilgili brief'lerde bağlanana kadar kullanılan stub handler'lar. */
export function stubHandlers(): IpcHandlers {
  return {
    'board:getSnapshot': notReady,
    'action:focusTerminal': notReady,
    'action:revealProject': notReady,
    'settings:get': notReady,
    'settings:set': notReady,
    'settings:pickDirectory': notReady,
    'hooks:status': notReady,
    'hooks:install': notReady,
    'hooks:uninstall': notReady,
    'window:setAlwaysOnTop': notReady,
    'app:toastAction': notReady,
    'shortcuts:status': notReady,
    'perf:renderer': async () => ok(false), // ölçüm kapalı: renderer göndermeyi bırakır
    'tray:command': notReady,
    'terminal:capability': notReady,
    'terminal:retry': notReady,
    'term:open': notReady,
    'term:write': notReady,
    'term:resize': notReady,
    'term:close': notReady,
    'term:redraw': notReady,
    'session:newBackground': notReady,
    'session:pickProjectDir': notReady,
    'session:stopBackground': notReady,
    'session:history': notReady,
    'session:restoreBackground': notReady,
  };
}
