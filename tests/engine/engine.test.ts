// SessionEngine orkestratörü: yayın kuralları, config dizini, restart.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveClaudePaths, SessionEngine } from '@main/engine/index';
import type { BoardEvent, BoardSnapshot } from '@shared/types';
import { copyDir, FIXTURES, tmpDir, waitFor } from './_wait';

const engines: SessionEngine[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.stop();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  delete process.env['DIJI_CLAUDE_DIR'];
});

function make(dir: string) {
  const e = new SessionEngine({
    configDir: dir,
    isAlive: () => true,
    processStartMs: async () => null,
    procStartToken: async () => null,
    git: async () => null,
  });
  engines.push(e);
  return e;
}

describe('SessionEngine', () => {
  it('config dizini: ayar > DIJI_CLAUDE_DIR > CLAUDE_CONFIG_DIR > ~/.claude', () => {
    const prev = process.env['CLAUDE_CONFIG_DIR'];
    process.env['CLAUDE_CONFIG_DIR'] = '/c/cfg';
    process.env['DIJI_CLAUDE_DIR'] = '/c/diji';
    expect(resolveClaudePaths('/c/setting').root).toBe('/c/setting');
    expect(resolveClaudePaths(null).root).toBe('/c/diji');
    delete process.env['DIJI_CLAUDE_DIR'];
    expect(resolveClaudePaths(null).root).toBe('/c/cfg');
    delete process.env['CLAUDE_CONFIG_DIR'];
    expect(resolveClaudePaths(null, '/home/u').root).toBe('/home/u/.claude');
    if (prev !== undefined) process.env['CLAUDE_CONFIG_DIR'] = prev;
  });

  it('başlangıçta hemen snapshot yayınlar; değişiklik yokken 1 sn throttle yeni yayın üretmez', async () => {
    const dir = tmpDir('diji-eng-');
    dirs.push(dir);
    const e = make(dir);
    const snaps: BoardSnapshot[] = [];
    const evs: BoardEvent[][] = [];
    e.onSnapshot((s) => snaps.push(s));
    e.onEvents((x) => evs.push(x));
    await e.start();
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.booted).toBe(true);
    await new Promise((r) => setTimeout(r, 2300));
    expect(snaps).toHaveLength(1);
    expect(evs).toHaveLength(0);
    expect(e.getSnapshot().booted).toBe(true);
  });

  it('canlı: yeni transcript satırı → olay batch\'i ve 1 sn içinde yeni snapshot', async () => {
    const dir = tmpDir('diji-eng-');
    dirs.push(dir);
    copyDir(path.join(FIXTURES, 'waiting-permission', 'claude'), dir);
    const e = make(dir);
    const snaps: BoardSnapshot[] = [];
    const evs: BoardEvent[] = [];
    e.onSnapshot((s) => snaps.push(s));
    e.onEvents((x) => evs.push(...x));
    await e.start();
    expect(evs).toHaveLength(0); // boot sırasında okunan eski olaylar yayınlanmaz
    const sid = '2372ca6c-4a3c-4976-b221-4ce4d67bde8a';
    expect(snaps[0]?.sessions.map((s) => s.id)).toContain(sid);
    const file = path.join(dir, 'projects', '-Users-demo-Projects-demo-1', `${sid}.jsonl`);
    await new Promise((r) => setTimeout(r, 500)); // watcher hazır olsun (kaçırsa da canlı dosya yedek timer'la okunur)
    const line = {
      type: 'user',
      sessionId: sid,
      uuid: '11111111-2222-4333-8444-555555555555',
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'yeni istek' },
    };
    fs.appendFileSync(file, JSON.stringify(line) + '\n');
    await waitFor(() => evs.some((x) => x.type === 'prompt'), 15_000);
    const t = Date.now();
    await waitFor(() => snaps.length > 1, 3000);
    expect(Date.now() - t).toBeLessThan(1500);
    expect(snaps.at(-1)?.log.some((l) => l.kind === 'prompt' && l.label === 'yeni istek')).toBe(true);
  }, 25_000);

  it('tempo: gizliden görünüre geçince hemen taze snapshot yayınlar; aynı tempo tekrarında yayın yok', async () => {
    const dir = tmpDir('diji-eng-');
    dirs.push(dir);
    const e = make(dir);
    const snaps: BoardSnapshot[] = [];
    e.onSnapshot((s) => snaps.push(s));
    await e.start();
    expect(snaps).toHaveLength(1);
    e.setTempo('background');
    e.setTempo('background');
    expect(snaps).toHaveLength(1);
    e.setTempo('normal');
    expect(snaps).toHaveLength(2);
    e.setTempo('normal');
    expect(snaps).toHaveLength(2);
  });

  it('restart: yeni config dizini, dinleyiciler korunur', async () => {
    const a = tmpDir('diji-eng-');
    const b = tmpDir('diji-eng-');
    dirs.push(a, b);
    copyDir(path.join(FIXTURES, 'basic-two-sessions', 'claude'), b);
    const e = make(a);
    const snaps: BoardSnapshot[] = [];
    e.onSnapshot((s) => snaps.push(s));
    await e.start();
    expect(snaps.at(-1)?.sessions).toHaveLength(0);
    await e.restart({ configDir: b });
    expect(e.internals.paths.root).toBe(b);
    expect(snaps.at(-1)?.sessions.length).toBe(2);
  });
});
