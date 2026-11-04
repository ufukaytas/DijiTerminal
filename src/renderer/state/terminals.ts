// Gömülü terminal paneli durumu (07/01). Sekme listesi ve panel görünürlüğü Zustand'da; terminal akışı
// React'e uğramadan doğrudan ilgili xterm örneğine yazılır (yüksek frekans). Akış içeriği hiçbir yerde saklanmaz.
import { create } from 'zustand';
import type { DijiApi, TermExitReason, TerminalCommand } from '@shared/ipc';
import type { TerminalCapability } from '@shared/types';
import { pushToast } from './toast';

export type TabStatus = 'connecting' | 'live' | 'exited';

export interface TermTab {
  termId: string;
  sessionId: string;
  status: TabStatus;
  exitReason: TermExitReason | null;
}

export interface TerminalState {
  capability: TerminalCapability | null;
  tabs: TermTab[];
  activeId: string | null;
  /** Panel görünür mü (sekmeler kapatılmadan gizlenebilir). */
  open: boolean;
  /** Bağlanmayı bekleyen session (sekme açılmadan önce). */
  pendingSessionId: string | null;
  /** Panel yüksekliği (px). */
  height: number;
  /** Görünüm: alttaki panel ya da haritanın üstünde pencere (modal). Tarayıcıda hatırlanır. */
  layout: TerminalLayout;
  setLayout(l: TerminalLayout): void;
  /** Pencere görünümünün konumu ve boyutu (null → ortada varsayılan). Tarayıcıda hatırlanır. */
  modalRect: ModalRect | null;
  setModalRect(r: ModalRect | null): void;
  setCapability(c: TerminalCapability): void;
  setOpen(open: boolean): void;
  setHeight(h: number): void;
  activate(termId: string): void;
  /** Session'ı panelde aç (açıksa öne getir; çıkmışsa yeniden bağlan). */
  openSession(sessionId: string): Promise<boolean>;
  reconnect(termId: string): Promise<boolean>;
  close(termId: string): void;
  command(cmd: TerminalCommand): void;
  /** Bridge: main'den çıkış bildirimi. */
  onExit(termId: string, reason: TermExitReason): void;
}

export type TerminalLayout = 'dock' | 'modal';
const LAYOUT_KEY = 'diji.terminal.layout';
const RECT_KEY = 'diji.terminal.modalRect';

export interface ModalRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export const MODAL_MIN_W = 480;
export const MODAL_MIN_H = 240;
const MODAL_MARGIN = 16;
/** Pencerenin çubuğundan en az bu kadarı ekranda kalır (dışarı sürüklenip kaybolmasın). */
const KEEP_VISIBLE = 80;

/** Varsayılan: ortada, en çok 1320×860. */
export function defaultModalRect(vw: number, vh: number): ModalRect {
  const w = Math.max(MODAL_MIN_W, Math.min(1320, vw - 2 * MODAL_MARGIN));
  const h = Math.max(MODAL_MIN_H, Math.min(860, vh - 4 * MODAL_MARGIN));
  return { x: Math.round((vw - w) / 2), y: Math.round((vh - h) / 2), w, h };
}

/** Boyutu en az/en çok sınırlar; çubuk her zaman ekranda kalır. */
export function clampModalRect(r: ModalRect, vw: number, vh: number): ModalRect {
  const w = Math.round(Math.max(MODAL_MIN_W, Math.min(r.w, vw)));
  const h = Math.round(Math.max(MODAL_MIN_H, Math.min(r.h, vh)));
  const x = Math.round(Math.min(Math.max(r.x, KEEP_VISIBLE - w), vw - KEEP_VISIBLE));
  const y = Math.round(Math.min(Math.max(r.y, 0), vh - 40));
  return { x, y, w, h };
}

/** Pencere kenar/köşe tutamaçları (n, s, e, w ve köşeler). */
export const RESIZE_DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;
export type Gesture = 'move' | (typeof RESIZE_DIRS)[number];

/** Sürükleme/boyutlandırma adımı: başlangıç dikdörtgeni + fare farkı → yeni dikdörtgen (en küçük boyut korunur). */
export function applyGesture(g: Gesture, r: ModalRect, dx: number, dy: number): ModalRect {
  if (g === 'move') return { ...r, x: r.x + dx, y: r.y + dy };
  let { x, y, w, h } = r;
  if (g.includes('e')) w = Math.max(MODAL_MIN_W, r.w + dx);
  if (g.includes('s')) h = Math.max(MODAL_MIN_H, r.h + dy);
  if (g.includes('w')) {
    w = Math.max(MODAL_MIN_W, r.w - dx);
    x = r.x + (r.w - w);
  }
  if (g.includes('n')) {
    h = Math.max(MODAL_MIN_H, r.h - dy);
    y = r.y + (r.h - h);
  }
  return { x, y, w, h };
}

function loadRect(): ModalRect | null {
  try {
    const v = JSON.parse(localStorage.getItem(RECT_KEY) ?? 'null') as Partial<ModalRect> | null;
    if (v && [v.x, v.y, v.w, v.h].every((n) => typeof n === 'number' && Number.isFinite(n))) return v as ModalRect;
  } catch {
    // yok
  }
  return null;
}
function loadLayout(): TerminalLayout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === 'modal' ? 'modal' : 'dock';
  } catch {
    return 'dock';
  }
}

export const DEFAULT_HEIGHT = 320;
export const MIN_HEIGHT = 160;
const HEIGHT_KEY = 'diji.terminal.height';

/** Henüz ölçülmemiş panel için başlangıç boyutu; xterm mount olunca fit ile düzeltilir. */
export const INITIAL_COLS = 120;
export const INITIAL_ROWS = 24;

function loadHeight(): number {
  try {
    const v = Number(localStorage.getItem(HEIGHT_KEY));
    return Number.isFinite(v) && v >= MIN_HEIGHT ? v : DEFAULT_HEIGHT;
  } catch {
    return DEFAULT_HEIGHT;
  }
}

let api: DijiApi | undefined = typeof window !== 'undefined' ? window.diji : undefined;

// ---------- akış yönlendirme (React dışı) ----------

type Sink = { write(data: string): void; reset(): void };
const sinks = new Map<string, Sink>();
/** xterm mount olmadan gelen veri (ilk ekran). */
const early = new Map<string, string[]>();
const EARLY_MAX = 512 * 1024;

export function registerSink(termId: string, sink: Sink): () => void {
  sinks.set(termId, sink);
  const buf = early.get(termId);
  if (buf) {
    early.delete(termId);
    sink.write(buf.join(''));
  }
  return () => {
    if (sinks.get(termId) === sink) sinks.delete(termId);
  };
}

export function routeData(termId: string, data: string): void {
  const s = sinks.get(termId);
  if (s) {
    s.write(data);
    return;
  }
  const buf = early.get(termId) ?? [];
  buf.push(data);
  let n = 0;
  for (const b of buf) n += b.length;
  while (n > EARLY_MAX && buf.length > 1) n -= buf.shift()?.length ?? 0;
  early.set(termId, buf);
}

/** Son bilinen boyut (xterm fit sonrası); yeniden bağlanırken kullanılır. */
const dims = new Map<string, { cols: number; rows: number }>();
export function rememberDims(termId: string, cols: number, rows: number): void {
  dims.set(termId, { cols, rows });
}

export async function sendInput(termId: string, data: string): Promise<void> {
  if (!api) return;
  try {
    await api.invoke('term:write', termId, data);
  } catch {
    // pencere kapanıyor
  }
}

/** Sekmeye dönüldü: main session'ı bu sekmenin boyutuyla yeniden çizdirir (saniyede en fazla bir). */
export async function requestRedraw(termId: string): Promise<void> {
  if (!api) return;
  try {
    await api.invoke('term:redraw', termId);
  } catch {
    // yok
  }
}

export async function sendResize(termId: string, cols: number, rows: number): Promise<void> {
  rememberDims(termId, cols, rows);
  if (!api) return;
  try {
    await api.invoke('term:resize', termId, cols, rows);
  } catch {
    // yok
  }
}

const EXIT_TEXT: Record<TermExitReason, string> = {
  closed: 'Bağlantı kapatıldı.',
  'not-found': 'Session artık yok.',
  'taken-over': 'Başka bir terminalde açıldı.',
  exited: 'Bağlantı kapandı.',
  'spawn-failed': 'Terminal başlatılamadı.',
};
export const exitText = (r: TermExitReason | null): string => (r ? EXIT_TEXT[r] : '');

export const useTerminals = create<TerminalState>()((set, get) => ({
  capability: null,
  tabs: [],
  activeId: null,
  open: false,
  pendingSessionId: null,
  height: loadHeight(),
  layout: loadLayout(),
  modalRect: loadRect(),
  setModalRect: (modalRect) => {
    set({ modalRect });
    try {
      if (modalRect) localStorage.setItem(RECT_KEY, JSON.stringify(modalRect));
      else localStorage.removeItem(RECT_KEY);
    } catch {
      // yok
    }
  },
  setLayout: (layout) => {
    set({ layout });
    try {
      localStorage.setItem(LAYOUT_KEY, layout);
    } catch {
      // yok
    }
  },
  setCapability: (capability) => set({ capability }),
  setOpen: (open) => set({ open: open && (get().tabs.length > 0 || get().pendingSessionId !== null) }),
  setHeight: (h) => {
    const height = Math.max(MIN_HEIGHT, Math.round(h));
    set({ height });
    try {
      localStorage.setItem(HEIGHT_KEY, String(height));
    } catch {
      // yok
    }
  },
  activate: (termId) => {
    if (get().tabs.some((t) => t.termId === termId)) set({ activeId: termId, open: true });
  },
  async openSession(sessionId) {
    const st = get();
    const existing = st.tabs.find((t) => t.sessionId === sessionId);
    if (existing && existing.status !== 'exited') {
      set({ activeId: existing.termId, open: true });
      return true;
    }
    if (existing) return get().reconnect(existing.termId);
    if (!api) return false;
    set({ pendingSessionId: sessionId, open: true });
    let res: Awaited<ReturnType<DijiApi['invoke']>> | null;
    try {
      res = await api.invoke('term:open', sessionId, INITIAL_COLS, INITIAL_ROWS);
    } catch {
      res = null;
    }
    if (get().pendingSessionId === sessionId) set({ pendingSessionId: null });
    if (!res || !res.ok) {
      pushToast('error', res && !res.ok ? res.error.message : 'Terminal açılamadı.');
      if (get().tabs.length === 0) set({ open: false });
      return false;
    }
    const { termId } = res.data as { termId: string };
    set((s) => ({
      tabs: s.tabs.some((t) => t.termId === termId)
        ? s.tabs.map((t) => (t.termId === termId ? { ...t, status: 'live' as const, exitReason: null } : t))
        : [...s.tabs, { termId, sessionId, status: 'live' as const, exitReason: null }],
      activeId: termId,
      open: true,
    }));
    return true;
  },
  async reconnect(termId) {
    const tab = get().tabs.find((t) => t.termId === termId);
    if (!tab || !api) return false;
    set((s) => ({
      tabs: s.tabs.map((t) => (t.termId === termId ? { ...t, status: 'connecting' as const, exitReason: null } : t)),
      activeId: termId,
      open: true,
    }));
    sinks.get(termId)?.reset();
    const d = dims.get(termId) ?? { cols: INITIAL_COLS, rows: INITIAL_ROWS };
    let res: Awaited<ReturnType<DijiApi['invoke']>> | null;
    try {
      res = await api.invoke('term:open', tab.sessionId, d.cols, d.rows);
    } catch {
      res = null;
    }
    if (!res || !res.ok) {
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.termId === termId ? { ...t, status: 'exited' as const, exitReason: t.exitReason ?? 'exited' } : t,
        ),
      }));
      pushToast('error', res && !res.ok ? res.error.message : 'Yeniden bağlanılamadı.');
      return false;
    }
    set((s) => ({ tabs: s.tabs.map((t) => (t.termId === termId ? { ...t, status: 'live' as const } : t)) }));
    return true;
  },
  close(termId) {
    void api?.invoke('term:close', termId).catch(() => undefined);
    early.delete(termId);
    dims.delete(termId);
    set((s) => {
      const i = s.tabs.findIndex((t) => t.termId === termId);
      const tabs = s.tabs.filter((t) => t.termId !== termId);
      const activeId =
        s.activeId === termId ? (tabs[Math.min(Math.max(0, i), tabs.length - 1)]?.termId ?? null) : s.activeId;
      return { tabs, activeId, open: s.open && tabs.length > 0 };
    });
  },
  command(cmd) {
    const s = get();
    switch (cmd) {
      case 'toggle':
        get().setOpen(!s.open);
        return;
      case 'toggleLayout':
        get().setLayout(s.layout === 'dock' ? 'modal' : 'dock');
        if (!s.open) get().setOpen(true);
        return;
      case 'closeTab':
        if (s.open && s.activeId) get().close(s.activeId);
        return;
      case 'nextTab':
      case 'prevTab': {
        if (s.tabs.length < 2) return;
        const i = s.tabs.findIndex((t) => t.termId === s.activeId);
        const n = (i + (cmd === 'nextTab' ? 1 : -1) + s.tabs.length) % s.tabs.length;
        set({ activeId: s.tabs[n]?.termId ?? s.activeId, open: true });
        return;
      }
    }
  },
  onExit(termId, reason) {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.termId === termId && t.status !== 'connecting' ? { ...t, status: 'exited' as const, exitReason: reason } : t,
      ),
    }));
  },
}));

/** main ↔ terminal paneli köprüsü (App.tsx useEffect). */
export function initTerminalBridge(
  a: DijiApi | undefined = typeof window !== 'undefined' ? window.diji : undefined,
): () => void {
  api = a;
  if (!a) return () => {};
  const st = useTerminals.getState;
  const offs = [
    a.on('term:data', ({ termId, data }) => routeData(termId, data)),
    a.on('term:exit', ({ termId, reason }) => st().onExit(termId, reason)),
    a.on('terminal:capability', (c) => st().setCapability(c)),
    a.on('ui:openInApp', ({ sessionId }) => void st().openSession(sessionId)),
    a.on('ui:terminalCommand', (cmd) => st().command(cmd)),
  ];
  void a
    .invoke('terminal:capability')
    .then((r) => {
      if (r.ok) st().setCapability(r.data);
    })
    .catch(() => undefined);
  return () => {
    for (const off of offs) off();
  };
}

/** Testler: modül durumunu sıfırla. */
export function __resetTerminals(a?: DijiApi): void {
  api = a;
  sinks.clear();
  early.clear();
  dims.clear();
  useTerminals.setState({
    capability: null,
    tabs: [],
    activeId: null,
    open: false,
    pendingSessionId: null,
    height: DEFAULT_HEIGHT,
    layout: 'dock',
    modalRect: null,
  });
}
