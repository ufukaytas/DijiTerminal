// Menü çubuğu modu (06/01) — Electron adaptörleri: Tray, açılır liste penceresi, sağ tık menüsü.
// Karar mantığı tray/controller.ts'te; burada yalnızca Electron çağrıları var.
import { join } from 'node:path';
import { BrowserWindow, Menu, nativeImage, shell, Tray, type NativeImage } from 'electron';
import type { BoardSnapshot } from '@shared/types';
import { broadcast } from '../ipc';
import type { PopoverLike, TrayLike, TrayMenuItem } from './controller';
import { POPOVER_SIZE, type TrayIconState } from './logic';

const ICON_FILES: Record<TrayIconState, string> = {
  idle: 'trayIdleTemplate.png',
  busy: 'trayBusyTemplate.png',
  waiting: 'trayWaitingTemplate.png',
};

/**
 * @param iconDir resources/tray (geliştirmede proje kökü, paketli uygulamada process.resourcesPath/tray).
 * Dosya adının `Template` ile bitmesi ve @2x eşi macOS'a template image olduğunu söyler: menü çubuğu
 * açık/koyu temaya göre ikonu kendisi boyar.
 */
export function createElectronTray(iconDir: string): TrayLike {
  const images = new Map<TrayIconState, NativeImage>();
  const image = (s: TrayIconState): NativeImage => {
    let img = images.get(s);
    if (!img) {
      img = nativeImage.createFromPath(join(iconDir, ICON_FILES[s]));
      if (img.isEmpty()) console.warn(`[tray] ikon okunamadı: ${ICON_FILES[s]} (${iconDir})`);
      img.setTemplateImage(true);
      images.set(s, img);
    }
    return img;
  };
  const tray = new Tray(image('idle'));
  // Sağ tık menüsünü biz açıyoruz; sol tık listeyi açar (setContextMenu sol tıkı da menüye çevirirdi).
  tray.setIgnoreDoubleClickEvents(true);
  return {
    setIcon: (s) => tray.setImage(image(s)),
    setTitle: (t) => tray.setTitle(t, { fontType: 'monospacedDigit' }),
    setToolTip: (t) => tray.setToolTip(t),
    getBounds: () => tray.getBounds(),
    onClick: (cb) => tray.on('click', () => cb()),
    onRightClick: (cb) => tray.on('right-click', () => cb()),
    popUpMenu: (items: TrayMenuItem[]) => tray.popUpContextMenu(Menu.buildFromTemplate(items)),
    destroy: () => tray.destroy(),
  };
}

const isExternal = (url: string) => /^https?:\/\//i.test(url);

/** Çerçevesiz açılır liste. Ana pencereyle aynı preload ve CSP; three.js yüklemeyen ayrı giriş noktası. */
export function createElectronPopover(): PopoverLike {
  const win = new BrowserWindow({
    width: POPOVER_SIZE.width,
    height: POPOVER_SIZE.height,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: true,
    backgroundColor: '#0B0E13',
    title: 'DijiTerminal',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  // Tam ekran iTerm2 Space'inde de menü çubuğunun altında açılsın.
  win.setAlwaysOnTop(true, 'pop-up-menu');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternal(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL'];
    if (devUrl && url.startsWith(devUrl)) return;
    e.preventDefault();
  });

  // Snapshot sayfa yüklenmeden gelirse kaybolmasın: yüklenince son hali gönder.
  let pending: BoardSnapshot | null = null;
  let loaded = false;
  win.webContents.once('did-finish-load', () => {
    loaded = true;
    if (pending) broadcast(win, 'board:snapshot', pending);
    pending = null;
  });

  const dev = process.env['ELECTRON_RENDERER_URL'];
  if (dev) void win.loadURL(`${dev}/popover.html`);
  else void win.loadFile(join(__dirname, '../renderer/popover.html'));

  return {
    size: POPOVER_SIZE,
    showAt(pos) {
      if (win.isDestroyed()) return;
      win.setPosition(pos.x, pos.y, false);
      win.show();
      win.focus();
    },
    hide: () => {
      if (!win.isDestroyed()) win.hide();
    },
    isVisible: () => !win.isDestroyed() && win.isVisible(),
    onBlur: (cb) => win.on('blur', () => cb()),
    sendSnapshot(s) {
      if (win.isDestroyed()) return;
      if (!loaded) {
        pending = s;
        return;
      }
      broadcast(win, 'board:snapshot', s);
    },
    destroy: () => {
      if (!win.isDestroyed()) win.destroy();
    },
  };
}
