// Menü çubuğu açılır listesinin (06/01) içeriği — saf: snapshot → özet + sıralı satırlar.
import type { BoardSnapshot, ProjectView, SessionView } from '@shared/types';

export interface PopoverRow {
  session: SessionView;
  project: ProjectView | null;
}

export interface PopoverModel {
  waiting: number;
  busy: number;
  /** "2 bekliyor · 3 çalışıyor" / "Hepsi boşta" / "Açık session yok" / "Başlatılıyor…" */
  summary: string;
  rows: PopoverRow[];
}

const RANK: Record<SessionView['status'], number> = { waiting: 0, busy: 1, idle: 2, ended: 3 };

/**
 * Sıra: onay bekleyenler (en uzun süredir bekleyen üstte) → çalışanlar → boştakiler (son etkinlik üstte).
 * Sona eren session'lar listede yok: menü çubuğu "şu an ne var" sorusunu cevaplar.
 */
export function popoverModel(snap: BoardSnapshot): PopoverModel {
  const projects = new Map(snap.projects.map((p) => [p.id, p]));
  const live = snap.sessions.filter((s) => s.status !== 'ended');
  const rows = [...live]
    .sort((a, b) => {
      const r = RANK[a.status] - RANK[b.status];
      if (r !== 0) return r;
      if (a.status === 'waiting')
        return (a.waitingFor?.since ?? a.statusSince) - (b.waitingFor?.since ?? b.statusSince);
      return b.lastTs - a.lastTs;
    })
    .map((session) => ({ session, project: projects.get(session.projectId) ?? null }));
  const waiting = snap.totals.waiting;
  const busy = live.filter((s) => s.status === 'busy').length;
  let summary: string;
  if (!snap.booted) summary = 'Başlatılıyor…';
  else if (live.length === 0) summary = 'Açık session yok';
  else if (waiting === 0 && busy === 0) summary = 'Hepsi boşta';
  else
    summary = [waiting ? `${waiting} bekliyor` : null, busy ? `${busy} çalışıyor` : null].filter(Boolean).join(' · ');
  return { waiting, busy, summary, rows };
}
