// selectWorkers (03/03): ana ajan hariç, 15 dk sınırı, sıralama, aynı agentId farklı session.
import { describe, expect, it } from 'vitest';
import { THRESHOLDS } from '@shared/constants';
import type { AgentView, BoardSnapshot } from '@shared/types';
import { selectWorkers } from '@renderer/state/selectors';
import { IDS, makeSnapshot } from './__fixtures__/snapshot';

const NOW = 1_800_000_000_000;

const sub = (sessionId: string, id: string, o: Partial<AgentView> = {}): AgentView => ({
  id,
  sessionId,
  isMain: false,
  name: id,
  agentType: 'general-purpose',
  team: null,
  model: 'sonnet',
  background: false,
  running: true,
  done: false,
  current: null,
  toolCount: 0,
  errorCount: 0,
  costUsd: 0,
  firstTs: NOW - 60_000,
  lastTs: NOW - 1_000,
  doneAt: null,
  loopSuspect: false,
  ...o,
});

function withAgents(snap: BoardSnapshot, sessionId: string, extra: AgentView[]): BoardSnapshot {
  return {
    ...snap,
    sessions: snap.sessions.map((s) => (s.id === sessionId ? { ...s, agents: [...s.agents, ...extra] } : s)),
  };
}

describe('selectWorkers', () => {
  it('ana ajanları çıkarır; proje ve session adlarını ekler', () => {
    const v = selectWorkers(makeSnapshot(NOW), NOW);
    expect(v.items.every((i) => !i.agent.isMain)).toBe(true);
    expect(v.items.map((i) => i.agent.id)).toEqual(expect.arrayContaining(['a1', 'a2', 'a3']));
    const a1 = v.items.find((i) => i.agent.id === 'a1')!;
    expect(a1.projectName).toBe('agent-lab');
    expect(a1.sessionName).toBe('pazar araştırması');
    expect(a1.key).toBe(`${IDS.team}:a1`);
  });

  it('çalışanlar üstte (en yeni başlayan önce), bitenler altta (en yeni biten önce); sayaçlar', () => {
    let s = makeSnapshot(NOW);
    s = withAgents(s, IDS.busy, [
      sub(IDS.busy, 'new', { firstTs: NOW - 5_000 }),
      sub(IDS.busy, 'old', { firstTs: NOW - 900_000 }),
      sub(IDS.busy, 'd1', { done: true, running: false, doneAt: NOW - 10_000 }),
    ]);
    const v = selectWorkers(s, NOW);
    const ids = v.items.map((i) => i.agent.id);
    expect(ids.indexOf('new')).toBeLessThan(ids.indexOf('old'));
    expect(ids.indexOf('d1')).toBeLessThan(ids.indexOf('a3')); // a3 5 dk önce bitti
    const firstDone = v.items.findIndex((i) => i.finished);
    expect(v.items.slice(firstDone).every((i) => i.finished)).toBe(true);
    expect(v.running).toBe(v.items.filter((i) => !i.finished).length);
    expect(v.recentlyDone).toBe(2);
  });

  it('15 dakikadan önce bitenler düşer; doneAt yoksa lastTs kullanılır', () => {
    let s = makeSnapshot(NOW);
    s = withAgents(s, IDS.busy, [
      sub(IDS.busy, 'gone', { done: true, running: false, doneAt: NOW - THRESHOLDS.subagentVisibleMs }),
      sub(IDS.busy, 'nodone', { done: true, running: false, doneAt: null, lastTs: NOW - 60_000 }),
      sub(IDS.busy, 'nodone-old', {
        done: true,
        running: false,
        doneAt: null,
        lastTs: NOW - THRESHOLDS.subagentVisibleMs - 1,
      }),
    ]);
    const ids = selectWorkers(s, NOW).items.map((i) => i.agent.id);
    expect(ids).not.toContain('gone');
    expect(ids).not.toContain('nodone-old');
    expect(ids).toContain('nodone');
    expect(selectWorkers(s, NOW).items.find((i) => i.agent.id === 'nodone')!.endedAt).toBe(NOW - 60_000);
  });

  it('doneAt tespit anıysa (açılışta / boşta kalma kuralı) bitiş son kayıttır', () => {
    const s = withAgents(makeSnapshot(NOW), IDS.busy, [
      sub(IDS.busy, 'bg-old', {
        done: true,
        running: false,
        background: true,
        doneAt: NOW - 2_000,
        lastTs: NOW - THRESHOLDS.subagentVisibleMs - 60_000,
      }),
      sub(IDS.busy, 'bg-new', {
        done: true,
        running: false,
        background: true,
        doneAt: NOW - 2_000,
        lastTs: NOW - 300_000,
      }),
    ]);
    const items = selectWorkers(s, NOW).items;
    expect(items.find((i) => i.agent.id === 'bg-old')).toBeUndefined();
    expect(items.find((i) => i.agent.id === 'bg-new')!.endedAt).toBe(NOW - 300_000);
  });

  it("aynı agentId iki session'da ayrı kart", () => {
    let s = makeSnapshot(NOW);
    s = withAgents(s, IDS.busy, [sub(IDS.busy, 'x1')]);
    s = withAgents(s, IDS.waiting, [sub(IDS.waiting, 'x1')]);
    const keys = selectWorkers(s, NOW)
      .items.filter((i) => i.agent.id === 'x1')
      .map((i) => i.key);
    expect(keys).toEqual(expect.arrayContaining([`${IDS.busy}:x1`, `${IDS.waiting}:x1`]));
    expect(new Set(keys).size).toBe(2);
  });

  it("session'ı sona eren çalışan subagent bitmiş sayılır (sönük, altta)", () => {
    const s = withAgents(makeSnapshot(NOW), IDS.ended, [sub(IDS.ended, 'orphan', { lastTs: NOW - 30_000 })]);
    const it = selectWorkers(s, NOW).items.find((i) => i.agent.id === 'orphan');
    expect(it?.finished).toBe(true);
  });

  it('40 ajanlık liste hızlı hesaplanır', () => {
    let s = makeSnapshot(NOW);
    s = withAgents(
      s,
      IDS.busy,
      Array.from({ length: 40 }, (_, i) => sub(IDS.busy, `t${i}`, { firstTs: NOW - i * 1000 })),
    );
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) selectWorkers(s, NOW);
    expect((performance.now() - t0) / 100).toBeLessThan(8);
  });
});
