// Seçili session paneli (03/02).
import { useBoard, useSelectedSession } from '../../state/board';
import { Panel } from '../Panel';
import { AgentList } from './AgentRow';
import { Actions, BackgroundLine, ContextBar, DetailHeader, FlagChips, MetaList, ProjectLine, PromptLine, WaitingBox } from './parts';

function Skeleton() {
  return (
    <div className="skel" aria-hidden="true">
      <i style={{ width: '60%' }} />
      <i style={{ width: '40%' }} />
      <i style={{ width: '85%' }} />
      <i style={{ width: '70%' }} />
    </div>
  );
}

export function DetailPanel() {
  const session = useSelectedSession();
  const missing = useBoard((s) => s.selectedMissing);
  const booted = useBoard((s) => s.snapshot.booted);
  const project = useBoard((s) =>
    session ? (s.snapshot.projects.find((p) => p.id === session.projectId) ?? null) : null,
  );

  let body;
  if (!booted && !session) body = <Skeleton />;
  else if (!session) body = <p className="empty">Haritada bir session seçin.</p>;
  else {
    const ended = missing || session.status === 'ended';
    body = (
      <div className={missing ? 'd-body gone' : 'd-body'} key={session.id}>
        {missing && <p className="d-gone">Bu session sona erdi</p>}
        <div aria-live="polite">
          <DetailHeader
            name={session.name || session.title || session.id.slice(0, 8)}
            status={missing ? 'ended' : session.status}
          />
        </div>
        <ProjectLine project={project} worktree={session.worktree} />
        {!missing && session.background && <BackgroundLine id={session.background.id} state={session.background.state} />}
        <PromptLine prompt={session.lastPrompt} title={session.title} />
        <div aria-live="polite">{!missing && <WaitingBox session={session} />}</div>
        <FlagChips flags={session.flags} />
        <MetaList session={session} />
        <ContextBar tokens={session.ctxTokens} max={session.ctxMax} ratio={session.ctxRatio} />
        <AgentList session={session} />
        <Actions
          sessionId={session.id}
          projectId={session.projectId}
          waiting={session.status === 'waiting'}
          hasTerminal={session.terminal !== null}
          terminalApp={session.terminal?.app ?? null}
          hotkey={session.hotkey}
          ended={ended}
          background={!missing && session.background !== null}
        />
      </div>
    );
  }

  return (
    <Panel title="SEÇİLİ SESSION" aria-label="Seçili session" className="detail" bodyClassName="detail-b">
      {body}
    </Panel>
  );
}
