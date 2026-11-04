// Snapshot → görsel değer eşlemeleri (03/05). Saf fonksiyonlar, three'siz test edilir.
import { SLOW_COLOR, STATUS_COLOR, THRESHOLDS } from '@shared/constants';
import type { AgentView, ProjectView, SessionView } from '@shared/types';
import { fmtCost, fmtDuration, fmtHotkey } from '../lib/format';

export function isSlowCall(agent: AgentView, now: number): boolean {
  return Boolean(agent.current && !agent.current.endedAt && now - agent.current.startedAt > THRESHOLDS.slowToolMs);
}

/** Session etiketinin durum noktası: durum rengi; yavaş araç bayrağı varsa kırmızı. */
export function statusDotColor(session: SessionView): string {
  if (session.status !== 'ended' && session.flags.includes('slow-tool')) return SLOW_COLOR;
  return STATUS_COLOR[session.status];
}

export const STATUS_WORD: Record<SessionView['status'], string> = {
  busy: 'çalışıyor',
  waiting: 'onay bekliyor',
  idle: 'boşta',
  ended: 'sona erdi',
};

export function displayName(s: SessionView): string {
  return s.name || s.title || s.id.slice(0, 8);
}

export interface SessionLabelText {
  name: string;
  dot: string;
  sub: string;
  tone: 'wait' | 'slow' | 'warn' | 'muted';
  aria: string;
}

/** Session etiketi: üst satır ad, alt satır bekleme / yavaş araç / durum · ctx · kısayol. */
export function sessionLabel(s: SessionView, now: number): SessionLabelText {
  const key = fmtHotkey(s.hotkey);
  const tail = key ? ` · ${key}` : '';
  const name = displayName(s);
  const aria = `${name} session'ını seç, ${STATUS_WORD[s.status]}`;
  const dot = statusDotColor(s);
  if (s.status === 'waiting') {
    const since = s.waitingFor?.since ?? s.statusSince;
    return { name, dot, sub: `onay · ${fmtDuration(now - since)}${tail}`, tone: 'wait', aria };
  }
  if (s.status !== 'ended' && s.flags.includes('slow-tool')) {
    return { name, dot, sub: `yavaş araç${tail}`, tone: 'slow', aria };
  }
  const pct = Math.round(Math.min(1, Math.max(0, s.ctxRatio)) * 100);
  const warn = s.ctxRatio >= THRESHOLDS.ctxWarnRatio;
  return { name, dot, sub: `${STATUS_WORD[s.status]} · ctx %${pct}${tail}`, tone: warn ? 'warn' : 'muted', aria };
}

export type SummaryPart = [text: string, color: string];

/** Platform zeminindeki canlı özet satırı. */
export function plateSummary(project: ProjectView, sessions: readonly SessionView[], now: number): SummaryPart[] {
  const live = sessions.filter((s) => s.status !== 'ended');
  const agents = sessions.reduce(
    (n, s) => n + s.agents.filter((a) => !a.done && (a.isMain ? s.status !== 'ended' : true)).length,
    0,
  );
  const parts: SummaryPart[] = [[`${live.length} session · ${agents} ajan · ${fmtCost(project.costUsd)}`, '#AEB8CC']];
  if (sessions.some((s) => s.status === 'waiting')) parts.push([' · bekliyor', '#F2B134']);
  if (project.conflicts.length > 0) parts.push([' · çakışma', SLOW_COLOR]);
  const slow = sessions.some(
    (s) => s.status !== 'ended' && (s.flags.includes('slow-tool') || s.agents.some((a) => isSlowCall(a, now))),
  );
  if (slow) parts.push([' · yavaş araç', SLOW_COLOR]);
  return parts;
}

/** Gösterilecek session'ları seç: en fazla `max`; öncelik bekleyen → çalışan → boşta → bitmiş, sonra mevcut sıra. */
export function pickShownSessions(ordered: readonly SessionView[], max: number): SessionView[] {
  if (ordered.length <= max) return [...ordered];
  const rank = { waiting: 0, busy: 1, idle: 2, ended: 3 } as const;
  const chosen = new Set(
    [...ordered]
      .map((s, i) => ({ s, i }))
      .sort((a, b) => rank[a.s.status] - rank[b.s.status] || a.i - b.i)
      .slice(0, max)
      .map((x) => x.s.id),
  );
  return ordered.filter((s) => chosen.has(s.id));
}
