// Workers paneli (03/03): tüm session'lardaki subagent'lar tek listede; çalışanlar üstte,
// son 15 dakikada bitenler sönük ve altta. Karta tıklama session'ı seçer ve haritayı projeye odaklar.
import { useCallback } from 'react';
import '../../styles/workers.css';
import { useBoard } from '../../state/board';
import { useWorkers, type WorkerItem } from '../../state/selectors';
import { Panel } from '../Panel';
import { WorkerCard } from './WorkerCard';

function Skeleton() {
  return (
    <ul className="workers" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <li key={i} className="worker-skel skel">
          <i style={{ width: '55%' }} />
          <i style={{ width: '80%' }} />
          <i style={{ width: '40%' }} />
        </li>
      ))}
    </ul>
  );
}

export function WorkersPanel() {
  const booted = useBoard((s) => s.snapshot.booted);
  const selected = useBoard((s) => s.selectedSessionId);
  const { items, running, recentlyDone } = useWorkers();

  const onPick = useCallback((item: WorkerItem) => {
    const st = useBoard.getState();
    st.select(item.sessionId);
    st.setFocus(item.projectId);
  }, []);

  const meta = booted ? `${running} çalışıyor${recentlyDone ? ` · ${recentlyDone} yeni bitti` : ''}` : undefined;

  let body;
  if (!booted) body = <Skeleton />;
  else if (items.length === 0)
    body = <p className="empty">Şu an çalışan subagent yok. Bir session Agent aracını çağırınca burada görünür.</p>;
  else
    body = (
      <ul className="workers">
        {items.map((it) => (
          <WorkerCard key={it.key} item={it} selected={it.sessionId === selected} onPick={onPick} />
        ))}
      </ul>
    );

  return (
    <Panel title="WORKERS" aria-label="Workers" meta={meta} className="workers-panel">
      {body}
    </Panel>
  );
}
