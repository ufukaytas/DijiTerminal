// 07/01: claude CLI çözücü — yol önceliği, login shell çıktısı, sürüm ve agents --json desteği, ortam temizliği.
import { describe, expect, it } from 'vitest';
import {
  ClaudeCli,
  cliEnv,
  knownLocations,
  parseLoginOutput,
  type CliExec,
  type ExecOut,
} from '@main/engine/claudeCli';

const ok = (stdout: string): ExecOut => ({ ok: true, stdout, stderr: '', code: 0, timedOut: false });
const bad: ExecOut = { ok: false, stdout: '', stderr: 'x', code: 1, timedOut: false };

const HELP_JSON = '  --json   Print active sessions (interactive and background) as a JSON array and exit';

function fakeExec(map: Record<string, ExecOut>, calls: [string, string[]][] = []): CliExec {
  return async (file, args) => {
    calls.push([file, args]);
    if (args[0] === '-l') return map['login'] ?? ok('');
    return map[`${file} ${args.join(' ')}`] ?? bad;
  };
}

describe('parseLoginOutput', () => {
  it('tema/uyarı satırları arasından işaretli değerleri alır', () => {
    const out =
      'Last login: …\n\x1b[1m prompt \x1b[0m\n__DIJI_CLAUDE__/Users/u/.local/bin/claude\n__DIJI_PATH__/Users/u/.local/bin:/usr/bin\n';
    expect(parseLoginOutput(out)).toEqual({
      claude: '/Users/u/.local/bin/claude',
      pathVar: '/Users/u/.local/bin:/usr/bin',
    });
    expect(parseLoginOutput('__DIJI_CLAUDE__\n__DIJI_PATH__/usr/bin')).toEqual({ claude: null, pathVar: '/usr/bin' });
    expect(parseLoginOutput('__DIJI_CLAUDE__claude: aliased to x')).toEqual({ claude: null, pathVar: null });
  });
});

describe('cliEnv', () => {
  it('Electron/Node/iç içe Claude değişkenlerini atar, PATH ve CLAUDE_CONFIG_DIR verir, UTF-8 ve renk ekler', () => {
    const env = cliEnv(
      {
        HOME: '/Users/u',
        PATH: '/usr/bin',
        ELECTRON_RUN_AS_NODE: '1',
        NODE_OPTIONS: '--inspect',
        CLAUDECODE: '1',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        DIJI_DEMO: '1',
        CLAUDE_CONFIG_DIR: '/old',
        LANG: 'C',
      },
      '/Users/u/.local/bin:/usr/bin',
      '/cfg',
    );
    expect(env).toEqual({
      HOME: '/Users/u',
      PATH: '/Users/u/.local/bin:/usr/bin',
      CLAUDE_CONFIG_DIR: '/cfg',
      LANG: 'en_US.UTF-8',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    });
    expect(cliEnv({ LANG: 'tr_TR.UTF-8', CLAUDE_CONFIG_DIR: '/keep' }, null, null)).toMatchObject({
      LANG: 'tr_TR.UTF-8',
      CLAUDE_CONFIG_DIR: '/keep',
    });
  });
});

describe('ClaudeCli.resolve', () => {
  const base = { env: { SHELL: '/bin/zsh', HOME: '/Users/u', PATH: '/usr/bin' }, homedir: '/Users/u' };

  it('login shell yolu → sürüm ve agents --json desteği; sonuç önbelleğe alınır', async () => {
    const calls: [string, string[]][] = [];
    const exec = fakeExec(
      {
        login: ok('__DIJI_CLAUDE__/Users/u/.local/bin/claude\n__DIJI_PATH__/Users/u/.local/bin:/usr/bin\n'),
        '/Users/u/.local/bin/claude --version': ok('2.1.312 (Claude Code)\n'),
        '/Users/u/.local/bin/claude agents --help': ok(HELP_JSON),
      },
      calls,
    );
    const cli = new ClaudeCli({ ...base, settingsPath: () => null, exec, exists: () => true });
    const r = await cli.resolve();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cli.path).toBe('/Users/u/.local/bin/claude');
    expect(r.cli.version).toBe('2.1.312');
    expect(r.cli.env['PATH']).toBe('/Users/u/.local/bin:/usr/bin');
    expect(calls[0]).toEqual(['/bin/zsh', ['-l', '-i', '-c', expect.stringContaining('command -v claude')]]);
    await cli.resolve();
    expect(calls).toHaveLength(3);
    expect(cli.capability(true)).toMatchObject({ available: true, reason: 'ok', claudeVersion: '2.1.312' });
    expect(cli.capability(false)).toMatchObject({ available: false, reason: 'disabled' });
    cli.invalidate();
    expect(cli.capability(true).reason).toBe('pending');
  });

  it('ayardaki yol öncelikli; yoksa not-found', async () => {
    const exec = fakeExec({ '/custom/claude --version': ok('2.1.312'), '/custom/claude agents --help': ok(HELP_JSON) });
    const cli = new ClaudeCli({
      ...base,
      settingsPath: () => '/custom/claude',
      exec,
      exists: (p) => p === '/custom/claude',
    });
    expect((await cli.resolve()).ok).toBe(true);
    const missing = new ClaudeCli({ ...base, settingsPath: () => '/nope/claude', exec, exists: () => false });
    expect(await missing.resolve()).toMatchObject({ ok: false, reason: 'not-found', path: '/nope/claude' });
  });

  it('login shell bulamazsa bilinen yerlere bakar; hiçbiri yoksa not-found', async () => {
    const loc = knownLocations('/Users/u')[2] ?? '';
    const exec = fakeExec({ [`${loc} --version`]: ok('2.1.312'), [`${loc} agents --help`]: ok(HELP_JSON) });
    const cli = new ClaudeCli({ ...base, settingsPath: () => null, exec, exists: (p) => p === loc });
    const r = await cli.resolve();
    expect(r.ok && r.cli.path).toBe('/opt/homebrew/bin/claude');
    const none = new ClaudeCli({ ...base, settingsPath: () => null, exec, exists: () => false });
    expect(await none.resolve()).toMatchObject({ ok: false, reason: 'not-found' });
  });

  it('agents --json desteklemeyen sürüm → unsupported', async () => {
    const exec = fakeExec({
      login: ok('__DIJI_CLAUDE__/x/claude'),
      '/x/claude --version': ok('1.0.0 (Claude Code)'),
      '/x/claude agents --help': ok('Usage: claude agents'),
    });
    const cli = new ClaudeCli({ ...base, settingsPath: () => null, exec, exists: () => true });
    expect(await cli.resolve()).toMatchObject({ ok: false, reason: 'unsupported', version: '1.0.0' });
    expect(cli.capability(true)).toMatchObject({ available: false, reason: 'unsupported', claudeVersion: '1.0.0' });
  });
});
