// Menü çubuğu modu (06/01): ikon + açılır liste davranışı. Electron nesneleri (Tray, BrowserWindow, Menu)
// tray/electron.ts'teki ince adaptörlerden gelir; buradaki mantık testlerde sahte nesnelerle çalışır.
import { fail, ok, SESSION_ID_RE, type IpcResult, type TrayCommand } from '@shared/ipc';
import type { BoardEvent, BoardSnapshot } from '@shared/types';
import type { BoardEngine } from '../engine/index';
import { popoverPosition, trayView, type Rect, type Size, type TrayIconState, type TrayView } from './logic';

export interface TrayLike {
  setIcon(state: TrayIconState): void;
  setTitle(title: string): void;
  setToolTip(text: string): void;
  getBounds(): Rect;
  onClick(cb: () => void): void;
  onRightClick(cb: () => void): void;
  popUpMenu(items: TrayMenuItem[]): void;
  destroy(): void;
}

export interface PopoverLike {
  readonly size: Size;
  /** Konumlanır, gösterilir ve odak alır (blur ile kapanabilmesi için). */
  showAt(pos: { x: number; y: number }): void;
  hide(): void;
  isVisible(): boolean;
  onBlur(cb: () => void): void;
  sendSnapshot(s: BoardSnapshot): void;
  destroy(): void;
}

export type TrayMenuItem = { label: string; click: () => void } | { type: 'separator' };

export interface TrayActions {
  openBoard(): void;
  openSettings(): void;
  quit(): void;
  showOnMap(sessionId: string): void;
  /** 07/01: arka plan session'ını ana pencerede gömülü terminalde aç. */
  openInApp(sessionId: string): void;
}

export interface TrayDeps {
  engine: Pick<BoardEngine, 'onSnapshot' | 'onEvents' | 'getSnapshot'>;
  createTray(): TrayLike;
  /** Açılır pencere ilk tıklamada oluşturulur (açılışta ikinci bir renderer yüklenmez). */
  createPopover(): PopoverLike;
  /** İkonun bulunduğu ekranın çalışma alanı (menü çubuğu ve Dock hariç). */
  workAreaNear(point: { x: number; y: number }): Rect;
  actions: TrayActions;
  /** Liste göründü/gizlendi: main motor temposunu buna göre ayarlar (05/02). */
  onPopoverVisibility?(visible: boolean): void;
  now?: () => number;
}

/**
 * macOS'ta liste açıkken ikona tıklamak önce listenin `blur`'unu (kapanır), sonra ikonun `click`'ini tetikler.
 * Bu süre içinde gelen tıklama "kapat" demektir; yeniden açmaz.
 */
export const BLUR_CLICK_GUARD_MS = 300;

export class TrayController {
  private tray: TrayLike | null = null;
  private popover: PopoverLike | null = null;
  private view: TrayView | null = null;
  private unsubs: (() => void)[] = [];
  private hiddenByBlurAt = -Infinity;
  private readonly now: () => number;

  constructor(private readonly deps: TrayDeps) {
    this.now = deps.now ?? Date.now;
  }

  get running(): boolean {
    return this.tray !== null;
  }

  start(): void {
    if (this.tray) return;
    const tray = this.deps.createTray();
    this.tray = tray;
    tray.onClick(() => this.toggle());
    tray.onRightClick(() => tray.popUpMenu(this.menuItems()));
    this.unsubs.push(this.deps.engine.onSnapshot((s) => this.onSnapshot(s)));
    // Durum geçişleri (hook olayları, 02/09) gizli tempoda 5 sn'lik snapshot'ı beklemesin.
    this.unsubs.push(this.deps.engine.onEvents((e) => this.onEvents(e)));
    this.update(this.deps.engine.getSnapshot());
  }

  stop(): void {
    for (const u of this.unsubs.splice(0)) u();
    if (this.popover) {
      const wasVisible = this.popover.isVisible();
      this.popover.destroy();
      this.popover = null;
      if (wasVisible) this.deps.onPopoverVisibility?.(false);
    }
    this.tray?.destroy();
    this.tray = null;
    this.view = null;
  }

  isPopoverVisible(): boolean {
    return this.popover?.isVisible() ?? false;
  }

  /** Görünümü günceller; değişmeyen alanlar Electron'a tekrar yazılmaz. */
  update(snap: BoardSnapshot): void {
    if (!this.tray) return;
    const v = trayView(snap);
    const prev = this.view;
    if (!prev || prev.icon !== v.icon) this.tray.setIcon(v.icon);
    if (!prev || prev.title !== v.title) this.tray.setTitle(v.title);
    if (!prev || prev.tooltip !== v.tooltip) this.tray.setToolTip(v.tooltip);
    this.view = v;
  }

  toggle(): void {
    if (this.isPopoverVisible()) {
      this.hide();
      return;
    }
    if (this.now() - this.hiddenByBlurAt < BLUR_CLICK_GUARD_MS) return;
    this.show();
  }

  show(): void {
    if (!this.tray) return;
    const p = this.ensurePopover();
    const b = this.tray.getBounds();
    const area = this.deps.workAreaNear({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) });
    // Gizliyken liste snapshot almaz: açılırken beklemeden güncel hali gönder.
    p.sendSnapshot(this.deps.engine.getSnapshot());
    p.showAt(popoverPosition(b, p.size, area));
    this.deps.onPopoverVisibility?.(true);
  }

  hide(): void {
    if (!this.popover || !this.popover.isVisible()) return;
    this.popover.hide();
    this.deps.onPopoverVisibility?.(false);
  }

  /** Açılır listeden gelen `tray:command` (IPC). */
  command(cmd: TrayCommand, sessionId?: string): IpcResult<null> {
    switch (cmd) {
      case 'close':
        this.hide();
        return ok(null);
      case 'openBoard':
        this.hide();
        this.deps.actions.openBoard();
        return ok(null);
      case 'openSettings':
        this.hide();
        this.deps.actions.openSettings();
        return ok(null);
      case 'quit':
        this.deps.actions.quit();
        return ok(null);
      case 'showOnMap':
        if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId))
          return fail('BAD_INPUT', 'Geçersiz session kimliği.');
        this.hide();
        this.deps.actions.showOnMap(sessionId);
        return ok(null);
      case 'openInApp':
        if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId))
          return fail('BAD_INPUT', 'Geçersiz session kimliği.');
        this.hide();
        this.deps.actions.openInApp(sessionId);
        return ok(null);
      default:
        return fail('BAD_INPUT', 'Bilinmeyen komut.');
    }
  }

  /** Sağ tık: listeyi açmadan hızlı erişim (Dock gizliyken ⌘Q'ya alternatif). */
  menuItems(): TrayMenuItem[] {
    const a = this.deps.actions;
    return [
      { label: 'Panoyu aç', click: () => a.openBoard() },
      { label: 'Ayarlar…', click: () => a.openSettings() },
      { type: 'separator' },
      { label: "DijiTerminal'den çık", click: () => a.quit() },
    ];
  }

  private ensurePopover(): PopoverLike {
    if (this.popover) return this.popover;
    const p = this.deps.createPopover();
    p.onBlur(() => {
      if (!p.isVisible()) return;
      this.hiddenByBlurAt = this.now();
      this.hide();
    });
    this.popover = p;
    return p;
  }

  private onSnapshot(s: BoardSnapshot): void {
    this.update(s);
    if (this.popover?.isVisible()) this.popover.sendSnapshot(s);
  }

  private onEvents(events: BoardEvent[]): void {
    if (events.some((e) => e.type === 'status')) this.update(this.deps.engine.getSnapshot());
  }
}
