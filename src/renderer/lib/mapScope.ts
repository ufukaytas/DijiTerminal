// Haritada (3B ve 2B liste) yalnızca yaşayan session'lar: sona eren session hemen kalkar, hiç yaşayan
// session'ı kalmayan projenin platformu/kartı da kalkar. Sona erenler snapshot'ta 30 dk daha durur
// (seçili session paneli, session.log filtreleri, Workers'ta "yeni bitti" için) — yalnızca harita gizler.
import type { BoardSnapshot, ProjectView } from '@shared/types';

export function mapScope(snap: Pick<BoardSnapshot, 'projects' | 'sessions'>): {
  projects: ProjectView[];
  sessions: BoardSnapshot['sessions'];
} {
  const sessions = snap.sessions.filter((s) => s.status !== 'ended');
  const alive = new Set(sessions.map((s) => s.id));
  const projects: ProjectView[] = [];
  for (const p of snap.projects) {
    const ids = p.sessionIds.filter((id) => alive.has(id));
    if (ids.length === 0) continue;
    projects.push(ids.length === p.sessionIds.length ? p : { ...p, sessionIds: ids });
  }
  return { projects, sessions };
}
