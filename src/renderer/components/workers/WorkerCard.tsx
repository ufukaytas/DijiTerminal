// Tek subagent kartı (03/03). AgentNow ve agentChip 03/02'den; kart snapshot'ı ayrıca okumaz.
import { memo } from 'react';
import { CATEGORY_COLOR, SLOW_COLOR, THRESHOLDS } from '@shared/constants';
import { useNowStep } from '../../hooks/useNow';
import { agentChip } from '../../lib/agentChip';
import { shellColor } from '../../lib/robotColor';
import { fmtCost, fmtDuration } from '../../lib/format';
import type { WorkerItem } from '../../state/selectors';
import { AgentNow } from '../AgentNow';
import { Elapsed, useIsOlder } from '../Elapsed';

const IDLE_EDGE = '#8A94A6';

export interface WorkerCardProps {
  item: WorkerItem;
  selected: boolean;
  onPick(item: WorkerItem): void;
}

/** Yalnızca kartta görünen alanlar değişince yeniden çiz (snapshot her seferinde yeni nesne üretir). */
export function workerCardEqual(prev: WorkerCardProps, next: WorkerCardProps): boolean {
  const a = prev.item.agent;
  const b = next.item.agent;
  return (
    prev.item.key === next.item.key &&
    prev.selected === next.selected &&
    prev.onPick === next.onPick &&
    prev.item.finished === next.item.finished &&
    prev.item.endedAt === next.item.endedAt &&
    prev.item.projectName === next.item.projectName &&
    prev.item.sessionName === next.item.sessionName &&
    a.id === b.id &&
    a.name === b.name &&
    a.model === b.model &&
    a.running === b.running &&
    a.done === b.done &&
    a.toolCount === b.toolCount &&
    a.costUsd === b.costUsd &&
    a.current?.id === b.current?.id &&
    a.current?.endedAt === b.current?.endedAt &&
    a.loopSuspect === b.loopSuspect &&
    a.background === b.background
  );
}

/** "4:00 önce" — 5 sn adımla, yalnızca bu span yeniden çizilir. */
const Ago = memo(function Ago({ ts }: { ts: number }) {
  const now = useNowStep(5000);
  return <span>{fmtDuration(now - ts)} önce</span>;
});

export const WorkerCard = memo(function WorkerCard({ item, selected, onPick }: WorkerCardProps) {
  const { agent, session } = item;
  const cur = agent.current && agent.current.endedAt === undefined ? agent.current : null;
  const slow = useIsOlder(cur ? cur.startedAt : null, THRESHOLDS.slowToolMs);
  const chip = agentChip(agent);
  const edge = item.finished ? 'var(--line2)' : cur ? (slow ? SLOW_COLOR : CATEGORY_COLOR[cur.category]) : IDLE_EDGE;
  const name = agent.name || agent.agentType || agent.id.slice(0, 8);
  const cls = ['worker', item.finished ? 'done' : null, selected ? 'sel' : null].filter(Boolean).join(' ');

  return (
    <li>
      <button
        type="button"
        className={cls}
        style={{ borderLeftColor: edge }}
        aria-current={selected ? 'true' : undefined}
        data-key={item.key}
        onClick={() => onPick(item)}
      >
        <span className="w-top">
          {/* Haritadaki robotun gövde rengi (03/08): kartı robotla eşleştirmek için. */}
          <i className="swatch" style={{ background: shellColor(agent, '#5EA0FF') }} aria-hidden="true" />
          <b title={name}>{name}</b>
          <span className="w-time">
            {item.finished ? (
              <Ago ts={item.endedAt ?? agent.lastTs} />
            ) : (
              <Elapsed since={cur?.startedAt ?? agent.firstTs} />
            )}
          </span>
        </span>
        <span className="w-meta">
          <span className="tchip" style={{ background: chip.bg, color: chip.fg }}>
            {chip.label}
          </span>
          {agent.background && <span className="tchip w-bg">bg</span>}
          {agent.loopSuspect && <span className="tchip w-loop">döngü?</span>}
          <span className="w-where" title={`${item.projectName} · ${item.sessionName}`}>
            {item.projectName ? `${item.projectName} · ` : ''}
            {item.sessionName}
          </span>
          {agent.model && <span>{agent.model}</span>}
          <span>{agent.toolCount} araç</span>
          <span>{fmtCost(agent.costUsd)}</span>
        </span>
        <AgentNow agent={agent} session={session} />
      </button>
    </li>
  );
}, workerCardEqual);
