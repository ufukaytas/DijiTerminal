// 07/01: terminal paneli — sekme açma/kapama, akış yönlendirme, devralma şeridi, menü komutları, eylem seçimi.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { DijiApi, IpcEventMap } from '@shared/ipc';
import type { TerminalCapability } from '@shared/types';

const written: string[] = [];
let created = 0;
let keyHandler: ((e: KeyboardEvent) => boolean) | null = null;
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown>;
    cols = 120;
    rows = 24;
    constructor(o: Record<string, unknown>) {
      this.options = o;
      created++;
    }
    loadAddon() {}
    open() {}
    write(d: string) {
      written.push(d);
    }
    reset() {
      written.push('<reset>');
    }
    focus() {}
    dispose() {}
    onData() {
      return { dispose() {} };
    }
    onBinary() {
      return { dispose() {} };
    }
    attachCustomKeyEventHandler(h: (e: KeyboardEvent) => boolean) {
      keyHandler = h;
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));

const { TerminalDock } = await import('@renderer/components/terminal/TerminalDock');
const { isSuspendKey } = await import('@renderer/components/terminal/XtermView');
const { __resetTerminals, initTerminalBridge, routeData, useTerminals } = await import('@renderer/state/terminals');
const { activateSession } = await import('@renderer/state/actions');
const { resetBoard, useBoard } = await import('@renderer/state/board');
const { useToasts } = await import('@renderer/state/toast');
const { makeSnapshot } = await import('../__fixtures__/snapshot');

const NOW = 1_800_000_000_000;
const CAP: TerminalCapability = {
  available: true,
  reason: 'ok',
  claudePath: '/opt/claude',
  claudeVersion: '2.1.312',
  detail: null,
};

type Listener = (p: unknown) => void;
let listeners: Map<string, Listener[]>;
let invoke: ReturnType<typeof vi.fn>;

function setApi(): DijiApi {
  listeners = new Map();
  let n = 0;
  invoke = vi.fn(async (ch: string, ...args: unknown[]) => {
    if (ch === 'term:open') return { ok: true, data: { termId: 't-00000001', sessionId: args[0], reused: ++n > 1 } };
    if (ch === 'terminal:capability') return { ok: true, data: CAP };
    if (ch === 'action:focusTerminal') return { ok: true, data: { app: 'iterm2' } };
    return { ok: true, data: null };
  });
  const api = {
    invoke,
    on: (ch: string, cb: Listener) => {
      listeners.set(ch, [...(listeners.get(ch) ?? []), cb]);
      return () => undefined;
    },
  } as unknown as DijiApi;
  window.diji = api;
  return api;
}
function emit<K extends keyof IpcEventMap>(ch: K, p: IpcEventMap[K]) {
  act(() => {
    for (const cb of listeners.get(ch) ?? []) cb(p);
  });
}

let bgId: string;
beforeEach(() => {
  written.length = 0;
  keyHandler = null;
  resetBoard();
  useToasts.setState({ toasts: [] });
  const s = makeSnapshot(NOW);
  const first = s.sessions[0];
  if (first) first.background = { id: '0a1b2c3d', state: null };
  bgId = first?.id ?? '';
  useBoard.getState().setSnapshot(s);
  const api = setApi();
  __resetTerminals(api);
  initTerminalBridge(api);
});
afterEach(() => {
  cleanup();
  delete window.diji;
});

describe('TerminalDock', () => {
  it("sekme yokken hiç yer kaplamaz; App'te aç → term:open, sekme ve erken gelen veri xterm'e yazılır", async () => {
    const { container } = render(<TerminalDock />);
    expect(container.querySelector('.tdock')).toBeNull();
    routeData('t-00000001', 'ilk ekran');
    await act(async () => {
      await useTerminals.getState().openSession(bgId);
    });
    expect(invoke).toHaveBeenCalledWith('term:open', bgId, 120, 24);
    expect(container.querySelector('.tdock')).not.toBeNull();
    expect(screen.getAllByRole('tab')).toHaveLength(1);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    routeData('t-00000001', 'devam');
    expect(written.join('|')).toContain('ilk ekran');
    expect(written).toContain('devam');
  });

  it('devralındı → "Buraya geri al" aynı session\'ı yeniden açar; kapatma term:close gönderir', async () => {
    render(<TerminalDock />);
    await act(async () => {
      await useTerminals.getState().openSession(bgId);
    });
    emit('term:exit', { termId: 't-00000001', reason: 'taken-over', code: 0 });
    expect(screen.getByText('Başka bir terminalde açıldı.')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Buraya geri al' }));
    });
    expect(invoke.mock.calls.filter((c) => c[0] === 'term:open')).toHaveLength(2);
    expect(written).toContain('<reset>');
    expect(screen.queryByText('Başka bir terminalde açıldı.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /sekmesini kapat/ }));
    expect(invoke).toHaveBeenCalledWith('term:close', 't-00000001');
    expect(useTerminals.getState().tabs).toHaveLength(0);
  });

  it('session yoksa yeniden bağlan düğmesi gösterilmez', async () => {
    render(<TerminalDock />);
    await act(async () => {
      await useTerminals.getState().openSession(bgId);
    });
    emit('term:exit', { termId: 't-00000001', reason: 'not-found', code: 1 });
    expect(screen.getByText('Session artık yok.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /geri al|Yeniden bağlan/ })).toBeNull();
  });

  it('pencere (modal) görünümü: geçişte xterm yeniden kurulmaz; arka plana tıklayınca kapanır, sekme kalır', async () => {
    const { container } = render(<TerminalDock />);
    await act(async () => {
      await useTerminals.getState().openSession(bgId);
      await Promise.resolve();
    });
    const before = created;
    expect(container.querySelector('.tdock-wrap.dock')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Pencere olarak aç' }));
    expect(container.querySelector('.tdock-wrap.modal')).not.toBeNull();
    expect(screen.getByRole('dialog', { name: 'Terminal' })).toBeTruthy();
    emit('ui:terminalCommand', 'toggleLayout');
    expect(useTerminals.getState().layout).toBe('dock');
    emit('ui:terminalCommand', 'toggleLayout');
    expect(created).toBe(before);
    // Pencerede 8 boyutlandırma tutamacı; çubuğa çift tıklama konumu sıfırlar.
    expect(container.querySelectorAll('.tdock-rz')).toHaveLength(8);
    useTerminals.getState().setModalRect({ x: 10, y: 10, w: 600, h: 400 });
    fireEvent.doubleClick(container.querySelector('.tdock-bar') as Element);
    expect(useTerminals.getState().modalRect).toBeNull();
    fireEvent.mouseDown(container.querySelector('.tdock-backdrop') as Element);
    expect(useTerminals.getState().open).toBe(false);
    expect(useTerminals.getState().tabs).toHaveLength(1);
    expect(container.querySelector('.tdock-wrap.hidden')).not.toBeNull();
  });

  it('menü komutları: ⌘J paneli gizler/açar, ⇧⌘W sekmeyi kapatır', async () => {
    render(<TerminalDock />);
    await act(async () => {
      await useTerminals.getState().openSession(bgId);
    });
    emit('ui:terminalCommand', 'toggle');
    expect(useTerminals.getState().open).toBe(false);
    emit('ui:terminalCommand', 'toggle');
    expect(useTerminals.getState().open).toBe(true);
    emit('ui:terminalCommand', 'closeTab');
    expect(useTerminals.getState().tabs).toHaveLength(0);
  });

  it('Ctrl+Z gönderilmez ve ipucu gösterilir', async () => {
    render(<TerminalDock />);
    await act(async () => {
      await useTerminals.getState().openSession(bgId);
      await Promise.resolve();
    });
    const ev = {
      type: 'keydown',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      key: 'z',
    } as KeyboardEvent;
    expect(isSuspendKey(ev)).toBe(true);
    expect(isSuspendKey({ ...ev, metaKey: true })).toBe(false);
    let r = true;
    act(() => {
      r = keyHandler?.(ev) ?? true;
    });
    expect(r).toBe(false);
    expect(screen.getByText(/Ctrl\+Z terminale gönderilmez/)).toBeTruthy();
  });

  it('açma hatası toast olur ve panel kapanır', async () => {
    invoke.mockImplementationOnce(async () => ({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Bu session arka planda değil.' },
    }));
    render(<TerminalDock />);
    await act(async () => {
      await useTerminals.getState().openSession(bgId);
    });
    expect(useToasts.getState().toasts[0]?.message).toBe('Bu session arka planda değil.');
    expect(useTerminals.getState().open).toBe(false);
  });
});

describe('activateSession', () => {
  it('arka plan + terminal kullanılabilir → uygulamada açar; değilse iTerm2 sekmesine gider', async () => {
    useTerminals.getState().setCapability(CAP);
    await activateSession(bgId);
    expect(invoke).toHaveBeenCalledWith('term:open', bgId, 120, 24);
    const other = useBoard.getState().snapshot.sessions[1]?.id ?? '';
    await activateSession(other);
    expect(invoke).toHaveBeenCalledWith('action:focusTerminal', other);
    useTerminals.getState().setCapability({ ...CAP, available: false, reason: 'not-found' });
    invoke.mockClear();
    await activateSession(bgId);
    expect(invoke).toHaveBeenCalledWith('action:focusTerminal', bgId);
  });
});

describe("DetailPanel: arka plan session'ı", () => {
  it('ARKA PLAN rozeti ve "Uygulamada aç" birincil eylem', async () => {
    const { DetailPanel } = await import('@renderer/components/detail/DetailPanel');
    useTerminals.getState().setCapability(CAP);
    act(() => useBoard.getState().select(bgId));
    render(<DetailPanel />);
    expect(screen.getByText('ARKA PLAN')).toBeTruthy();
    expect(screen.queryByText('iTerm2 sekmesine git')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Uygulamada aç/ }));
    });
    expect(invoke).toHaveBeenCalledWith('term:open', bgId, 120, 24);
  });
});

describe('session durdurma düğmesi', () => {
  it('iki adımlı onay: ilk tıklama sorar, ikincisi claude stop ister ve sekmeyi kapatır', async () => {
    render(<TerminalDock />);
    await act(async () => {
      await useTerminals.getState().openSession(bgId);
    });
    fireEvent.click(screen.getByRole('button', { name: "Session'ı kapat" }));
    expect(invoke).not.toHaveBeenCalledWith('session:stopBackground', bgId);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Emin misiniz? Kapat' }));
    });
    expect(invoke).toHaveBeenCalledWith('session:stopBackground', bgId);
    expect(useTerminals.getState().tabs).toHaveLength(0);
    expect(useToasts.getState().toasts.at(-1)?.message).toBe('Session kapatıldı.');
  });
});
