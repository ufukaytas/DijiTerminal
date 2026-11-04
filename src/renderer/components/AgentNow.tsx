// Bir ajanın şu an ne yaptığını tek satırda anlatır (03/02). Workers (03/03) de kullanır.
import { memo } from 'react';
import { CATEGORY_COLOR, SLOW_COLOR, STATUS_COLOR, THRESHOLDS } from '@shared/constants';
import type { AgentView, SessionView } from '@shared/types';
import { basename } from '../lib/format';
import { Elapsed, useIsOlder } from './Elapsed';

export type AgentNowKind = 'done' | 'waiting' | 'waiting-agents' | 'tool' | 'thinking';

/** Öncelik sırası: bitti → onay bekliyor → ajanları bekliyor → araç → düşünüyor. */
export function agentNowKind(agent: AgentView, session: SessionView): AgentNowKind {
  if (agent.done) return 'done';
  if (agent.isMain && session.status === 'waiting') return 'waiting';
  if (agent.isMain && !agent.current && session.agents.some((a) => !a.isMain && a.running && !a.done))
    return 'waiting-agents';
  if (agent.current && agent.current.endedAt === undefined) return 'tool';
  return 'thinking';
}

/** Etiket için kısa hedef: dosya yolu varsa son parçası, yoksa etiketin kendisi. */
const shortLabel = (label: string, file?: string) => (file ? basename(file) : label);

export const AgentNow = memo(function AgentNow({ agent, session }: { agent: AgentView; session: SessionView }) {
  const kind = agentNowKind(agent, session);
  const cur = agent.current;
  const slow = useIsOlder(kind === 'tool' && cur ? cur.startedAt : null, THRESHOLDS.slowToolMs);

  if (kind === 'done') {
    return (
      <div className="a-now" style={{ color: STATUS_COLOR.idle }}>
        <span aria-hidden="true">✓</span>
        <span>bitti · {agent.toolCount} araç</span>
      </div>
    );
  }
  if (kind === 'waiting') {
    const w = session.waitingFor;
    return (
      <div className="a-now" style={{ color: STATUS_COLOR.waiting }}>
        <span aria-hidden="true">⏸</span>
        {w && <span className="kchip">{w.tool}</span>}
        {w && <span title={w.label}>{w.label}</span>}
        <Elapsed since={w?.since ?? session.statusSince} />
      </div>
    );
  }
  if (kind === 'waiting-agents') {
    const n = session.agents.filter((a) => !a.isMain && a.running && !a.done).length;
    return (
      <div className="a-now dim">
        <span aria-hidden="true">◌</span>
        <span>{n} ajanın dönmesini bekliyor</span>
      </div>
    );
  }
  if (kind === 'tool' && cur) {
    const color = slow ? SLOW_COLOR : CATEGORY_COLOR[cur.category];
    const label = shortLabel(cur.label, cur.file);
    return (
      <div className={slow ? 'a-now is-slow' : 'a-now'} style={{ color }} data-slow={slow || undefined}>
        <span aria-hidden="true">▶</span>
        <span className="kchip">{cur.name}</span>
        <span className="a-label" title={cur.label}>
          {label}
        </span>
        <Elapsed since={cur.startedAt} slowAfter={THRESHOLDS.slowToolMs} />
        {slow && <span>yavaş</span>}
      </div>
    );
  }
  return (
    <div className="a-now dim">
      <span>düşünüyor…</span>
    </div>
  );
});
