import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { FixtureBuilder } from '../../scripts/lib/fixture-builder.mjs';
import { listFixtures, replay } from '../../scripts/lib/replay-core.mjs';
import { SCENARIOS } from '../../scripts/lib/scenarios.mjs';
import { readTree, REPO_ROOT, tmpDir } from './_tmp';

const START = Date.parse('2026-10-28T12:00:00.000Z');

/** Küçük senaryo: iki session, biri çıkar. */
function small(dir: string): string {
  const b = new FixtureBuilder({ name: 'small', description: 'replay testi', now: '2026-01-01T09:00:00.000Z' });
  const a = b.session({ pid: 50001, cwd: '/Users/demo/Projects/demo-1', name: 'a', status: 'busy' });
  const c = b.session({ pid: 50002, cwd: '/Users/demo/Projects/demo-2', name: 'c', status: 'busy' });
  b.at(1000);
  a.user('merhaba');
  b.advance(500);
  c.user('selam');
  b.advance(2000);
  a.assistant({ text: 'tamam' });
  c.assistant({ text: 'olur' });
  b.advance(1000);
  a.registry({ status: 'idle' });
  b.advance(1000);
  c.exit();
  b.expect({ sessions: 1 });
  const out = path.join(dir, 'small');
  b.build(out, { force: true });
  return out;
}

const noTime = (text: string): string => text.replace(/"timestamp":"[^"]+"/g, '"timestamp":"T"').replace(/"(startedAt|updatedAt|statusUpdatedAt)": \d+/g, '"$1": 0');

describe('replay', () => {
  it('20 kez oynatma: sıra ve son durum her seferinde aynı, fixture claude/ ile eşdeğer', async () => {
    const fx = small(tmpDir());
    const expected = readTree(path.join(fx, 'claude'));
    let first: Map<string, string> | null = null;
    for (let i = 0; i < 20; i++) {
      const target = tmpDir('diji-replay-');
      const order: number[] = [];
      const r = await replay({ fixtureDir: fx, targetDir: target, speed: 0, startMs: START, onOp: (_op, idx) => order.push(idx) });
      expect(order).toEqual([...order.keys()]);
      const tree = readTree(target);
      if (!first) first = tree;
      expect(tree).toEqual(first);
      expect(r.applied).toBe(order.length);
      // pid eşlemesi verilmediğinde yollar fixture ile aynı; zamanlar dışında içerik eşdeğer
      expect([...tree.keys()].sort()).toEqual([...expected.keys()].sort());
      for (const [p, text] of tree) expect(noTime(text), p).toBe(noTime(expected.get(p) ?? ''));
    }
  });

  it('zaman damgaları "şimdi"ye kayar ve hızla sıkışır; pid ve registry dosya adı eşlenir', async () => {
    const fx = small(tmpDir());
    const target = tmpDir('diji-replay-');
    const waits: number[] = [];
    const { pids } = await replay({
      fixtureDir: fx, targetDir: target, speed: 4, startMs: START,
      sleep: async (ms) => { waits.push(ms); },
      allocPid: (p) => p + 1000,
    });
    expect(waits).toEqual([250, 125, 500, 250, 250]);
    expect([...pids]).toEqual([[50001, 51001], [50002, 51002]]);
    const tree = readTree(target);
    expect([...tree.keys()].filter((p) => p.startsWith('sessions/'))).toEqual(['sessions/51001.json']);
    const reg = JSON.parse(tree.get('sessions/51001.json') ?? '{}');
    expect(reg.pid).toBe(51001);
    expect(reg.status).toBe('idle');
    expect(reg.startedAt).toBe(START);
    const lines = [...tree].filter(([p]) => p.endsWith('.jsonl')).flatMap(([, t]) => t.trim().split('\n').map((l) => JSON.parse(l)));
    const ts = lines.map((l) => Date.parse(l.timestamp)).filter(Number.isFinite);
    expect(Math.min(...ts)).toBe(START + 1000 / 4);
    expect(Math.max(...ts)).toBeLessThanOrEqual(START + 5500 / 4);
  });

  it('abort sinyali oynatmayı durdurur', async () => {
    const fx = small(tmpDir());
    const ac = new AbortController();
    const r = await replay({ fixtureDir: fx, targetDir: tmpDir(), speed: 1, startMs: START, signal: ac.signal, sleep: async () => { ac.abort(); } });
    expect(r.applied).toBe(2); // t=0'daki iki registry yazımı, ilk beklemede durur
  });

  it('gerçek senaryolar hatasız oynatılır', async () => {
    const d = tmpDir();
    for (const [name, make] of Object.entries(SCENARIOS)) make().build(path.join(d, name), { force: true });
    expect(listFixtures(d)).toEqual(Object.keys(SCENARIOS).sort());
    for (const name of listFixtures(d)) {
      const r = await replay({ fixtureDir: path.join(d, name), targetDir: tmpDir(), speed: 0 });
      expect(r.applied, name).toBeGreaterThan(0);
    }
  });

  it('CLI: bilinmeyen fixture → mevcut adlar listelenir, çıkış 1', () => {
    let code = 0;
    let stderr = '';
    try {
      execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts/replay.mjs'), 'yok-boyle-bir-sey'], { stdio: 'pipe', encoding: 'utf8' });
    } catch (e) {
      const err = e as { status: number; stderr: string };
      code = err.status;
      stderr = err.stderr;
    }
    expect(code).toBe(1);
    expect(stderr).toMatch(/Fixture bulunamadı/);
    expect(stderr).toMatch(/Mevcut:/);
  });

  it('CLI --once --dir: oynatır, hedefi 0700 açar ve çıkar', () => {
    const target = path.join(tmpDir(), 'cfg');
    execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts/replay.mjs'), 'basic-two-sessions', '--speed', '0', '--once', '--dir', target], { stdio: 'pipe', timeout: 15_000 });
    const tree = readTree(target);
    expect([...tree.keys()].some((p) => p.startsWith('sessions/'))).toBe(true);
    expect([...tree.keys()].some((p) => p.endsWith('.jsonl'))).toBe(true);
  });
});
