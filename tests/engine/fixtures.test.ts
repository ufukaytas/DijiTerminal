// 05/01 + 02/07: her fixture senaryosu timeline'ı adım adım geçici bir CLAUDE_CONFIG_DIR'e yazılarak
// gerçek SessionEngine'den geçirilir; son snapshot manifest.expect ile karşılaştırılır.
// Saat (ManualClock), pid canlılığı, git ve ajan dosyaları enjekte edilir → deterministik, ağ/ps yok.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock } from '@main/engine/clock';
import { SessionEngine } from '@main/engine/index';
import type { BoardEvent, BoardSnapshot } from '@shared/types';
import { FIXTURES, tmpDir } from './_wait';

interface Op {
  at: number;
  op: 'write' | 'append' | 'delete';
  path: string;
  json?: unknown;
  line?: Record<string, unknown>;
}

interface Manifest {
  name: string;
  now: string;
  pidAliveOverride?: boolean;
  repoRoots?: Record<string, string>;
  teams?: Record<string, string>;
  expect: {
    sessions?: number;
    statuses?: Record<string, string>;
    superseded?: Record<string, string>;
    subagents?: number;
    totals?: Record<string, number>;
    flags?: Record<string, string[]>;
    conflicts?: number;
    conflictPaths?: string[];
    projects?: number;
    logErrors?: number;
    waitingFor?: Record<string, { tool: string; label: string }>;
    toolCalls?: number;
    maxParseMs?: number;
  };
}

const scenarios = fs
  .readdirSync(FIXTURES)
  .filter((n) => fs.existsSync(path.join(FIXTURES, n, 'manifest.json')) && fs.existsSync(path.join(FIXTURES, n, 'timeline.json')))
  .sort();

const DAY0 = Date.parse('2026-01-01T00:00:00.000Z');

function epochOf(tl: Op[]): number {
  for (const op of tl) {
    const ts = typeof op.line?.['timestamp'] === 'string' ? Date.parse(op.line['timestamp'] as string) : NaN;
    if (Number.isFinite(ts)) return ts - op.at;
    const j = op.json as Record<string, unknown> | undefined;
    if (j && typeof j['startedAt'] === 'number') return (j['startedAt'] as number) - op.at;
  }
  return 0;
}

let engines: SessionEngine[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const e of engines) await e.stop();
  engines = [];
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function run(name: string): Promise<{ snap: BoardSnapshot; engine: SessionEngine; events: BoardEvent[]; ms: number; m: Manifest }> {
  const fx = path.join(FIXTURES, name);
  const m = JSON.parse(fs.readFileSync(path.join(fx, 'manifest.json'), 'utf8')) as Manifest;
  const tl = (JSON.parse(fs.readFileSync(path.join(fx, 'timeline.json'), 'utf8')) as Op[]).sort((a, b) => a.at - b.at);
  const epoch = epochOf(tl);
  const dir = tmpDir('diji-fx-');
  dirs.push(dir);
  const clock = new ManualClock(epoch, () => DAY0);
  const repoDir = (root: string): string | null => {
    const rel = m.repoRoots?.[root];
    return rel ? path.join(fx, rel) : null;
  };
  const engine = new SessionEngine({
    configDir: dir,
    clock,
    manual: true,
    home: '/Users/demo',
    isAlive: () => m.pidAliveOverride !== false,
    processStartMs: async () => null,
    procStartToken: async () => null,
    git: async () => null,
    countAgents: async (root) => {
      const r = repoDir(root);
      try {
        return r ? fs.readdirSync(path.join(r, '.claude', 'agents')).filter((f) => f.endsWith('.md')).length : 0;
      } catch {
        return 0;
      }
    },
    agentFileExists: async (root, type) => {
      const r = repoDir(root);
      return !!r && fs.existsSync(path.join(r, '.claude', 'agents', `${type}.md`));
    },
  });
  engines.push(engine);
  const events: BoardEvent[] = [];
  engine.onEvents((e) => events.push(...e));
  await engine.start();

  const t0 = Date.now();
  const steps = [...new Set(tl.map((o) => o.at))];
  for (const at of steps) {
    clock.set(epoch + at);
    for (const op of tl.filter((o) => o.at === at)) {
      const file = path.join(dir, op.path);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (op.op === 'write') {
        fs.writeFileSync(file, JSON.stringify(op.json, null, 2));
        // Registry önbelleği mtime ile çalışır: aynı milisaniyedeki yeniden yazım kaçmasın.
        const t = new Date(epoch + at);
        fs.utimesSync(file, t, t);
      } else if (op.op === 'append') {
        fs.appendFileSync(file, JSON.stringify(op.line) + '\n');
      } else if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    }
    await engine.pumpNow();
  }
  clock.set(Date.parse(m.now));
  const snap = await engine.pumpNow();
  return { snap, engine, events, ms: Date.now() - t0, m };
}

describe('fixture senaryoları → SessionEngine → BoardSnapshot', () => {
  it('en az 9 senaryo var', () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(9);
  });

  it.each(scenarios)('%s: manifest beklentileri', async (name) => {
    const { snap, engine, m } = await run(name);
    const x = m.expect;
    const byId = new Map(snap.sessions.map((s) => [s.id, s]));

    if (x.sessions !== undefined) expect(snap.sessions.length, 'session sayısı').toBe(x.sessions);
    for (const [sid, st] of Object.entries(x.statuses ?? {})) expect(byId.get(sid)?.status, `${sid} durumu`).toBe(st);
    for (const [from, to] of Object.entries(x.superseded ?? {})) {
      expect(engine.internals.store.debugSession(from)?.supersededBy, `${from} supersede`).toBe(to);
      expect(byId.has(from), 'eski session gizli').toBe(false);
    }
    if (x.subagents !== undefined) {
      const n = snap.sessions.reduce((a, s) => a + s.agents.filter((g) => !g.isMain).length, 0);
      expect(n, 'subagent sayısı').toBe(x.subagents);
    }
    for (const [k, v] of Object.entries(x.totals ?? {})) expect((snap.totals as unknown as Record<string, number>)[k], `totals.${k}`).toBe(v);
    for (const [sid, flags] of Object.entries(x.flags ?? {})) expect(byId.get(sid)?.flags).toEqual(expect.arrayContaining(flags));
    if (x.conflicts !== undefined) expect(snap.totals.conflicts).toBe(x.conflicts);
    if (x.conflictPaths) expect(snap.projects.flatMap((p) => p.conflicts.map((c) => c.path)).sort()).toEqual([...x.conflictPaths].sort());
    if (x.projects !== undefined) expect(snap.projects.length).toBe(x.projects);
    if (x.logErrors !== undefined) expect(snap.log.filter((l) => l.state === 'err').length).toBe(x.logErrors);
    for (const [sid, w] of Object.entries(x.waitingFor ?? {})) {
      expect(byId.get(sid)?.waitingFor).toMatchObject({ tool: w.tool, label: w.label });
    }
    if (x.toolCalls !== undefined) {
      // Gizlenen (superseded) session'ların araçları da sayılır: kopyalanan geçmiş çift sayılmamalı.
      const hidden = Object.keys(x.superseded ?? {}).reduce((a, sid) => a + (engine.internals.store.debugSession(sid)?.toolCount ?? 0), 0);
      expect(snap.sessions.reduce((a, s) => a + s.toolCount, 0) + hidden, 'toplam araç').toBe(x.toolCalls);
    }
    for (const [agentId, team] of Object.entries(m.teams ?? {})) {
      const a = snap.sessions.flatMap((s) => s.agents).find((g) => g.id === agentId);
      expect(a?.team, `${agentId} takımı`).toBe(team);
    }
    // Genel değişmezler
    expect(snap.booted).toBe(true);
    for (const s of snap.sessions) {
      expect(s.agents[0]?.isMain, 'ilk ajan ana ajan').toBe(true);
      expect(s.projectId).not.toBe('');
    }
    expect(engine.internals.normalizer.unknownTypes).toEqual({});
  });

  it('olaylar booted sonrası akıyor ve tool-end her zaman bir tool-start ile eşleşiyor', async () => {
    const { events } = await run('subagents-team');
    const starts = new Set(events.filter((e) => e.type === 'tool-start').map((e) => (e.type === 'tool-start' ? e.call.id : '')));
    for (const e of events) if (e.type === 'tool-end') expect(starts.has(e.call.id)).toBe(true);
    expect(events.some((e) => e.type === 'agent-spawn')).toBe(true);
  });

  it('snapshot JSON boyutu bütçe içinde (< 200 KB)', async () => {
    const { snap } = await run('subagents-team');
    expect(JSON.stringify(snap).length).toBeLessThan(200 * 1024);
  });
});

