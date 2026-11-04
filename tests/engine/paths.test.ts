import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claudePaths, encodeCwd, subagentDirFor, transcriptPathFor } from '../../src/main/engine/paths';

describe('claudePaths', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('ayar > CLAUDE_CONFIG_DIR > ~/.claude önceliği', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/env/claude');
    expect(claudePaths({ configDir: '/ayar/claude', home: '/h' }).root).toBe('/ayar/claude');
    expect(claudePaths({ configDir: null, home: '/h' }).root).toBe('/env/claude');
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    expect(claudePaths({ home: '/h' }).root).toBe(path.join('/h', '.claude'));
  });

  it('alt yollar', () => {
    const p = claudePaths({ configDir: '/c' });
    expect(p).toEqual({
      root: '/c',
      projects: path.join('/c', 'projects'),
      sessions: path.join('/c', 'sessions'),
      settingsFile: path.join('/c', 'settings.json'),
    });
  });
});

describe('encodeCwd', () => {
  it.each([
    ['/Users/ufuk/Projects/x', '-Users-ufuk-Projects-x'],
    ['/Users/demo/My Projects/app', '-Users-demo-My-Projects-app'],
    ['/Users/demo/app.v2', '-Users-demo-app-v2'],
    ['/Users/demo/my_app', '-Users-demo-my-app'],
    ['/Users/demo/çalışma', '-Users-demo--al--ma'],
    ['/Users/demo/app/', '-Users-demo-app-'],
  ])('%s → %s', (cwd, enc) => {
    expect(encodeCwd(cwd)).toBe(enc);
  });

  it('Türkçe harfler tek tek "-" olur', () => {
    expect(encodeCwd('/şğü')).toBe('----');
  });
});

describe('transcriptPathFor / subagentDirFor', () => {
  const p = claudePaths({ configDir: '/c' });
  it('ana transcript yolu', () => {
    expect(transcriptPathFor('/Users/demo/app', 'sid-1', p)).toBe(path.join('/c/projects', '-Users-demo-app', 'sid-1.jsonl'));
  });
  it('subagent klasörü ayırıcıyla biter', () => {
    expect(subagentDirFor('/Users/demo/app', 'sid-1', p)).toBe(path.join('/c/projects', '-Users-demo-app', 'sid-1') + path.sep);
  });
});
