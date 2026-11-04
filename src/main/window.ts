// Ana pencere (00/03): konum/monitör hafızası, üstte tut, dış gezinme engeli.
// Saf mantık window-state.ts'te; bu dosya yalnızca Electron'a bağlar.
import { join } from 'node:path';
import { BrowserWindow, screen, shell, type Rectangle } from 'electron';
import {
  debounce,
  ensureVisible,
  loadWindowState,
  saveWindowState,
  type DisplayInfo,
  type WindowState,
} from './window-state';

const SAVE_DEBOUNCE_MS = 500;

const toDisplayInfo = (d: Electron.Display): DisplayInfo => ({ id: d.id, workArea: d.workArea });

export interface MainWindowController {
  win: BrowserWindow;
  setAlwaysOnTop(on: boolean): boolean;
  isAlwaysOnTop(): boolean;
}

function applyAlwaysOnTop(win: BrowserWindow, on: boolean): void {
  // 'floating' + tüm workspace'ler: tam ekran iTerm2 Space'inde de görünür kalır.
  win.setAlwaysOnTop(on, 'floating');
  win.setVisibleOnAllWorkspaces(on, { visibleOnFullScreen: true });
}

const isExternal = (url: string) => /^https?:\/\//i.test(url);

/**
 * @param dataDir pencere durumunun saklandığı dizin (userData)
 * @param onAlwaysOnTopChange menü onay işaretini güncellemek için
 * @param initialAlwaysOnTop ayar deposundaki değer (00/04); verilmezse window-state.json'daki eski değer
 */
export function createMainWindow(dataDir: string, onAlwaysOnTopChange?: (on: boolean) => void, initialAlwaysOnTop?: boolean): MainWindowController {
  const displays = screen.getAllDisplays().map(toDisplayInfo);
  let state: WindowState = ensureVisible(loadWindowState(dataDir), displays, toDisplayInfo(screen.getPrimaryDisplay()));
  if (initialAlwaysOnTop !== undefined) state = { ...state, alwaysOnTop: initialAlwaysOnTop };

  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 900,
    minHeight: 600,
    title: 'DijiTerminal',
    backgroundColor: '#0B0E13',
    titleBarStyle: 'hiddenInset',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => {
    if (state.isMaximized) win.maximize();
    if (state.alwaysOnTop) applyAlwaysOnTop(win, true);
    win.show();
  });

  const saver = debounce(() => {
    if (win.isDestroyed()) return;
    const maximized = win.isMaximized();
    // Büyütülmüşken normal geometriyi koru; açılışta önce o boyut, sonra maximize uygulanır.
    const b: Rectangle = maximized ? win.getNormalBounds() : win.getBounds();
    state = {
      ...state,
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      displayId: screen.getDisplayMatching(b).id,
      isMaximized: maximized,
    };
    saveWindowState(dataDir, state);
  }, SAVE_DEBOUNCE_MS);
  const schedule = () => saver.call();
  win.on('move', schedule);
  win.on('resize', schedule);
  win.on('maximize', schedule);
  win.on('unmaximize', schedule);
  win.on('close', () => saver.flush());

  // Uygulama içinde yeni pencere ya da başka sayfaya gezinme yok; dış bağlantılar tarayıcıda açılır.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternal(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL'];
    if (devUrl && url.startsWith(devUrl)) return; // HMR tam yenileme
    e.preventDefault();
    if (isExternal(url)) void shell.openExternal(url);
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return {
    win,
    isAlwaysOnTop: () => state.alwaysOnTop,
    setAlwaysOnTop(on: boolean) {
      if (!win.isDestroyed()) applyAlwaysOnTop(win, on);
      state = { ...state, alwaysOnTop: on };
      saveWindowState(dataDir, state);
      onAlwaysOnTopChange?.(on);
      return on;
    },
  };
}
