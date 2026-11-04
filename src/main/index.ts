// Electron main (00/01, 00/03). Motor 02/07 engine-host üzerinden; sekmeye gitme 04/01, bildirimler 04/02,
// global kısayollar 04/03, ayarlar 00/04, menü çubuğu modu 06/01.
import os from 'node:os';
import path from 'node:path';
import { app, dialog, globalShortcut, Menu, Notification, screen, shell, type BrowserWindow } from 'electron';
import { formatAccelerator } from '@shared/accelerator';
import { ok, TRAY_COMMANDS, type IpcEventMap, type TrayCommand } from '@shared/ipc';
import { changedKeys } from '@shared/settings';
import type { AppSettings } from '@shared/types';
import { createEngineHost, type EngineHost } from './engine-host';
import { ClaudeCli } from './engine/claudeCli';
import {
  createActionHandlers,
  createHookHandlers,
  createSettingsHandlers,
  createTerminalHandlers,
  createToastActionHandlers,
  createWindowHandlers,
} from './handlers';
import { hookInstaller } from './hooksInstaller';
import { broadcast, registerIpc, type IpcHandlers } from './ipc';
import { acquireSingleInstance, removeAppLock, writeAppLock } from './lock';
import { applyLoginItem, wasOpenedAtLogin } from './loginItem';
import { buildMenuTemplate } from './menu';
import { Notifier } from './os/notify';
import { macFootprint, sanitizeRendererSample, startPerfFromEnv, type PerfSampler } from './perf';
import { TerminalFocuser } from './os/iterm';
import { conflictMessage, ShortcutManager } from './os/shortcuts';
import { SettingsStore } from './settings';
import { TrayController } from './tray/controller';
import { createElectronPopover, createElectronTray } from './tray/electron';
import { createTerminalHost, type TerminalHost } from './terminal/host';
import { fakePtySpawn } from './terminal/fakePty';
import { nodePtySpawn } from './terminal/nodePty';
import { createMainWindow, type MainWindowController } from './window';
import { loadWindowState } from './window-state';

/**
 * Uygulama bildirimleri devralır mı? Devralırsa app.lock yazılır ve Faz 1 hook'ları (01/03) susar.
 * Paketli uygulamada evet (bundle id + bildirim izni var). `npm run dev`'de macOS bildirimleri "Electron"
 * adıyla gelir ya da hiç gelmez; o yüzden geliştirmede Faz 1 bildirim vermeye devam eder, uygulama yalnızca
 * Dock rozetini günceller. Geliştirmede denemek için: DIJI_NOTIFY=1 npm run dev.
 */
const APP_OWNS_NOTIFICATIONS = app.isPackaged || process.env['DIJI_NOTIFY'] === '1';

/**
 * 07/01 bench/geliştirme: DIJI_TERMINAL_FAKE=1 → gerçek claude çağrılmaz, sahte pty akışı kullanılır;
 * DIJI_BENCH_OPEN_TERMINAL=<ms> → açılıştan ms sonra ilk arka plan session'ı panelde açılır. Paketli uygulamada yok sayılır.
 */
const FAKE_TERMINAL = !app.isPackaged && process.env['DIJI_TERMINAL_FAKE'] === '1';

// Ölçüm (05/02) ayrı bir veri klasörüyle çalışabilsin: tek örnek kilidi userData'ya bağlı, ondan önce ayarlanmalı.
if (process.env['DIJI_USER_DATA']) app.setPath('userData', process.env['DIJI_USER_DATA']);

let main: MainWindowController | null = null;
let host: EngineHost | null = null;
let notifier: Notifier | null = null;
const focuser = new TerminalFocuser();
let permissionWarned = false;
let shortcuts: ShortcutManager | null = null;
/** DIJI_PERF=1 ile ölçüm (05/02); yoksa null ve renderer örnek göndermeyi bırakır. */
let perfSampler: PerfSampler | null = null;
/** Menü çubuğu ikonu ve açılır liste (06/01); ayarda kapalıysa null. */
let tray: TrayController | null = null;
/** Dock gizli mi (06/01, menuBar.hideDock)? Gizliyken pencereyi öne getirmek için uygulama odağı çalınır. */
let dockHidden = false;
let lastConflict: string | null = null;
/** Gömülü terminal (07/01): CLI çözücü motorla (agents --json) ve terminal köprüsüyle paylaşılır. */
let cli: ClaudeCli | null = null;
let terminals: TerminalHost | null = null;
const dataDir = () => app.getPath('userData');
let settings: SettingsStore | null = null;
let current: AppSettings | null = null;
/** Ayarlar (00/04): deposu yüklenmeden önce çağrılmaz. */
const getSettings = (): AppSettings => {
  if (!current) throw new Error('ayarlar yüklenmedi');
  return current;
};

function send<K extends keyof IpcEventMap>(ch: K, payload: IpcEventMap[K]): void {
  broadcast(currentWindow(), ch, payload);
}

/** Pencere yeni açıldıysa (sayfa yükleniyor) olay yüklenince gönderilir; yoksa kaybolurdu. */
function sendWhenReady<K extends keyof IpcEventMap>(ch: K, payload: IpcEventMap[K]): void {
  const w = currentWindow();
  if (w && w.webContents.isLoading()) w.webContents.once('did-finish-load', () => send(ch, payload));
  else send(ch, payload);
}

/**
 * Motor temposu (02/07, 05/02): pano ya da menü çubuğu listesi görünürken normal, ikisi de gizliyken seyrek.
 * Gizli tempoda da durum geçişleri, bildirimler ve rozet/menü çubuğu sayacı çalışır.
 */
function updateTempo(): void {
  const w = currentWindow();
  const boardVisible = !!w && w.isVisible() && !w.isMinimized();
  terminals?.setVisible(boardVisible);
  host?.engine.setTempo(boardVisible || (tray?.isPopoverVisible() ?? false) ? 'normal' : 'background');
}

/** Açık ana pencere (yoksa null). Motor yayınları (broadcast) için engine-host'a geçirilir. */
function currentWindow(): BrowserWindow | null {
  return main && !main.win.isDestroyed() ? main.win : null;
}

function installMenu(): void {
  const template = buildMenuTemplate({
    appName: app.name,
    isDev: !app.isPackaged,
    alwaysOnTop: current?.alwaysOnTop ?? false,
    onToggleAlwaysOnTop: () => settings?.set({ alwaysOnTop: !(current?.alwaysOnTop ?? false) }),
    onOpenSettings: () => openSettings(),
    onTerminalCommand: (cmd) => send('ui:terminalCommand', cmd),
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function openWindow(): MainWindowController {
  main = createMainWindow(dataDir(), () => installMenu(), current?.alwaysOnTop ?? false);
  main.win.on('closed', () => {
    main = null;
    // Renderer'daki terminal ekranları gitti: attach istemcileri kapanır, session'lar arka planda yaşar (07/01).
    terminals?.closeAll();
    updateTempo();
  });
  // Pencere görünmüyorsa motor daha seyrek yayın yapar (02/07).
  main.win.on('hide', updateTempo);
  main.win.on('minimize', updateTempo);
  main.win.on('show', updateTempo);
  main.win.on('restore', updateTempo);
  main.win.on('focus', () => notifier?.onWindowFocus());
  host?.engine.setTempo('normal');
  installMenu();
  return main;
}

/** Panoyu göster/gizle (04/03): öndeyse gizler, değilse öne getirir. */
function toggleWindow(): void {
  const w = currentWindow();
  if (w && w.isVisible() && !w.isMinimized() && w.isFocused()) {
    w.hide();
    return;
  }
  showWindow();
}

/** Global kısayolları (yeniden) kaydeder; yeni bir çakışma varsa toast. */
function applyShortcuts(): void {
  if (!shortcuts || !current) return;
  const report = shortcuts.apply(current.shortcuts);
  send('shortcuts:report', report);
  const msg = conflictMessage(report, formatAccelerator);
  if (msg && msg !== lastConflict) {
    const w = currentWindow();
    // İlk açılışta renderer henüz yüklenmemiş olabilir: yüklenince göster.
    if (w && w.webContents.isLoading())
      w.webContents.once('did-finish-load', () => send('app:toast', { level: 'warn', message: msg }));
    else send('app:toast', { level: 'warn', message: msg });
  }
  lastConflict = msg;
}

function startShortcuts(h: EngineHost): void {
  shortcuts = new ShortcutManager({
    globalShortcut,
    getSnapshot: () => h.engine.getSnapshot(),
    focusSession: (ref) => focuser.focus(ref),
    selectSession: (sessionId) => send('ui:selectSession', { sessionId }),
    openInApp: (sessionId) => {
      showWindow();
      sendWhenReady('ui:openInApp', { sessionId });
    },
    toggleWindow,
    showWindow,
    beep: () => shell.beep(),
    nothingTo: (message) => {
      const w = currentWindow();
      if (w && w.isVisible()) send('app:toast', { level: 'info', message });
    },
  });
  applyShortcuts();
}

function showWindow(): void {
  // Dock gizliyken (accessory uygulama) pencere başka uygulamanın arkasında kalmasın.
  if (dockHidden) app.focus({ steal: true });
  const w = currentWindow();
  if (!w) {
    openWindow();
    return;
  }
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
}

function openSettings(): void {
  showWindow();
  sendWhenReady('ui:openSettings', null);
}

/** Dock'u ayara göre gizler/gösterir (06/01). Menü çubuğu kapalıyken Dock gizlenmez: uygulamaya erişim kalmazdı. */
function applyDock(s: AppSettings): void {
  if (process.platform !== 'darwin' || !app.dock) return;
  const hide = s.menuBar.enabled && s.menuBar.hideDock;
  if (hide === dockHidden) return;
  dockHidden = hide;
  if (hide) {
    const w = currentWindow();
    const wasVisible = !!w && w.isVisible();
    app.dock.hide();
    // Dock gizlenince macOS uygulamayı arka plana alabilir: açık panoyu görünür bırak.
    if (wasVisible) setImmediate(() => showWindow());
  } else void app.dock.show();
}

/** Menü çubuğu ikonunu ayara göre kurar ya da kaldırır (06/01). */
function applyMenuBar(s: AppSettings): void {
  if (!host) return;
  if (s.menuBar.enabled && !tray) {
    const iconDir = app.isPackaged
      ? path.join(process.resourcesPath, 'tray')
      : path.join(app.getAppPath(), 'resources/tray');
    tray = new TrayController({
      engine: host.engine,
      createTray: () => createElectronTray(iconDir),
      createPopover: () => createElectronPopover(),
      workAreaNear: (p) => screen.getDisplayNearestPoint(p).workArea,
      actions: {
        openBoard: () => showWindow(),
        openSettings: () => openSettings(),
        quit: () => app.quit(),
        showOnMap: (sessionId) => {
          showWindow();
          sendWhenReady('ui:selectSession', { sessionId });
        },
        openInApp: (sessionId) => {
          showWindow();
          sendWhenReady('ui:openInApp', { sessionId });
        },
      },
      onPopoverVisibility: () => updateTempo(),
    });
    tray.start();
  } else if (!s.menuBar.enabled && tray) {
    tray.stop();
    tray = null;
    updateTempo();
  }
  applyDock(s);
}

/** Diğer brief'lerin handler'ları burada birleşir (02/07 engine-host: board:getSnapshot; 04/01: focusTerminal). */
function handlers(): Partial<IpcHandlers> {
  return {
    ...createWindowHandlers({
      // Tercih ayar deposunda (00/04); pencereye onChange uygular.
      setAlwaysOnTop: (on) => {
        const r = settings?.set({ alwaysOnTop: on });
        return r && r.ok ? r.data.alwaysOnTop : (current?.alwaysOnTop ?? false);
      },
    }),
    ...createSettingsHandlers({
      get: getSettings,
      set: (patch) =>
        settings ? settings.set(patch) : { ok: false, error: { code: 'INTERNAL', message: 'Ayarlar hazır değil.' } },
      pickDirectory: async () => {
        const opts: Electron.OpenDialogOptions = {
          title: 'Claude klasörünü seçin',
          defaultPath: current?.claudeConfigDir ?? path.join(os.homedir(), '.claude'),
          properties: ['openDirectory', 'showHiddenFiles'],
        };
        const w = currentWindow();
        const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
        return r.canceled ? null : (r.filePaths[0] ?? null);
      },
    }),
    ...createHookHandlers({
      installer: hookInstaller,
      configDir: () => current?.claudeConfigDir ?? null,
      sourceDir: () =>
        app.isPackaged ? path.join(process.resourcesPath, 'hooks') : path.join(app.getAppPath(), 'hooks'),
    }),
    ...createActionHandlers({
      projectRoot: (id) => host?.engine.getSnapshot().projects.find((p) => p.id === id)?.root ?? null,
      reveal: (dir) => shell.openPath(dir),
    }),
    ...createTerminalHandlers({
      terminalOf: (sid) => {
        const s = host?.engine.getSnapshot().sessions.find((x) => x.id === sid);
        if (!s || s.status === 'ended') return undefined;
        return s.terminal;
      },
      focus: (ref) => focuser.focus(ref),
      onPermissionDenied: () => {
        if (permissionWarned) return; // oturum başına bir kez
        permissionWarned = true;
        send('app:toast', {
          level: 'warn',
          message: "Sistem Ayarları > Gizlilik ve Güvenlik > Otomasyon'dan DijiTerminal'e iTerm2 izni verin.",
          action: { id: 'open-automation-settings', label: 'Ayarları aç' },
        });
      },
    }),
    ...createToastActionHandlers({ openExternal: (url) => shell.openExternal(url) }),
    'shortcuts:status': async () => ok(shortcuts ? shortcuts.report() : { enabled: false, items: [] }),
    'tray:command': async (cmd: TrayCommand, sessionId?: string) => {
      if (!TRAY_COMMANDS.includes(cmd))
        return { ok: false, error: { code: 'BAD_INPUT', message: 'Bilinmeyen komut.' } };
      if (!tray) return { ok: false, error: { code: 'NOT_FOUND', message: 'Menü çubuğu kapalı.' } };
      return tray.command(cmd, sessionId);
    },
    'perf:renderer': async (sample) => {
      if (!perfSampler) return ok(false);
      const s = sanitizeRendererSample(sample);
      if (s) perfSampler.addRendererSample(s);
      return ok(true);
    },
  };
}

function startNotifier(): void {
  if (!host || notifier) return;
  const osNotifications = APP_OWNS_NOTIFICATIONS && Notification.isSupported();
  notifier = new Notifier({
    engine: host.engine,
    getSettings,
    isWindowFocused: () => currentWindow()?.isFocused() ?? false,
    showWindow,
    send,
    focus: (ref) => focuser.focus(ref),
    createNotification: osNotifications ? (o) => new Notification(o) : null,
    dock: process.platform === 'darwin' && app.dock ? app.dock : null,
  });
  notifier.start();
}

/** Ayar deposunu yükler; değişiklikleri pencereye, motora ve renderer'a dağıtır. */
function loadSettings(): void {
  settings = new SettingsStore({ dir: dataDir() });
  current = settings.load();
  // Üstte tut tercihi eskiden window-state.json'daydı: ilk açılışta taşı.
  if (settings.outcome === 'created' && loadWindowState(dataDir()).alwaysOnTop) {
    const r = settings.set({ alwaysOnTop: true });
    if (r.ok) current = r.data;
  }
  settings.onChange((next, prev) => {
    current = next;
    const keys = changedKeys(prev, next);
    if (keys.includes('alwaysOnTop')) {
      main?.setAlwaysOnTop(next.alwaysOnTop);
      installMenu();
    }
    if (keys.includes('shortcuts')) applyShortcuts();
    if (keys.includes('launchAtLogin')) applyLoginItem(app, next);
    if (keys.includes('menuBar')) applyMenuBar(next);
    if (keys.includes('terminal') || keys.includes('claudeConfigDir')) terminals?.settingsChanged();
    if (keys.includes('claudeConfigDir')) void host?.engine.restart({ configDir: next.claudeConfigDir });
    else if (keys.includes('projects')) host?.engine.settingsChanged?.();
    send('settings:changed', next);
  });
}

/** Pencere yüklenince gösterilecek ilk açılış uyarıları. */
function startupToasts(): void {
  if (settings?.outcome !== 'corrupt') return;
  const w = currentWindow();
  w?.webContents.once('did-finish-load', () =>
    send('app:toast', { level: 'warn', message: 'Ayar dosyası okunamadı, varsayılanlar yüklendi.' }),
  );
}

if (acquireSingleInstance(app, showWindow)) {
  app.whenReady().then(() => {
    loadSettings();
    // Kilit yalnızca uygulama gerçekten bildirim gösterebiliyorsa: yoksa Faz 1 hook'ları susar ve hiç bildirim gelmez.
    if (APP_OWNS_NOTIFICATIONS && Notification.isSupported()) writeAppLock(dataDir());
    cli = new ClaudeCli({
      settingsPath: () => current?.terminal.claudePath ?? null,
      configDir: () => current?.claudeConfigDir ?? null,
      fake: FAKE_TERMINAL,
    });
    host = createEngineHost({
      getWindow: currentWindow,
      configDir: current?.claudeConfigDir ?? null,
      settings: getSettings,
      cli,
    }); // DIJI_DEMO=1 → DemoEngine
    terminals = createTerminalHost({
      cli,
      engine: () => host?.engine ?? null,
      settings: getSettings,
      send,
      demo: host.demo,
      spawn: FAKE_TERMINAL ? fakePtySpawn : nodePtySpawn,
      pickDirectory: async () => {
        const opts: Electron.OpenDialogOptions = {
          title: 'Yeni oturum için proje klasörü',
          defaultPath: os.homedir(),
          properties: ['openDirectory'],
        };
        const w = currentWindow();
        const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
        return r.canceled ? null : (r.filePaths[0] ?? null);
      },
    });
    registerIpc({ ...handlers(), ...host.handlers, ...terminals.handlers });
    // claude yolunu ve sürümünü açılıştan biraz sonra bul (login shell + 2 CLI çağrısı açılışı yavaşlatmasın).
    const t = terminals;
    setTimeout(() => t.warmUp(), FAKE_TERMINAL ? 0 : 3000).unref?.();
    const openAt = Number(process.env['DIJI_BENCH_OPEN_TERMINAL'] ?? '');
    if (FAKE_TERMINAL && openAt > 0) {
      setTimeout(() => {
        const s = host?.engine.getSnapshot().sessions.find((x) => x.background);
        if (s) sendWhenReady('ui:openInApp', { sessionId: s.id });
        else console.warn("[bench] arka plan session'ı yok; terminal açılmadı");
      }, openAt).unref?.();
    }
    // Menü çubuğu ve Dock tercihi pencereden önce: Dock gizliyse açılışta Dock'ta ikon belirip kaybolmasın.
    if (current) applyMenuBar(current);
    // Girişte başlatıldıysa pencere açılmaz: motor ve bildirimler arka planda çalışır; pano Dock'tan ya da menü çubuğundan açılır.
    if (!wasOpenedAtLogin(app)) openWindow();
    if (current) applyLoginItem(app, current);
    startupToasts();
    startShortcuts(host);
    void host.start().then(() => startNotifier());
    const h = host;
    perfSampler = startPerfFromEnv(h.engine, {
      isPackaged: app.isPackaged,
      getAppMetrics: () => app.getAppMetrics(),
      footprint: macFootprint,
      quit: () => app.quit(),
      visibility: () => {
        const w = currentWindow();
        return w && w.isVisible() && !w.isMinimized() ? 'visible' : 'hidden';
      },
      hideWindow: () => currentWindow()?.hide(),
      onWillQuit: (cb) => app.on('will-quit', cb),
      bytesRead: () =>
        (h.engine as { internals?: { pool: { stats(): { bytesRead: number } } } }).internals?.pool.stats().bytesRead ??
        0,
    });
    // Menü çubuğu listesi de bir pencere olduğundan "hiç pencere yok" yerine ana pencereye bakılır.
    app.on('activate', () => {
      if (!currentWindow()) openWindow();
    });
  });

  app.on('will-quit', () => {
    terminals?.closeAll();
    tray?.stop();
    shortcuts?.dispose();
    settings?.dispose();
    notifier?.stop();
    removeAppLock(dataDir());
    void host?.dispose();
  });

  // macOS: pencere kapansa da uygulama (ve motor) Dock'ta çalışmaya devam eder.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
