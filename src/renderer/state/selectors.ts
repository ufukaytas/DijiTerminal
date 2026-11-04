// Türetilmiş seçiciler (03/03). Saf fonksiyonlar; bileşenler useMemo ile çağırır.
import { useMemo } from 'react';
import { THRESHOLDS } from '@shared/constants';
import type { AgentView, BoardSnapshot, SessionView } from '@shared/types';
import { useNowStep } from '../hooks/useNow';
import { displayName } from '../map3d/style';
import { useBoard } from './board';

export interface WorkerItem {
  key: string; // `${sessionId}:${agent.id}`
  sessionId: string;
  projectId: string;
  projectName: string;
  sessionName: string;
  agent: AgentView;
  session: SessionView; // AgentNow için
  /** Bitmiş ya da session'ı sona ermiş: kart sönük, bitenler grubunda. */
  finished: boolean;
  /** Bitenler için bitiş zamanı (`doneAt`, yoksa `lastTs`). */
  endedAt: number | null;
}

export interface WorkersView {
  items: WorkerItem[];
  running: number;
  recentlyDone: number;
}

/**
 * Bitiş zamanı: `doneAt` ile ajanın son kaydından erken olanı. Boşta kalma kuralıyla (arka plan ajanı)
 * ya da uygulama açılışında bitmiş sayılan ajanın `doneAt`'i tespit anıdır; gerçek bitiş son kayıttır.
 * Session sona erdiyse onun son kaydı.
 */
function endOf(a: AgentView, s: SessionView): number | null {
  if (a.done) return a.lastTs > 0 ? Math.min(a.doneAt ?? a.lastTs, a.lastTs) : a.doneAt;
  if (s.status === 'ended') return Math.min(a.lastTs || s.lastTs, s.lastTs || a.lastTs);
  return null;
}

/**
 * Tüm session'lardaki subagent'lar: ana ajanlar hariç; bitenler 15 dk görünür.
 * Sıra: çalışanlar (en yeni başlayan önce), sonra bitenler (en yeni biten önce).
 */
export function selectWorkers(s: BoardSnapshot, now: number): WorkersView {
  const projectName = new Map(s.projects.map((p) => [p.id, p.name]));
  const active: WorkerItem[] = [];
  const done: WorkerItem[] = [];
  for (const session of s.sessions) {
    for (const agent of session.agents) {
      if (agent.isMain) continue;
      const endedAt = endOf(agent, session);
      const finished = endedAt !== null;
      if (finished && now - endedAt >= THRESHOLDS.subagentVisibleMs) continue;
      const item: WorkerItem = {
        key: `${session.id}:${agent.id}`,
        sessionId: session.id,
        projectId: session.projectId,
        projectName: projectName.get(session.projectId) ?? '',
        sessionName: displayName(session),
        agent,
        session,
        finished,
        endedAt,
      };
      (finished ? done : active).push(item);
    }
  }
  active.sort((a, b) => b.agent.firstTs - a.agent.firstTs || a.key.localeCompare(b.key));
  done.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0) || a.key.localeCompare(b.key));
  return { items: [...active, ...done], running: active.length, recentlyDone: done.length };
}

/** 5 sn'de bir yeniden değerlendirilir ki bitenler zamanında listeden düşsün (paylaşılan 1 sn saati, ek timer yok). */
export function useWorkers(): WorkersView {
  const now = useNowStep(5000);
  const snapshot = useBoard((s) => s.snapshot);
  return useMemo(() => selectWorkers(snapshot, now), [snapshot, now]);
}
