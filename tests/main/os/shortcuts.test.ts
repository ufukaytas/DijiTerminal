// Global kısayollar (04/03): kayıt raporu, hedef seçimi, komutlar. Electron yok; globalShortcut sahte.
import { describe, expect, it, vi } from 'vitest';
import type { BoardSnapshot, SessionView } from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { conflictMessage, CYCLE_MS, pickWaitingTarget, ShortcutManager, shortcutTable } from '@main/os/shortcuts';
import { formatAccelerator } from '@shared/accelerator';

const T = 1_800_000_000_000;

function sess(id: string, p: Partial<SessionView> = {}): SessionView {
  return {
    id,
    pid: 1,
    live: true,
    name: id,
    title: '',
    lastPrompt: '',
    cwd: '/x',
    projectId: 'p',
    branch: null,
    worktree: null,
    model: 'opus',
    effort: null,
    status: 'idle',
    statusSince: T,
    waitingFor: null,
    ctxTokens: 0,
    ctxMax: 200_000,
    ctxRatio: 0,
    costUsd: 0,
    toolCount: 0,
    errorCount: 0,
    flags: [],
    agents: [],
    terminal: { app: 'iterm2', tty: `/dev/ttys0${id.length}`, pid: 1 },
    background: null,
    hotkey: null,
    startedAt: T,
    lastTs: T,
    cpuPct: null,
    memMb: null,
    ...p,
  };
}
function snap(sessions: SessionView[]): BoardSnapshot {
  return {
    at: T,
    booted: true,
    dayStart: 0,
    projects: [],
    sessions,
    log: [],
    limits: null,
    totals: { projects: 0, liveSessions: 0, waiting: 0, runningAgents: 0, conflicts: 0, slowTools: 0, toolsPerMin: 0, costTodayUsd: 0 },
  };
}

function fakeGs(taken: string[] = []) {
  const map = new Map<string, () => void>();
  return {
    map,
    register: vi.fn((acc: string, cb: () => void) => {
      if (taken.includes(acc)) return false;
      map.set(acc, cb);
      return true;
    }),
    unregister: vi.fn((acc: string) => void map.delete(acc)),
  };
}

function setup(sessions: SessionView[], taken: string[] = []) {
  let now = T;
  const gs = fakeGs(taken);
  const deps = {
    globalShortcut: gs,
    getSnapshot: () => snap(sessions),
    focusSession: vi.fn(async () => ({ ok: true as const, app: 'iterm2' as const })),
    selectSession: vi.fn(),
    toggleWindow: vi.fn(),
    showWindow: vi.fn(),
    beep: vi.fn(),
    nothingTo: vi.fn(),
    now: () => now,
  };
  const m = new ShortcutManager(deps);
  return { m, gs, deps, at: (t: number) => (now = T + t) };
}

describe('shortcutTable', () => {
  it('varsayılan set: 2 komut + 9 session', () => {
    const t = shortcutTable(DEFAULT_SETTINGS.shortcuts);
    expect(t).toHaveLength(11);
    expect(t[0]).toEqual({ command: 'focusWaiting', accelerator: 'Control+Alt+W' });
    expect(t[10]).toEqual({ command: 'session-9', accelerator: 'Control+Alt+9' });
  });
  it('kapalıysa boş', () => {
    expect(shortcutTable({ ...DEFAULT_SETTINGS.shortcuts, enabled: false })).toEqual([]);
  });
});

describe('pickWaitingTarget', () => {
  const a = sess('a', { status: 'waiting', statusSince: T - 30_000 });
  const b = sess('b', { status: 'waiting', statusSince: T - 90_000 });
  const slow = sess('slow', { status: 'busy', flags: ['slow-tool'], statusSince: T - 600_000 });

  it('en uzun bekleyen önce; 4 sn içinde tekrar → sıradaki, döngüsel', () => {
    const s = snap([a, b, slow]);
    expect(pickWaitingTarget(s, null, T)?.id).toBe('b');
    expect(pickWaitingTarget(s, { id: 'b', at: T }, T + 1000)?.id).toBe('a');
    expect(pickWaitingTarget(s, { id: 'a', at: T }, T + 1000)?.id).toBe('b');
    expect(pickWaitingTarget(s, { id: 'b', at: T }, T + CYCLE_MS + 1)?.id).toBe('b');
  });

  it('bekleyen yoksa yavaş araçlı; o da yoksa null; bitmiş session sayılmaz', () => {
    expect(pickWaitingTarget(snap([slow, sess('i')]), null, T)?.id).toBe('slow');
    expect(pickWaitingTarget(snap([sess('i'), sess('w', { status: 'waiting', live: false })]), null, T)).toBeNull();
  });
});

describe('ShortcutManager', () => {
  it('kayıt raporu: çakışan kısayol conflict, yinelenen duplicate', () => {
    const { m } = setup([], ['Control+Alt+D']);
    const r = m.apply({ ...DEFAULT_SETTINGS.shortcuts, focusWaiting: 'Control+Alt+1' });
    const by = Object.fromEntries(r.items.map((i) => [i.command, i]));
    expect(by['toggleBoard']).toMatchObject({ registered: false, reason: 'conflict' });
    expect(by['focusWaiting']).toMatchObject({ registered: true });
    expect(by['session-1']).toMatchObject({ registered: false, reason: 'duplicate' });
    expect(by['session-2']).toMatchObject({ registered: true });
    expect(conflictMessage(r, formatAccelerator)).toBe('⌃⌥D kısayolu başka bir uygulama tarafından kullanılıyor. Ayarlardan değiştirin.');
  });

  it('yeniden uygulama yalnızca kendi kayıtlarını kaldırır; dispose hepsini', () => {
    const { m, gs } = setup([]);
    m.apply(DEFAULT_SETTINGS.shortcuts);
    expect(gs.map.size).toBe(11);
    m.apply({ ...DEFAULT_SETTINGS.shortcuts, enabled: false });
    expect(gs.map.size).toBe(0);
    expect(gs.unregister).toHaveBeenCalledTimes(11);
    m.apply(DEFAULT_SETTINGS.shortcuts);
    m.dispose();
    expect(gs.map.size).toBe(0);
    expect(m.report()).toEqual({ enabled: false, items: [] });
  });

  it('bekleyene git: seçer ve terminale odaklanır; art arda basışta sıradaki', async () => {
    const { m, gs, deps, at } = setup([
      sess('a', { status: 'waiting', statusSince: T - 10_000 }),
      sess('bb', { status: 'waiting', statusSince: T - 20_000 }),
    ]);
    m.apply(DEFAULT_SETTINGS.shortcuts);
    gs.map.get('Control+Alt+W')?.();
    at(1000);
    gs.map.get('Control+Alt+W')?.();
    expect(deps.selectSession.mock.calls.map((c) => c[0])).toEqual(['bb', 'a']);
    expect(deps.focusSession).toHaveBeenCalledTimes(2);
    await Promise.resolve();
    expect(deps.showWindow).not.toHaveBeenCalled();
  });

  it('bekleyen yok → bip ve bilgi', () => {
    const { m, deps } = setup([sess('i')]);
    m.run('focusWaiting');
    expect(deps.beep).toHaveBeenCalledOnce();
    expect(deps.nothingTo).toHaveBeenCalledWith('Bekleyen session yok.');
  });

  it('session-N: numaralı session; yoksa bip; terminal yoksa pencere', () => {
    const { m, deps } = setup([sess('a', { hotkey: 1 }), sess('b', { hotkey: 2, terminal: null })]);
    m.run('session-1');
    expect(deps.selectSession).toHaveBeenLastCalledWith('a');
    expect(deps.focusSession).toHaveBeenCalledOnce();
    m.run('session-2');
    expect(deps.selectSession).toHaveBeenLastCalledWith('b');
    expect(deps.showWindow).toHaveBeenCalledOnce();
    m.run('session-5');
    expect(deps.beep).toHaveBeenCalledOnce();
  });

  it('arka plan session\'ı (07/01): iTerm2 yerine uygulamada açılır', () => {
    const { m, deps } = setup([sess('a', { hotkey: 1, terminal: null, background: { id: '0a1b2c3d', state: null } })]);
    const openInApp = vi.fn();
    (deps as { openInApp?: (id: string) => void }).openInApp = openInApp;
    m.run('session-1');
    expect(openInApp).toHaveBeenCalledWith('a');
    expect(deps.focusSession).not.toHaveBeenCalled();
  });

  it('odaklanma başarısızsa pano öne gelir', async () => {
    const { m, deps } = setup([sess('a', { hotkey: 1 })]);
    deps.focusSession.mockResolvedValueOnce({ ok: false, reason: 'not-found' } as never);
    m.run('session-1');
    await new Promise((r) => setTimeout(r, 0));
    expect(deps.showWindow).toHaveBeenCalledOnce();
  });

  it('panoyu göster/gizle', () => {
    const { m, deps } = setup([]);
    m.run('toggleBoard');
    expect(deps.toggleWindow).toHaveBeenCalledOnce();
  });
});
