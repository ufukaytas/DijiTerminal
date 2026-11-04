// 04/02 — bildirim kuralları (NotifyPlanner) ve Notifier zamanlaması. Electron yok; sahte saat ve sahte bildirim.
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@shared/settings';
import type { AgentView, AppSettings, BoardEvent, BoardSnapshot, SessionStatus, SessionView, ToolCall } from '@shared/types';
import { clip, fmtDuration, NotifyPlanner, NOTIFY, SUMMARY_KEY } from '@main/os/notifyRules';
import { Notifier, type NotificationLike } from '@main/os/notify';

const T0 = 1_800_000_000_000;
const sid = (n: number) => `aaaaaaaa-0000-4000-8000-00000000000${n}`;

function call(id: string, sessionId: string, startedAt: number, name = 'Bash', label = 'npm run db:migrate'): ToolCall {
  return { id, sessionId, agentId: null, name, category: name === 'Agent' ? 'agent' : 'bash', label, startedAt };
}

function session(n: number, status: SessionStatus, extra: Partial<SessionView> = {}, current: ToolCall | null = null): SessionView {
  const id = sid(n);
  const main: AgentView = {
    id: 'main', sessionId: id, isMain: true, name: 'ana ajan', agentType: 'main', team: null, model: 'opus', background: false,
    running: status === 'busy', done: false, current, toolCount: 0, errorCount: 0, costUsd: 0, firstTs: T0, lastTs: T0, doneAt: null, loopSuspect: false,
  };
  return {
    id, pid: 700 + n, live: status !== 'ended', name: `s${n}`, title: '', lastPrompt: 'gizli prompt metni', cwd: '/x', projectId: 'p1',
    branch: 'main', worktree: null, model: 'opus', effort: null, status, statusSince: T0, waitingFor: null, ctxTokens: 0, ctxMax: 200_000,
    ctxRatio: 0, costUsd: 0, toolCount: 0, errorCount: 0, flags: [], agents: [main], terminal: { app: 'iterm2', tty: `/dev/ttys00${n}`, pid: 700 + n },
    background: null, hotkey: n, startedAt: T0, lastTs: T0, cpuPct: null, memMb: null, ...extra,
  };
}

function snap(sessions: SessionView[], at = T0): BoardSnapshot {
  return {
    at, booted: true, dayStart: 0, sessions, log: [], limits: null,
    projects: [{ id: 'p1', root: '/x', name: 'youcms', displayPath: '~/x', color: '#fff', emblem: 'cube', tag: null, sessionIds: sessions.map((s) => s.id), costUsd: 0, conflicts: [], hotFiles: [] }],
    totals: { projects: 1, liveSessions: sessions.length, waiting: sessions.filter((s) => s.status === 'waiting').length, runningAgents: 0, conflicts: 0, slowTools: 0, toolsPerMin: 0, costTodayUsd: 0 },
  };
}

const status = (n: number, from: SessionStatus | null, to: SessionStatus, at: number): BoardEvent => ({ type: 'status', sessionId: sid(n), from, to, at });
const waitingS = (n: number) => session(n, 'waiting', { waitingFor: { tool: 'Bash', label: 'npm run db:migrate -- --env staging', since: T0 } });

let settings: AppSettings = DEFAULT_SETTINGS;
const planner = () => new NotifyPlanner(() => settings.notifications);

describe('fmtDuration / clip', () => {
  it('biçimler', () => {
    expect(fmtDuration(42_000)).toBe('42 sn');
    expect(fmtDuration(400_000)).toBe('6 dk 40 sn');
    expect(fmtDuration(3_900_000)).toBe('1 sa 5 dk');
    expect(fmtDuration(120_000)).toBe('2 dk');
    expect(clip('a\nb   c', 10)).toBe('a b c');
    expect(clip('x'.repeat(100), 10)).toHaveLength(10);
  });
});

describe('NotifyPlanner', () => {
  it('waiting: 1.5 sn gecikmeli karar; metin proje · araç · etiket; prompt yok', () => {
    settings = DEFAULT_SETTINGS;
    const p = planner();
    const [d] = p.onEvents([status(1, 'busy', 'waiting', T0)], snap([waitingS(1)]), T0);
    expect(d).toMatchObject({ kind: 'waiting', delayMs: 1500, title: 's1 onay bekliyor', body: 'youcms · Bash · npm run db:migrate -- --env staging', dedupeKey: `waiting:${sid(1)}` });
    expect(`${d?.title}${d?.body}`).not.toContain('gizli prompt');
    expect(p.stillValid(d!, snap([session(1, 'busy')]))).toBe(false); // 1.4 sn'de onaylandı
    expect(p.stillValid(d!, snap([waitingS(1)]))).toBe(true);
  });

  it('redactLabels: gövdede komut yok', () => {
    settings = { ...DEFAULT_SETTINGS, notifications: { ...DEFAULT_SETTINGS.notifications, redactLabels: true } };
    const [d] = planner().onEvents([status(1, 'busy', 'waiting', T0)], snap([waitingS(1)]), T0);
    expect(d?.body).toBe('youcms · Bash');
    settings = DEFAULT_SETTINGS;
  });

  it('done: tur ≥ 30 sn bildirilir (araç sayısıyla), kısa tur bildirilmez; waiting→busy aynı tur', () => {
    const p = planner();
    p.onEvents([status(1, 'idle', 'busy', T0)], snap([session(1, 'busy')]), T0);
    p.onEvents([{ type: 'tool-start', call: call('t1', sid(1), T0 + 1000) }, { type: 'tool-start', call: call('t2', sid(1), T0 + 2000) }], snap([session(1, 'busy')]), T0);
    p.onEvents([status(1, 'busy', 'waiting', T0 + 5000), status(1, 'waiting', 'busy', T0 + 8000)], snap([session(1, 'busy')]), T0);
    const out = p.onEvents([status(1, 'busy', 'idle', T0 + 400_000)], snap([session(1, 'idle')]), T0);
    expect(out).toEqual([{ kind: 'done', sessionId: sid(1), title: 's1 turu bitirdi', body: 'youcms · 6 dk 40 sn · 2 araç', dedupeKey: `done:${sid(1)}`, delayMs: 0 }]);

    p.onEvents([status(1, 'idle', 'busy', T0 + 500_000)], snap([session(1, 'busy')]), T0);
    expect(p.onEvents([status(1, 'busy', 'idle', T0 + 529_000)], snap([session(1, 'idle')]), T0)).toEqual([]);
  });

  it('ayar kapalıysa karar yok', () => {
    settings = { ...DEFAULT_SETTINGS, notifications: { ...DEFAULT_SETTINGS.notifications, waiting: false, done: false, slowTool: false } };
    const p = planner();
    expect(p.onEvents([status(1, 'busy', 'waiting', T0)], snap([waitingS(1)]), T0)).toEqual([]);
    settings = DEFAULT_SETTINGS;
  });

  it('slow: bayrak yeni set edilince bir kez; Agent çağrısı sayılmaz', () => {
    const p = planner();
    const slow = session(1, 'busy', { flags: ['slow-tool'] }, call('tu1', sid(1), T0 - 200_000));
    const first = p.onSnapshot(snap([slow]), T0);
    expect(first.decisions).toMatchObject([{ kind: 'slow', title: 's1: yavaş araç', body: 'Bash npm run db:migrate · 3 dk 20 sn', dedupeKey: 'slow:tu1' }]);
    expect(p.onSnapshot(snap([slow]), T0 + 1000).decisions).toEqual([]);
    const agent = session(2, 'busy', { flags: ['slow-tool'] }, call('tu2', sid(2), T0 - 400_000, 'Agent'));
    expect(p.onSnapshot(snap([agent]), T0).decisions).toEqual([]);
  });

  it('throttle 60 sn; iptal: waiting → busy', () => {
    const p = planner();
    const [d] = p.onEvents([status(1, 'busy', 'waiting', T0)], snap([waitingS(1)]), T0);
    p.recordShown(d!, T0);
    expect(p.isThrottled(sid(1), 'waiting', T0 + 59_000)).toBe(true);
    expect(p.isThrottled(sid(1), 'waiting', T0 + 61_000)).toBe(false);
    expect(p.onSnapshot(snap([session(1, 'busy')]), T0).cancel).toEqual([`waiting:${sid(1)}`]);
  });

  it('özet: 3\'ten fazla bekleyen → en uzun bekleyene giden tek bildirim', () => {
    const p = planner();
    const ss = [1, 2, 3, 4].map((n) => session(n, 'waiting', { waitingFor: { tool: 'Bash', label: 'x', since: T0 - n * 1000 } }));
    expect(p.summary(snap(ss.slice(0, 3)))).toBeNull();
    expect(p.summary(snap(ss))).toMatchObject({ title: '4 session onay bekliyor', sessionId: sid(4), dedupeKey: SUMMARY_KEY });
  });
});

describe('Notifier', () => {
  class FakeNotif implements NotificationLike {
    handlers: Record<string, (() => void)[]> = {};
    shown = false;
    closed = false;
    constructor(readonly o: { title: string; body: string; silent: boolean }) {}
    on(ev: 'click' | 'failed', cb: () => void) {
      (this.handlers[ev] ??= []).push(cb);
    }
    show() {
      this.shown = true;
    }
    close() {
      this.closed = true;
    }
    emit(ev: string) {
      for (const cb of this.handlers[ev] ?? []) cb();
    }
  }

  function setup(opts: { focused?: boolean } = {}) {
    let now = T0;
    let current = snap([session(1, 'busy')]);
    const evCbs: ((e: BoardEvent[]) => void)[] = [];
    const snapCbs: ((s: BoardSnapshot) => void)[] = [];
    const timers: { at: number; cb: () => void }[] = [];
    const notifs: FakeNotif[] = [];
    const sent: [string, unknown][] = [];
    const focused: string[] = [];
    const dock = { badges: [] as string[], bounces: 0, cancels: 0, setBadge: (t: string) => void dock.badges.push(t), bounce: () => ++dock.bounces, cancelBounce: () => void dock.cancels++ };
    let windowFocused = opts.focused ?? false;
    let shownWindow = 0;
    const n = new Notifier({
      engine: {
        onEvents: (cb) => (evCbs.push(cb), () => undefined),
        onSnapshot: (cb) => (snapCbs.push(cb), () => undefined),
        getSnapshot: () => current,
      },
      getSettings: () => DEFAULT_SETTINGS,
      isWindowFocused: () => windowFocused,
      showWindow: () => void shownWindow++,
      send: (ch, p) => void sent.push([ch, p]),
      focus: async (r) => {
        focused.push(r.tty ?? '');
        return { ok: true, app: 'iterm2' };
      },
      createNotification: (o) => {
        const f = new FakeNotif(o);
        notifs.push(f);
        return f;
      },
      dock,
      now: () => now,
      setTimer: (cb, ms) => {
        const t = { at: now + ms, cb };
        timers.push(t);
        return t;
      },
      clearTimer: (t) => void timers.splice(timers.indexOf(t as never), 1),
    });
    n.start();
    return {
      n, notifs, sent, focused, dock,
      get shownWindow() { return shownWindow; },
      setFocused: (f: boolean) => (windowFocused = f),
      events: (e: BoardEvent[]) => evCbs.forEach((cb) => cb(e)),
      snapshot: (s: BoardSnapshot) => {
        current = s;
        snapCbs.forEach((cb) => cb(s));
      },
      advance: (ms: number) => {
        now += ms;
        for (const t of timers.filter((x) => x.at <= now)) {
          timers.splice(timers.indexOf(t), 1);
          t.cb();
        }
      },
    };
  }

  it('waiting: 1.5 sn sonra bildirim; tıklayınca pano + session seçimi + sekme', async () => {
    const h = setup();
    h.snapshot(snap([waitingS(1)]));
    h.events([status(1, 'busy', 'waiting', T0)]);
    h.advance(1400);
    expect(h.notifs).toHaveLength(0);
    h.advance(200);
    expect(h.notifs.map((x) => x.o.title)).toEqual(['s1 onay bekliyor']);
    expect(h.notifs[0]?.o.silent).toBe(true);
    h.notifs[0]?.emit('click');
    await new Promise((r) => setTimeout(r, 0));
    expect(h.shownWindow).toBe(1);
    expect(h.sent).toContainEqual(['ui:selectSession', { sessionId: sid(1) }]);
    expect(h.focused).toEqual(['/dev/ttys001']);
  });

  it('hızlı onay (1.4 sn) → bildirim yok; onaylanınca açık bildirim kapanır', () => {
    const h = setup();
    h.snapshot(snap([waitingS(1)]));
    h.events([status(1, 'busy', 'waiting', T0)]);
    h.advance(1000);
    h.snapshot(snap([session(1, 'busy')]));
    h.advance(1000);
    expect(h.notifs).toHaveLength(0);

    h.snapshot(snap([waitingS(2)]));
    h.events([status(2, 'busy', 'waiting', T0)]);
    h.advance(1600);
    expect(h.notifs).toHaveLength(1);
    h.snapshot(snap([session(2, 'busy')]));
    expect(h.notifs[0]?.closed).toBe(true);
  });

  it('pano odaktayken bildirim yok, rozet yine güncellenir; zıplama yalnızca odak yokken', () => {
    const h = setup({ focused: true });
    h.snapshot(snap([waitingS(1)]));
    h.events([status(1, 'busy', 'waiting', T0)]);
    h.advance(2000);
    expect(h.notifs).toHaveLength(0);
    expect(h.dock.badges).toEqual(['', '1']);
    expect(h.dock.bounces).toBe(0);
    h.setFocused(false);
    h.snapshot(snap([waitingS(1), waitingS(2)]));
    h.events([status(2, 'busy', 'waiting', T0)]);
    expect(h.dock.bounces).toBe(1);
    h.n.onWindowFocus();
    expect(h.dock.cancels).toBe(1);
    h.snapshot(snap([session(1, 'idle'), session(2, 'idle')]));
    expect(h.dock.badges.at(-1)).toBe('');
  });

  it('4. bekleyen gelince tek özet bildirim', () => {
    const h = setup();
    const ws = [1, 2, 3, 4].map(waitingS);
    for (let i = 1; i <= 4; i++) {
      h.snapshot(snap(ws.slice(0, i)));
      h.events([status(i, 'busy', 'waiting', T0)]);
      h.advance(NOTIFY.waitingDelayMs);
    }
    const open = h.notifs.filter((x) => !x.closed);
    expect(open.map((x) => x.o.title)).toEqual(['4 session onay bekliyor']);
    expect(h.notifs.filter((x) => x.closed)).toHaveLength(3);
  });

  it('bildirim izni yoksa (failed) bir kez toast + ayarlar eylemi', () => {
    const h = setup();
    h.snapshot(snap([waitingS(1)]));
    h.events([status(1, 'busy', 'waiting', T0)]);
    h.advance(1600);
    h.notifs[0]?.emit('failed');
    h.notifs[0]?.emit('failed');
    const toasts = h.sent.filter(([ch]) => ch === 'app:toast');
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.[1]).toMatchObject({ action: { id: 'open-notification-settings' } });
  });

  it('createNotification null (Faz 1 bildiriyor) → yalnızca rozet', () => {
    const dock = { badge: '', setBadge: (t: string) => void (dock.badge = t), bounce: () => 1, cancelBounce: () => undefined };
    let cb: ((s: BoardSnapshot) => void) | null = null;
    const n = new Notifier({
      engine: { onEvents: () => () => undefined, onSnapshot: (c) => ((cb = c), () => undefined), getSnapshot: () => snap([]) },
      getSettings: () => DEFAULT_SETTINGS,
      isWindowFocused: () => false,
      showWindow: () => undefined,
      send: () => undefined,
      focus: async () => ({ ok: true, app: 'iterm2' }),
      createNotification: null,
      dock,
    });
    n.start();
    cb!(snap([waitingS(1), waitingS(2)]));
    expect(dock.badge).toBe('2');
    n.stop();
    expect(dock.badge).toBe('');
  });
});
