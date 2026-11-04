// 07/01: terminal köprüsü — IPC doğrulaması, arka plan hedefi motordan, yeni oturum, kullanılabilirlik.
import { describe, expect, it, vi } from 'vitest';
import { ClaudeCli, type CliExec, type ExecOut } from '@main/engine/claudeCli';
import type { BoardEngine } from '@main/engine/index';
import { createTerminalHost } from '@main/terminal/host';
import { parseBackgrounded, startBackground, validateTask } from '@main/terminal/newSession';
import type { PtyProcess, PtySpawn } from '@main/terminal/ptyManager';
import { DEFAULT_SETTINGS } from '@shared/settings';
import type { AppSettings, BoardSnapshot } from '@shared/types';

const SID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ok = (stdout: string): ExecOut => ({ ok: true, stdout, stderr: '', code: 0, timedOut: false });

function cliWith(exec: CliExec): ClaudeCli {
  return new ClaudeCli({
    settingsPath: () => '/opt/claude',
    exec,
    exists: () => true,
    env: { SHELL: '/bin/zsh', PATH: '/usr/bin' },
  });
}
const baseExec: CliExec = async (file, args) => {
  if (args[0] === '-l') return ok('__DIJI_PATH__/usr/bin');
  if (args[0] === '--version') return ok('2.1.312 (Claude Code)');
  if (args[0] === 'agents') return ok('  --json  Print active sessions');
  if (args[0] === '--bg')
    return ok('Starting background service…\nbackgrounded · 2cefe1b1\n  claude agents   list sessions\n');
  return { ok: false, stdout: '', stderr: '', code: 1, timedOut: false };
};

function setup(opts: { demo?: boolean; settings?: Partial<AppSettings>; exec?: CliExec; running?: boolean } = {}) {
  const running = opts.running ?? true;
  const sent: [string, unknown][] = [];
  const spawned: string[][] = [];
  const procs: PtyProcess[] = [];
  const spawn: PtySpawn = async (_f, args) => {
    spawned.push(args);
    const p: PtyProcess = {
      pid: 1,
      onData: () => ({ dispose() {} }),
      onExit: () => ({ dispose() {} }),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    };
    procs.push(p);
    return p;
  };
  const settings: AppSettings = {
    ...DEFAULT_SETTINGS,
    ...opts.settings,
    projects: { '/Users/demo/Projects/demo-app': { alias: 'demo' } },
  };
  const engine = {
    backgroundTarget: (sid: string) =>
      sid === SID ? { bgId: '0a1b2c3d', cwd: '/Users/demo/Projects/demo-app', running } : null,
    dismissBackground: vi.fn(),
    backgroundHistory: () => [
      {
        id: '1a2b3c4d',
        sessionId: OTHER,
        name: 'eski',
        title: '',
        cwd: '/tmp',
        projectId: null,
        state: 'stopped',
        reason: 'stopped',
        startedAt: 1,
        lastTs: null,
        restorable: true,
      },
    ],
    restoreBackground: vi.fn((id: string) => (id === '1a2b3c4d' ? OTHER : null)),
    refreshBackground: vi.fn(async () => undefined),
    getSnapshot: () => ({ projects: [{ root: '/Users/demo/Projects/demo-api' }] }) as unknown as BoardSnapshot,
  } as unknown as BoardEngine;
  const exec = vi.fn(opts.exec ?? baseExec);
  let t = 1000;
  const host = createTerminalHost({
    cli: cliWith(exec),
    engine: () => engine,
    settings: () => settings,
    send: (ch, p) => sent.push([ch, p]),
    demo: opts.demo ?? false,
    spawn,
    exec,
    pickDirectory: async () => '/Users/demo/elsewhere/',
    now: () => t,
  });
  return { host, sent, spawned, procs, engine, exec, advance: (ms: number) => (t += ms) };
}

describe('terminal köprüsü', () => {
  it('term:open: renderer yalnızca session kimliği gönderir; attach kimliği motordan', async () => {
    const h = setup();
    const r = await h.host.handlers['term:open'](SID, 100, 30);
    expect(r.ok && r.data).toMatchObject({ sessionId: SID, reused: false });
    expect(h.spawned).toEqual([['attach', '0a1b2c3d']]);
    const notBg = await h.host.handlers['term:open'](OTHER, 100, 30);
    expect(notBg).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('girdi doğrulama: kimlik, boyut, veri uzunluğu', async () => {
    const h = setup();
    expect((await h.host.handlers['term:open']('../x' as string, 100, 30)).ok).toBe(false);
    expect((await h.host.handlers['term:open'](SID, 5, 30)).ok).toBe(false);
    expect((await h.host.handlers['term:open'](SID, 100.5, 30)).ok).toBe(false);
    const r = await h.host.handlers['term:open'](SID, 100, 30);
    const id = r.ok ? r.data.termId : '';
    expect((await h.host.handlers['term:write'](id, 'x'.repeat(64 * 1024 + 1))).ok).toBe(false);
    expect((await h.host.handlers['term:write']('t-zz', 'x')).ok).toBe(false);
    expect((await h.host.handlers['term:write'](id, 'ls\r')).ok).toBe(true);
    expect(h.procs[0]?.write).toHaveBeenCalledWith('ls\r');
    expect((await h.host.handlers['term:resize'](id, 600, 30)).ok).toBe(false);
    expect((await h.host.handlers['term:close'](id)).ok).toBe(true);
    expect(h.procs[0]?.kill).toHaveBeenCalledWith('SIGHUP');
  });

  it('demo ya da ayardan kapalıyken açılmaz ve CLI çağrılmaz', async () => {
    const d = setup({ demo: true });
    expect((await d.host.handlers['terminal:capability']()).ok && d.host.capability().reason).toBe('demo');
    expect((await d.host.handlers['term:open'](SID, 100, 30)).ok).toBe(false);
    expect(d.exec).not.toHaveBeenCalled();
    const off = setup({ settings: { terminal: { enabled: false, claudePath: null, fontSize: 13 } } });
    expect((await off.host.handlers['term:open'](SID, 100, 30)).ok).toBe(false);
    expect(off.host.capability().reason).toBe('disabled');
    expect(off.exec).not.toHaveBeenCalled();
  });

  it('kullanılabilirlik: çözüm sonrası ok; retry yeniden çözer ve yayınlar', async () => {
    const h = setup();
    const c = await h.host.handlers['terminal:capability']();
    expect(c.ok && c.data).toMatchObject({ available: true, reason: 'ok', claudeVersion: '2.1.312' });
    await h.host.handlers['terminal:retry']();
    expect(h.sent.some(([ch]) => ch === 'terminal:capability')).toBe(true);
  });

  it("yeni oturum: yalnızca bilinen klasörde, argv'de görev; seçilen klasör 10 dk geçerli", async () => {
    const h = setup();
    const r = await h.host.handlers['session:newBackground']('/Users/demo/Projects/demo-app', 'testleri çalıştır');
    // Klasör testte yok → isDir false; beyaz liste geçti ama klasör kontrolü reddeder.
    expect(r).toMatchObject({ ok: false, error: { code: 'BAD_INPUT', message: 'Klasör bulunamadı.' } });
    expect((await h.host.handlers['session:newBackground']('/etc', null)).ok).toBe(false);
    const p = await h.host.handlers['session:pickProjectDir']();
    expect(p.ok && p.data).toBe('/Users/demo/elsewhere');
  });
});

describe('session durdurma', () => {
  it('session:stopBackground: önce uygulamanın sekmesi kapanır, sonra claude stop <id>; kimlik motordan', async () => {
    const h = setup({ exec: async (f, a) => (a[0] === 'stop' ? ok('') : baseExec(f, a, { timeoutMs: 1 })) });
    const r = await h.host.handlers['term:open'](SID, 100, 30);
    const termId = r.ok ? r.data.termId : '';
    const s = await h.host.handlers['session:stopBackground'](SID);
    expect(s).toEqual({ ok: true, data: { termId } });
    expect(h.procs[0]?.kill).toHaveBeenCalledWith('SIGHUP');
    expect(h.exec.mock.calls.some((c) => c[1][0] === 'stop' && c[1][1] === '0a1b2c3d')).toBe(true);
    expect(h.engine.refreshBackground).toHaveBeenCalled();
    expect(h.engine.dismissBackground).toHaveBeenCalledWith('0a1b2c3d');
    expect((await h.host.handlers['session:stopBackground'](OTHER)).ok).toBe(false);
    expect((await h.host.handlers['session:stopBackground']('x;rm' as string)).ok).toBe(false);
  });
  it('claude stop başarısızsa elle komut önerilir', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = setup({
      exec: async (f, a) =>
        a[0] === 'stop'
          ? { ok: false, stdout: '', stderr: '', code: 1, timedOut: false }
          : baseExec(f, a, { timeoutMs: 1 }),
    });
    const s = await h.host.handlers['session:stopBackground'](SID);
    expect(s).toMatchObject({
      ok: false,
      error: { code: 'INTERNAL', message: expect.stringContaining('claude stop 0a1b2c3d') },
    });
    warn.mockRestore();
  });
});

describe('geçmiş', () => {
  it('session:history listeyi tazeler ve döndürür; restore kimlik doğrular', async () => {
    const h = setup();
    const r = await h.host.handlers['session:history']();
    expect(h.engine.refreshBackground).toHaveBeenCalled();
    expect(r.ok && r.data.map((x) => x.id)).toEqual(['1a2b3c4d']);
    expect(await h.host.handlers['session:restoreBackground']('1A2B3C4D')).toEqual({
      ok: true,
      data: { sessionId: OTHER },
    });
    expect((await h.host.handlers['session:restoreBackground']('ffffffff')).ok).toBe(false);
    expect((await h.host.handlers['session:restoreBackground']('../x' as string)).ok).toBe(false);
    const d = setup({ demo: true });
    expect(await d.host.handlers['session:history']()).toEqual({ ok: true, data: [] });
  });
});

describe('bitmiş session kapatma', () => {
  it('işçi çalışmıyorsa (done/uyuyan) claude stop çağrılmaz, yalnızca haritadan kaldırılır', async () => {
    const h = setup({ running: false });
    const s = await h.host.handlers['session:stopBackground'](SID);
    expect(s.ok).toBe(true);
    expect(h.exec.mock.calls.some((c) => c[1][0] === 'stop')).toBe(false);
    expect(h.engine.dismissBackground).toHaveBeenCalledWith('0a1b2c3d');
  });
});

describe('newSession', () => {
  it('görev doğrulama', () => {
    expect(validateTask(null)).toEqual({ ok: true, task: null });
    expect(validateTask('  ')).toEqual({ ok: true, task: null });
    expect(validateTask('a\u0007b').ok).toBe(false);
    expect(validateTask('x'.repeat(2001)).ok).toBe(false);
    expect(validateTask('--dangerously-skip-permissions')).toEqual({
      ok: true,
      task: ' --dangerously-skip-permissions',
    });
    expect(validateTask('satır1\nsatır2')).toEqual({ ok: true, task: 'satır1\nsatır2' });
  });

  it('kimlik ayrıştırma', () => {
    expect(parseBackgrounded('Starting background service…\nbackgrounded · 2cefe1b1\n')).toBe('2cefe1b1');
    expect(parseBackgrounded('\x1b[2mbackgrounded\x1b[0m · \x1b[1m8594BF34\x1b[0m')).toBe('8594bf34');
    expect(parseBackgrounded('error')).toBeNull();
  });

  it('startBackground: argv, cwd ve izin bayrağı yok', async () => {
    const calls: [string, string[], unknown][] = [];
    const exec: CliExec = async (f, a, o) => {
      calls.push([f, a, o.cwd]);
      return ok('backgrounded · 2cefe1b1');
    };
    const cli = { path: '/opt/claude', version: '2.1.312', env: {} };
    const r = await startBackground('/p/', 'iş', { cli, exec, allowedCwd: (c) => c === '/p', isDir: () => true });
    expect(r).toEqual({ ok: true, bgId: '2cefe1b1' });
    expect(calls).toEqual([['/opt/claude', ['--bg', 'iş'], '/p']]);
    expect((await startBackground('relative', null, { cli, exec, allowedCwd: () => true, isDir: () => true })).ok).toBe(
      false,
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const none = await startBackground('/p', null, {
      cli,
      exec: async () => ok('hmm'),
      allowedCwd: () => true,
      isDir: () => true,
    });
    expect(none).toMatchObject({ ok: false, code: 'INTERNAL' });
    warn.mockRestore();
  });
});
