import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMBLEMS, PROJECT_PALETTE } from '@shared/constants';
import { DEFAULT_SETTINGS } from '@shared/settings';
import type { AppSettings } from '@shared/types';
import { gitRevParse } from '@main/engine/git';
import { heuristicRoot, ProjectResolver, projectIdOf } from '@main/engine/projects';
import { FIXTURES, tmpDir } from './_wait';

const settingsWith = (projects: AppSettings['projects'] = {}): (() => AppSettings) => () => ({ ...DEFAULT_SETTINGS, projects });

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('ProjectResolver', () => {
  it('sezgisel: .claude/worktrees/<ad> ana köke bağlanır', () => {
    expect(heuristicRoot('/Users/demo/Projects/youcms/.claude/worktrees/seo-ui/src')).toEqual({ root: '/Users/demo/Projects/youcms', worktree: 'seo-ui' });
    expect(heuristicRoot('/Users/demo/Projects/youcms/lib')).toEqual({ root: '/Users/demo/Projects/youcms/lib', worktree: null });
  });

  it('git yokken sezgisel; id kararlı; displayPath ~ ile', async () => {
    const r = new ProjectResolver({ git: async () => null, settings: settingsWith(), home: '/Users/demo' });
    const a = await r.resolve('/Users/demo/Projects/youcms/.claude/worktrees/seo-ui');
    expect(a).toEqual({ id: projectIdOf('/Users/demo/Projects/youcms'), root: '/Users/demo/Projects/youcms', worktree: 'seo-ui', isGit: false, displayPath: '~/Projects/youcms' });
    const b = await r.resolve('/Users/demo/Projects/youcms');
    expect(b.id).toBe(a.id);
    expect(a.id).toMatch(/^[0-9a-f]{10}$/);
  });

  it('git sonucu: alt klasör, ana checkout ve worktree aynı proje; git sezgiselle çelişirse git kazanır', async () => {
    const git = async (cwd: string) => {
      if (cwd.includes('/wt/')) return { toplevel: '/r/main-wt', commonDir: '/r/main/.git' };
      return { toplevel: '/r/main', commonDir: '/r/main/.git' };
    };
    const r = new ProjectResolver({ git, settings: settingsWith(), home: '/h' });
    const sub = await r.resolve('/r/main/lib');
    const wt = await r.resolve('/r/wt/x');
    expect(sub.root).toBe('/r/main');
    expect(wt.root).toBe('/r/main');
    expect(wt.worktree).toBe('main-wt');
    expect(sub.worktree).toBeNull();
    expect(sub.id).toBe(wt.id);
    // bare / .git ile bitmeyen commonDir → kök toplevel
    const bare = new ProjectResolver({ git: async () => ({ toplevel: '/b/x', commonDir: '/b/x.git' }), settings: settingsWith() });
    expect((await bare.resolve('/b/x')).root).toBe('/b/x');
  });

  it('önbellek TTL ve uçuştaki istek birleştirme', async () => {
    let calls = 0;
    let now = 0;
    const r = new ProjectResolver({
      git: async () => {
        calls++;
        await new Promise((res) => setTimeout(res, 5));
        return null;
      },
      settings: settingsWith(),
      now: () => now,
    });
    await Promise.all([r.resolve('/a'), r.resolve('/a'), r.resolve('/a'), r.resolve('/a'), r.resolve('/a')]);
    expect(calls).toBe(1);
    now = 9 * 60_000;
    await r.resolve('/a');
    expect(calls).toBe(1);
    now = 11 * 60_000;
    await r.resolve('/a');
    expect(calls).toBe(2);
    r.invalidate('/a');
    await r.resolve('/a');
    expect(calls).toBe(3);
  });

  it('identity: çakışmasız, deterministik, ayar önceliği, palet taşması', () => {
    const roots = ['/p/a', '/p/b', '/p/c', '/p/d'];
    const r1 = new ProjectResolver({ settings: settingsWith() });
    const r2 = new ProjectResolver({ settings: settingsWith() });
    const ids1 = roots.map((x) => r1.identity(x, roots));
    const ids2 = roots.map((x) => r2.identity(x, [...roots].reverse()));
    expect(ids1).toEqual(ids2);
    expect(new Set(ids1.map((i) => i.color)).size).toBe(4);
    expect(new Set(ids1.map((i) => i.emblem)).size).toBe(4);
    expect(ids1[0]?.name).toBe('a');

    const fixed = new ProjectResolver({ settings: settingsWith({ '/p/a': { color: '#123456', emblem: 'wave', alias: 'Alfa' } }) });
    const a = fixed.identity('/p/a', roots);
    expect(a).toMatchObject({ color: '#123456', emblem: 'wave', name: 'Alfa' });
    for (const x of roots.slice(1)) expect(fixed.identity(x, roots).emblem).not.toBe('wave');

    const many = Array.from({ length: PROJECT_PALETTE.length + 1 }, (_, i) => `/q/p${i}`);
    const colors = many.map((x) => r1.identity(x, many).color);
    expect(new Set(colors).size).toBe(PROJECT_PALETTE.length);
    expect(EMBLEMS.length).toBeGreaterThan(0);
  });

  it('gizli proje', () => {
    const r = new ProjectResolver({ settings: settingsWith({ '/p/secret': { hidden: true } }) });
    expect(r.isHidden('/p/secret')).toBe(true);
    expect(r.identity('/p/secret', []).hidden).toBe(true);
    expect(r.isHidden('/p/open')).toBe(false);
  });

  it('tagOf: ≥ 3 ajan dosyası → agent takımı (fixture), 60 sn cache', async () => {
    let now = 0;
    const r = new ProjectResolver({ settings: settingsWith(), now: () => now });
    expect(await r.tagOf(path.join(FIXTURES, 'projects', 'team-repo'))).toBe('agent takımı');
    expect(await r.tagOf(path.join(FIXTURES, 'projects', 'plain-repo'))).toBeNull();
    let n = 2;
    const c = new ProjectResolver({ settings: settingsWith(), countAgents: async () => n, now: () => now });
    expect(await c.tagOf('/x')).toBeNull();
    n = 3;
    expect(await c.tagOf('/x')).toBeNull();
    now = 61_000;
    expect(await c.tagOf('/x')).toBe('agent takımı');
    expect(c.peekTag('/x')).toBe('agent takımı');
  });

  it.skipIf(!hasGit())('gerçek git: alt klasör ve worktree ana repoya bağlanır', async () => {
    const tmp = fs.realpathSync(tmpDir('diji-git-'));
    try {
      const repo = path.join(tmp, 'repo');
      fs.mkdirSync(path.join(repo, 'lib'), { recursive: true });
      const g = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } });
      g('init', '-q');
      fs.writeFileSync(path.join(repo, 'lib', 'a.txt'), 'a');
      g('add', '.');
      g('commit', '-q', '-m', 'ilk');
      g('worktree', 'add', '-q', path.join(repo, '.claude', 'worktrees', 'x'));

      expect(await gitRevParse(path.join(repo, 'lib'))).toEqual({ toplevel: repo, commonDir: path.join(repo, '.git') });
      expect(await gitRevParse(path.join(tmp, 'yok'))).toBeNull();
      expect(await gitRevParse('göreli/yol')).toBeNull();

      const r = new ProjectResolver({ settings: settingsWith(), home: tmp });
      const main = await r.resolve(path.join(repo, 'lib'));
      const wt = await r.resolve(path.join(repo, '.claude', 'worktrees', 'x'));
      expect(main).toMatchObject({ root: repo, worktree: null, isGit: true, displayPath: '~/repo' });
      expect(wt).toMatchObject({ root: repo, worktree: 'x', isGit: true });
      expect(wt.id).toBe(main.id);
      const plain = await r.resolve(tmp);
      expect(plain).toMatchObject({ root: tmp, isGit: false });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
