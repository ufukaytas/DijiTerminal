import { describe, expect, it } from 'vitest';
import { PROJECT_PALETTE } from '@shared/constants';
import type { AgentView } from '@shared/types';
import { agentChip, hashString, withAlpha } from '@renderer/lib/agentChip';
import { agentNowKind } from '@renderer/components/AgentNow';
import { agentRowEqual } from '@renderer/components/detail/AgentRow';
import { IDS, makeSnapshot } from './__fixtures__/snapshot';

const snap = makeSnapshot(1_800_000_000_000);
const team = snap.sessions.find((s) => s.id === IDS.team)!;
const waiting = snap.sessions.find((s) => s.id === IDS.waiting)!;
const busy = snap.sessions.find((s) => s.id === IDS.busy)!;
const idle = snap.sessions.find((s) => s.id === IDS.idle)!;
const sub = (id: string) => team.agents.find((a) => a.id === id)!;

describe('agentChip', () => {
  it('ana ajan ANA; takım adı aynı her zaman aynı renk', () => {
    expect(agentChip(team.agents[0]!).label).toBe('ANA');
    const a = agentChip(sub('a1'));
    const b = agentChip(sub('a2'));
    expect(a.label).toBe('audience');
    expect(a).toEqual(b);
    expect(PROJECT_PALETTE).toContain(a.fg);
    expect(a.bg).toBe(withAlpha(a.fg, 0.22));
    expect(hashString('audience')).toBe(hashString('audience'));
  });

  it('Explore mavi, general-purpose turuncu, diğerleri nötr', () => {
    expect(agentChip(sub('a3'))).toEqual({ label: 'Explore', bg: '#14304A', fg: '#9ED0FF' });
    const gp: AgentView = { ...sub('a1'), team: null, agentType: 'general-purpose' };
    expect(agentChip(gp).fg).toBe('#FFC79A');
    const other: AgentView = { ...sub('a1'), team: null, agentType: 'reviewer' };
    expect(agentChip(other).label).toBe('reviewer');
  });

  it('withAlpha geçersiz rengi olduğu gibi döner', () => {
    expect(withAlpha('red', 0.5)).toBe('red');
    expect(withAlpha('#FF0000', 0.5)).toBe('rgba(255, 0, 0, 0.5)');
  });
});

describe('agentNowKind öncelik sırası', () => {
  it('bitti > bekliyor > ajanları bekliyor > araç > düşünüyor', () => {
    expect(agentNowKind(sub('a3'), team)).toBe('done');
    expect(agentNowKind(waiting.agents[0]!, waiting)).toBe('waiting');
    expect(agentNowKind(team.agents[0]!, team)).toBe('waiting-agents');
    expect(agentNowKind(busy.agents[0]!, busy)).toBe('tool');
    expect(agentNowKind(idle.agents[0]!, idle)).toBe('thinking');
  });
});

describe('agentRowEqual', () => {
  it('yalnızca görünen alanlar değişince false', () => {
    const a = sub('a1');
    expect(agentRowEqual({ agent: a }, { agent: { ...a, lastTs: a.lastTs + 5 } })).toBe(true);
    expect(agentRowEqual({ agent: a }, { agent: { ...a, toolCount: a.toolCount + 1 } })).toBe(false);
    expect(agentRowEqual({ agent: a }, { agent: { ...a, current: { ...a.current!, id: 'baska' } } })).toBe(false);
    expect(agentRowEqual({ agent: a }, { agent: { ...a, current: { ...a.current!, endedAt: 5 } } })).toBe(false);
  });

  it('ana ajanda session durumu değişince yeniden çizer', () => {
    const m = waiting.agents[0]!;
    expect(agentRowEqual({ agent: m, session: waiting }, { agent: m, session: { ...waiting } })).toBe(true);
    expect(agentRowEqual({ agent: m, session: waiting }, { agent: m, session: { ...waiting, status: 'busy' } })).toBe(
      false,
    );
  });
});
