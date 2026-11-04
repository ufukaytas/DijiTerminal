// Uygulama menüsü şablonu (00/03). `electron` yalnızca tip olarak kullanılır; Menu.buildFromTemplate index.ts'te.
import type { MenuItemConstructorOptions } from 'electron';
import type { TerminalCommand } from '@shared/ipc';

export interface MenuOptions {
  appName: string;
  isDev: boolean;
  alwaysOnTop: boolean;
  onToggleAlwaysOnTop(): void;
  /** 00/04 bağlayana kadar tanımsız; tanımsızsa menü öğesi pasif. */
  onOpenSettings?: () => void;
  /** 07/01: gömülü terminal paneli komutları (renderer'a iletilir). */
  onTerminalCommand?: (cmd: TerminalCommand) => void;
}

export function buildMenuTemplate(o: MenuOptions): MenuItemConstructorOptions[] {
  const view: MenuItemConstructorOptions[] = [];
  if (o.isDev) {
    view.push(
      { label: 'Yeniden Yükle', role: 'reload' },
      { label: 'Geliştirici Araçları', role: 'toggleDevTools' },
      { type: 'separator' },
    );
  }
  view.push(
    {
      id: 'always-on-top',
      label: 'Üstte Tut',
      type: 'checkbox',
      checked: o.alwaysOnTop,
      accelerator: 'Alt+Command+T',
      click: () => o.onToggleAlwaysOnTop(),
    },
    { type: 'separator' },
    { label: 'Tam Ekran', role: 'togglefullscreen' },
  );

  return [
    {
      label: o.appName,
      submenu: [
        { label: `${o.appName} Hakkında`, role: 'about' },
        { type: 'separator' },
        {
          label: 'Ayarlar…',
          accelerator: 'Command+,',
          enabled: Boolean(o.onOpenSettings),
          click: () => o.onOpenSettings?.(),
        },
        { type: 'separator' },
        { label: `${o.appName} Gizle`, role: 'hide' },
        { label: 'Diğerlerini Gizle', role: 'hideOthers' },
        { type: 'separator' },
        { label: `${o.appName} Çık`, role: 'quit' },
      ],
    },
    {
      label: 'Düzen',
      submenu: [
        { label: 'Geri Al', role: 'undo' },
        { label: 'Yinele', role: 'redo' },
        { type: 'separator' },
        { label: 'Kes', role: 'cut' },
        { label: 'Kopyala', role: 'copy' },
        { label: 'Yapıştır', role: 'paste' },
        { label: 'Tümünü Seç', role: 'selectAll' },
      ],
    },
    { label: 'Görünüm', submenu: view },
    {
      label: 'Terminal',
      submenu: [
        { label: 'Terminal Panelini Göster/Gizle', accelerator: 'Command+J', enabled: Boolean(o.onTerminalCommand), click: () => o.onTerminalCommand?.('toggle') },
        {
          label: 'Pencere / Panel Olarak Göster',
          accelerator: 'Shift+Command+J',
          enabled: Boolean(o.onTerminalCommand),
          click: () => o.onTerminalCommand?.('toggleLayout'),
        },
        { type: 'separator' },
        { label: 'Sonraki Sekme', accelerator: 'Shift+Command+]', enabled: Boolean(o.onTerminalCommand), click: () => o.onTerminalCommand?.('nextTab') },
        { label: 'Önceki Sekme', accelerator: 'Shift+Command+[', enabled: Boolean(o.onTerminalCommand), click: () => o.onTerminalCommand?.('prevTab') },
        { type: 'separator' },
        // ⌘W macOS Pencere menüsünün "Kapat"ı; sekme kapatma ayrı kısayolda (session arka planda yaşamaya devam eder).
        { label: 'Sekmeyi Kapat', accelerator: 'Shift+Command+W', enabled: Boolean(o.onTerminalCommand), click: () => o.onTerminalCommand?.('closeTab') },
      ],
    },
    {
      label: 'Pencere',
      role: 'windowMenu',
    },
  ];
}
