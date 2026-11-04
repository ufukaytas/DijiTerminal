// Ajan satırı ve katlanabilir ajan listesi (03/02).
import { memo, useEffect, useRef, useState } from 'react';
import type { AgentView, SessionView } from '@shared/types';
import { agentChip } from '../../lib/agentChip';
import { useBoard } from '../../state/board';
import { AgentNow } from '../AgentNow';

export const MAX_DONE_VISIBLE = 8;

/** Snapshot her seferinde yeni nesne üretir; yalnızca görünen alanlar değişince yeniden çiz. */
export function agentRowEqual(
  prev: { agent: AgentView; session?: SessionView; focus?: boolean },
  next: { agent: AgentView; session?: SessionView; focus?: boolean },
): boolean {
  const a = prev.agent;
  const b = next.agent;
  return (
    Boolean(prev.focus) === Boolean(next.focus) &&
    a.id === b.id &&
    a.done === b.done &&
    a.running === b.running &&
    a.toolCount === b.toolCount &&
    a.errorCount === b.errorCount &&
    a.costUsd === b.costUsd &&
    a.current?.id === b.current?.id &&
    a.current?.endedAt === b.current?.endedAt &&
    a.model === b.model &&
    a.name === b.name &&
    // AgentNow ana ajanda session durumuna ve bekleme bilgisine de bakar.
    (!a.isMain ||
      (prev.session?.status === next.session?.status &&
        prev.session?.waitingFor?.since === next.session?.waitingFor?.since &&
        prev.session?.waitingFor?.label === next.session?.waitingFor?.label &&
        runningSubs(prev.session) === runningSubs(next.session)))
  );
}

const runningSubs = (s?: SessionView) => (s ? s.agents.filter((x) => !x.isMain && x.running && !x.done).length : 0);

export const AgentRow = memo(function AgentRow({
  agent,
  session,
  focus = false,
}: {
  agent: AgentView;
  session: SessionView;
  /** Haritada bu ajanın robotuna tıklandı (03/08). */
  focus?: boolean;
}) {
  const chip = agentChip(agent);
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (focus) ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [focus]);
  const cls = [agent.done ? 'done' : null, focus ? 'focus' : null].filter(Boolean).join(' ') || undefined;
  return (
    <li ref={ref} className={cls} data-agent={agent.id} aria-current={focus ? 'true' : undefined}>
      <div className="a-top">
        <span className="tchip" style={{ background: chip.bg, color: chip.fg }}>
          {chip.label}
        </span>
        <b title={agent.name}>{agent.name}</b>
        <small>
          {agent.model} · {agent.toolCount} araç
        </small>
      </div>
      <AgentNow agent={agent} session={session} />
    </li>
  );
}, agentRowEqual);

export function AgentList({ session }: { session: SessionView }) {
  const [showDone, setShowDone] = useState(false);
  const focusAgent = useBoard((s) => (s.selectedSessionId === session.id ? s.focusAgentId : null));
  const agents = session.agents;
  const done = agents.filter((a) => a.done && !a.isMain);
  const fold = !showDone && done.length > MAX_DONE_VISIBLE;
  const hidden = fold
    ? new Set(
        done
          .slice(MAX_DONE_VISIBLE)
          .map((a) => a.id)
          .filter((id) => id !== focusAgent),
      )
    : null;
  const visible = hidden ? agents.filter((a) => !hidden.has(a.id)) : agents;

  return (
    <div className="d-agents-wrap">
      <h4 className="sec-t">Ajanlar · {agents.length}</h4>
      <ul className="d-agents">
        {visible.map((a) => (
          <AgentRow key={a.id} agent={a} session={session} focus={a.id === focusAgent} />
        ))}
        {hidden && (
          <li className="fold">
            <button type="button" className="linkish" onClick={() => setShowDone(true)}>
              +{hidden.size} bitti
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}
