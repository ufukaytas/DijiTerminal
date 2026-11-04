import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { ManualClock } from '@main/engine/clock';
import { DemoEngine } from '@main/engine/demo';
import type { BoardEvent, BoardSnapshot } from '@shared/types';

async function simulate(seconds: number, seed = 7) {
  const clock = new ManualClock(Date.parse('2026-01-01T10:00:00Z'), () => Date.parse('2026-01-01T00:00:00Z'));
  const e = new DemoEngine({ clock, seed, manual: true });
  const events: BoardEvent[] = [];
  const snaps: BoardSnapshot[] = [];
  e.onEvents((x) => events.push(...x));
  e.onSnapshot((s) => snaps.push(s));
  await e.start();
  const statuses = new Set<string>();
  const teams = new Set<string>();
  for (let i = 0; i < seconds * 2; i++) {
    clock.advance(500);
    await e.step();
    const snap = e.getSnapshot();
    for (const x of snap.sessions) {
      statuses.add(x.status);
      for (const a of x.agents) if (a.team) teams.add(a.team);
    }
  }
  return { e, events, snaps, statuses, teams };
}

describe('DemoEngine', () => {
  it('dosya okumadan 4 proje, 5 session ve canlı olay akışı üretir', async () => {
    const read = vi.spyOn(fs, 'readFileSync');
    const readP = vi.spyOn(fs.promises, 'readFile');
    const { e, events, snaps, statuses, teams } = await simulate(240);
    const snap = e.getSnapshot();
    expect(snaps[0]?.booted).toBe(true);
    expect(snap.projects.map((p) => p.name).sort()).toEqual(['livekit-demo', 'ufukaytas', 'youcms', 'youcontent360']);
    expect(snap.sessions).toHaveLength(5);
    const types = new Set(events.map((x) => x.type));
    for (const t of ['tool-start', 'tool-end', 'status', 'prompt', 'agent-spawn', 'agent-done', 'file-touch']) expect(types.has(t as BoardEvent['type']), t).toBe(true);
    expect(statuses.has('waiting')).toBe(true);
    expect(statuses.has('idle')).toBe(true);
    expect([...teams].length).toBeGreaterThan(0);
    const team = snap.projects.find((p) => p.name === 'ufukaytas');
    expect(team).toMatchObject({ emblem: 'team', color: '#F0A6CA', tag: 'agent takımı' });
    expect(snap.totals.costTodayUsd).toBeGreaterThan(0);
    expect(read).not.toHaveBeenCalled();
    expect(readP).not.toHaveBeenCalled();
    read.mockRestore();
    readP.mockRestore();
    e.stop();
  });

  it('aynı tohum → aynı akış (deterministik)', async () => {
    const a = await simulate(30, 3);
    const b = await simulate(30, 3);
    expect(a.events.map((x) => x.type)).toEqual(b.events.map((x) => x.type));
  });
});
