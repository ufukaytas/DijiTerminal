// 06/01 menü çubuğu modu: ikon durumu/başlık, açılır liste konumu, tıklama/blur, snapshot aboneliği, komutlar.
import { describe, expect, it, vi } from 'vitest';
import type { BoardEvent, BoardSnapshot, SessionStatus, SessionView } from '@shared/types';
import {
  BLUR_CLICK_GUARD_MS,
  TrayController,
  type PopoverLike,
  type TrayLike,
  type TrayMenuItem,
} from '@main/tray/controller';
import { POPOVER_SIZE, popoverPosition, trayView } from '@main/tray/logic';
import { attentionText, waitingCount } from '@main/os/attention';

const SID = 'aaaaaaaa-0000-4000-8000-000000000001';

function session(status: SessionStatus, i = 0): SessionView {
  return { id: `aaaaaaaa-0000-4000-8000-00000000000${i}`, status } as SessionView;
}

function snap(statuses: SessionStatus[], o: Partial<BoardSnapshot> = {}): BoardSnapshot {
  const sessions = statuses.map((s, i) => session(s, i));
  return {
    at: 1,
    booted: true,
    dayStart: 0,
    projects: [],
    sessions,
    log: [],
    limits: null,
    totals: {
      projects: 0,
      liveSessions: sessions.length,
      waiting: statuses.filter((s) => s === 'waiting').length,
      runningAgents: 0,
      conflicts: 0,
      slowTools: 0,
      toolsPerMin: 0,
      costTodayUsd: 0,
    },
    ...o,
  };
}

describe('attention (Dock rozeti ile ortak sayaç)', () => {
  it('motorun waiting sayacı; sıfırsa boş metin', () => {
    expect(waitingCount(snap(['waiting', 'busy', 'waiting']))).toBe(2);
    expect(attentionText(2)).toBe('2');
    expect(attentionText(0)).toBe('');
  });
});

describe('trayView', () => {
  it('bekleyen varsa waiting ikonu ve başlıkta sayı', () => {
    expect(trayView(snap(['waiting', 'busy', 'waiting']))).toEqual({
      icon: 'waiting',
      title: ' 2',
      tooltip: 'DijiTerminal · 2 onay bekliyor · 1 çalışıyor',
    });
  });
  it('yalnızca çalışan varsa busy, başlık boş', () => {
    expect(trayView(snap(['busy', 'idle']))).toMatchObject({
      icon: 'busy',
      title: '',
      tooltip: 'DijiTerminal · 1 çalışıyor',
    });
  });
  it('hiçbiri yoksa idle; açılışta "başlatılıyor"', () => {
    expect(trayView(snap(['idle', 'ended']))).toMatchObject({
      icon: 'idle',
      title: '',
      tooltip: 'DijiTerminal · boşta',
    });
    expect(trayView(snap([], { booted: false })).tooltip).toBe('DijiTerminal · başlatılıyor…');
  });
});

describe('popoverPosition', () => {
  const area = { x: 0, y: 25, width: 1512, height: 920 }; // menü çubuğu 25 px
  it('ikonun altına, ikona ortalanmış', () => {
    expect(popoverPosition({ x: 1000, y: 0, width: 24, height: 24 }, POPOVER_SIZE, area)).toEqual({ x: 832, y: 29 });
  });
  it('sağ kenara taşarsa içeri itilir', () => {
    expect(popoverPosition({ x: 1490, y: 0, width: 22, height: 24 }, POPOVER_SIZE, area)).toEqual({
      x: 1512 - 360 - 8,
      y: 29,
    });
  });
  it('sol kenar ve ikinci ekran (negatif x)', () => {
    const left = { x: -1920, y: 0, width: 1920, height: 1055 };
    expect(popoverPosition({ x: -1915, y: 0, width: 24, height: 24 }, POPOVER_SIZE, { ...left, y: 25 })).toEqual({
      x: -1912,
      y: 29,
    });
  });
  it('ikon alttaysa (görev çubuğu) liste üstüne açılır', () => {
    const a = { x: 0, y: 0, width: 1920, height: 1040 };
    expect(popoverPosition({ x: 1800, y: 1045, width: 24, height: 30 }, POPOVER_SIZE, a)).toEqual({
      x: 1920 - 360 - 8,
      y: 1040 - 480 - 8,
    });
  });
  it('ikon konumu bilinmiyorsa sağ üst köşe', () => {
    expect(popoverPosition({ x: 0, y: 0, width: 0, height: 0 }, POPOVER_SIZE, area)).toEqual({ x: 1144, y: 29 });
  });
});

function harness(initial = snap(['busy'])) {
  let current = initial;
  let snapCb: ((s: BoardSnapshot) => void) | null = null;
  let eventCb: ((e: BoardEvent[]) => void) | null = null;
  const engine = {
    getSnapshot: vi.fn(() => current),
    onSnapshot: vi.fn((cb: (s: BoardSnapshot) => void) => {
      snapCb = cb;
      return () => (snapCb = null);
    }),
    onEvents: vi.fn((cb: (e: BoardEvent[]) => void) => {
      eventCb = cb;
      return () => (eventCb = null);
    }),
  };
  let click: (() => void) | null = null;
  let rightClick: (() => void) | null = null;
  const menus: TrayMenuItem[][] = [];
  const tray = {
    setIcon: vi.fn(),
    setTitle: vi.fn(),
    setToolTip: vi.fn(),
    getBounds: () => ({ x: 1000, y: 0, width: 24, height: 24 }),
    onClick: (cb: () => void) => (click = cb),
    onRightClick: (cb: () => void) => (rightClick = cb),
    popUpMenu: (items: TrayMenuItem[]) => menus.push(items),
    destroy: vi.fn(),
  } satisfies TrayLike;
  let visible = false;
  let blur: (() => void) | null = null;
  const sent: BoardSnapshot[] = [];
  const popover = {
    size: POPOVER_SIZE,
    showAt: vi.fn(() => (visible = true)),
    hide: vi.fn(() => (visible = false)),
    isVisible: () => visible,
    onBlur: (cb: () => void) => (blur = cb),
    sendSnapshot: (s: BoardSnapshot) => sent.push(s),
    destroy: vi.fn(),
  } satisfies PopoverLike;
  let t = 1000;
  const actions = { openBoard: vi.fn(), openSettings: vi.fn(), quit: vi.fn(), showOnMap: vi.fn(), openInApp: vi.fn() };
  const visibility: boolean[] = [];
  const createPopover = vi.fn(() => popover);
  const c = new TrayController({
    engine,
    createTray: () => tray,
    createPopover,
    workAreaNear: () => ({ x: 0, y: 25, width: 1512, height: 920 }),
    actions,
    onPopoverVisibility: (v) => visibility.push(v),
    now: () => t,
  });
  return {
    c,
    tray,
    popover,
    actions,
    sent,
    menus,
    visibility,
    createPopover,
    engine,
    setSnap: (s: BoardSnapshot) => (current = s),
    emitSnap: (s: BoardSnapshot) => {
      current = s;
      snapCb?.(s);
    },
    emitEvents: (e: BoardEvent[]) => eventCb?.(e),
    click: () => click?.(),
    rightClick: () => rightClick?.(),
    blur: () => blur?.(),
    advance: (ms: number) => (t += ms),
  };
}

describe('TrayController', () => {
  it('başlarken ikonu kurar; açılır liste ilk tıklamaya kadar oluşturulmaz', () => {
    const h = harness(snap(['waiting', 'busy']));
    h.c.start();
    expect(h.tray.setIcon).toHaveBeenCalledWith('waiting');
    expect(h.tray.setTitle).toHaveBeenCalledWith(' 1');
    expect(h.createPopover).not.toHaveBeenCalled();
  });

  it("değişmeyen alanlar Electron'a tekrar yazılmaz", () => {
    const h = harness();
    h.c.start();
    h.emitSnap(snap(['busy']));
    h.emitSnap(snap(['busy']));
    expect(h.tray.setIcon).toHaveBeenCalledTimes(1);
    h.emitSnap(snap(['waiting']));
    expect(h.tray.setIcon).toHaveBeenLastCalledWith('waiting');
    expect(h.tray.setTitle).toHaveBeenLastCalledWith(' 1');
  });

  it("status olayı 5 sn'lik gizli tempo snapshot'ını beklemeden ikonu günceller", () => {
    const h = harness();
    h.c.start();
    h.setSnap(snap(['waiting']));
    h.emitEvents([{ type: 'status', sessionId: SID, from: 'busy', to: 'waiting', at: 1 }]);
    expect(h.tray.setIcon).toHaveBeenLastCalledWith('waiting');
  });

  it('tıklama açar: konumlanır, güncel snapshot gönderilir, tempo bildirilir; ikinci tıklama kapatır', () => {
    const h = harness();
    h.c.start();
    h.click();
    expect(h.popover.showAt).toHaveBeenCalledWith({ x: 832, y: 29 });
    expect(h.sent).toHaveLength(1);
    expect(h.visibility).toEqual([true]);
    h.click();
    expect(h.popover.hide).toHaveBeenCalled();
    expect(h.visibility).toEqual([true, false]);
  });

  it('blur ile kapandıktan hemen sonra gelen ikon tıklaması yeniden açmaz', () => {
    const h = harness();
    h.c.start();
    h.click();
    h.blur(); // ikona tıklamak önce listenin odağını alır
    h.advance(50);
    h.click();
    expect(h.c.isPopoverVisible()).toBe(false);
    h.advance(BLUR_CLICK_GUARD_MS);
    h.click();
    expect(h.c.isPopoverVisible()).toBe(true);
  });

  it('snapshot yalnızca liste açıkken gönderilir (05/02)', () => {
    const h = harness();
    h.c.start();
    h.emitSnap(snap(['busy']));
    expect(h.sent).toHaveLength(0);
    h.click();
    h.emitSnap(snap(['idle']));
    expect(h.sent).toHaveLength(2);
    h.click();
    h.emitSnap(snap(['busy']));
    expect(h.sent).toHaveLength(2);
  });

  it('komutlar: kapat, panoyu aç, ayarlar, haritada göster (kimlik doğrulanır), çıkış', () => {
    const h = harness();
    h.c.start();
    h.click();
    expect(h.c.command('openBoard')).toEqual({ ok: true, data: null });
    expect(h.actions.openBoard).toHaveBeenCalled();
    expect(h.c.isPopoverVisible()).toBe(false);
    h.c.command('openSettings');
    expect(h.actions.openSettings).toHaveBeenCalled();
    expect(h.c.command('showOnMap', 'kotu-id').ok).toBe(false);
    expect(h.actions.showOnMap).not.toHaveBeenCalled();
    h.c.command('showOnMap', SID);
    expect(h.actions.showOnMap).toHaveBeenCalledWith(SID);
    expect(h.c.command('openInApp', 'kotu-id').ok).toBe(false);
    expect(h.actions.openInApp).not.toHaveBeenCalled();
    h.click();
    h.c.command('openInApp', SID);
    expect(h.actions.openInApp).toHaveBeenCalledWith(SID);
    expect(h.c.isPopoverVisible()).toBe(false);
    h.click();
    h.c.command('close');
    expect(h.c.isPopoverVisible()).toBe(false);
    h.c.command('quit');
    expect(h.actions.quit).toHaveBeenCalled();
    expect(h.c.command('rm -rf' as never).ok).toBe(false);
  });

  it('sağ tık: Panoyu aç / Ayarlar / Çıkış menüsü', () => {
    const h = harness();
    h.c.start();
    h.rightClick();
    const items = h.menus[0]!;
    expect(items.map((i) => ('label' in i ? i.label : '—'))).toEqual([
      'Panoyu aç',
      'Ayarlar…',
      '—',
      "DijiTerminal'den çık",
    ]);
    const quit = items[3]!;
    if ('click' in quit) quit.click();
    expect(h.actions.quit).toHaveBeenCalled();
  });

  it('durdurunca abonelikler, liste ve ikon kaldırılır', () => {
    const h = harness();
    h.c.start();
    h.click();
    h.c.stop();
    expect(h.popover.destroy).toHaveBeenCalled();
    expect(h.tray.destroy).toHaveBeenCalled();
    expect(h.visibility).toEqual([true, false]);
    expect(h.c.running).toBe(false);
    h.emitSnap(snap(['waiting']));
    expect(h.tray.setIcon).toHaveBeenCalledTimes(1);
  });
});
