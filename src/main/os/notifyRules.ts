// Bildirim kuralları — 04/02. Saf: electron importu yok, saat parametreyle gelir.
// Motorun olay ve snapshot akışından "ne zaman, hangi bildirim" kararlarını üretir.
import type { AppSettings, BoardEvent, BoardSnapshot, SessionView, ToolCall } from '@shared/types';

export type NotifyKind = 'waiting' | 'done' | 'slow';

export interface NotifyDecision {
  kind: NotifyKind;
  sessionId: string;
  title: string;
  body: string;
  /** Aktif bildirim haritasının anahtarı; aynı anahtarla ikinci bildirim gösterilmez, iptal bu anahtarla. */
  dedupeKey: string;
  delayMs: number;
}

export const NOTIFY = {
  waitingDelayMs: 1500,
  throttleMs: 60_000,
  doneMinMs: 30_000,
  maxConcurrent: 3,
  titleMax: 60,
  bodyMax: 120,
  labelMax: 80,
} as const;

export const SUMMARY_KEY = 'summary-waiting';

type NotifySettings = AppSettings['notifications'];

/** 42 sn · 6 dk 40 sn · 1 sa 5 dk */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} sn`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} dk ${s % 60} sn` : `${m} dk`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} sa ${m % 60} dk` : `${h} sa`;
}

/** Tek satır düz metin, sınırda üç nokta. */
export function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const waitingKey = (sid: string) => `waiting:${sid}`;

export class NotifyPlanner {
  private readonly getSettings: () => NotifySettings;
  private busySince = new Map<string, number>();
  private turnTools = new Map<string, number>();
  private lastShown = new Map<string, number>();
  private slowSeen = new Set<string>();
  private waitingShown = new Set<string>();

  constructor(getSettings: () => NotifySettings) {
    this.getSettings = getSettings;
  }

  onEvents(events: BoardEvent[], snap: BoardSnapshot, _now: number): NotifyDecision[] {
    const set = this.getSettings();
    const out: NotifyDecision[] = [];
    for (const e of events) {
      if (e.type === 'tool-start') {
        const sid = e.call.sessionId;
        if (this.busySince.has(sid)) this.turnTools.set(sid, (this.turnTools.get(sid) ?? 0) + 1);
        continue;
      }
      if (e.type !== 'status') continue;
      const sid = e.sessionId;
      if (e.to === 'busy' && e.from !== 'waiting') {
        // Yeni tur (waiting → busy aynı turun devamıdır).
        this.busySince.set(sid, e.at);
        this.turnTools.set(sid, 0);
      }
      const s = snap.sessions.find((x) => x.id === sid);
      if (e.to === 'waiting' && e.from !== 'waiting' && set.waiting && s) {
        out.push(this.waitingDecision(s, snap));
      }
      if (e.to === 'idle' && (e.from === 'busy' || e.from === 'waiting')) {
        const since = this.busySince.get(sid);
        const tools = this.turnTools.get(sid) ?? 0;
        this.busySince.delete(sid);
        this.turnTools.delete(sid);
        if (set.done && s && since !== undefined && e.at - since >= NOTIFY.doneMinMs) {
          out.push({
            kind: 'done',
            sessionId: sid,
            title: clip(`${s.name} turu bitirdi`, NOTIFY.titleMax),
            body: clip(`${projectName(snap, s)} · ${fmtDuration(e.at - since)} · ${tools} araç`, NOTIFY.bodyMax),
            dedupeKey: `done:${sid}`,
            delayMs: 0,
          });
        }
      }
      if (e.to === 'ended') {
        this.busySince.delete(sid);
        this.turnTools.delete(sid);
      }
    }
    return out;
  }

  /** waiting'den çıkan session'ların bildirimlerini iptal et; yeni set edilen slow-tool bayrağını bildir. */
  onSnapshot(snap: BoardSnapshot, _now: number): { cancel: string[]; decisions: NotifyDecision[] } {
    const set = this.getSettings();
    const cancel: string[] = [];
    for (const sid of [...this.waitingShown]) {
      const s = snap.sessions.find((x) => x.id === sid);
      if (!s || s.status !== 'waiting') {
        this.waitingShown.delete(sid);
        cancel.push(waitingKey(sid));
      }
    }
    const decisions: NotifyDecision[] = [];
    for (const s of snap.sessions) {
      if (!s.flags.includes('slow-tool')) continue;
      const call = slowCall(s);
      if (!call || this.slowSeen.has(call.id)) continue;
      this.slowSeen.add(call.id); // bir kez — ayar kapalı olsa da işaretle, açılınca eski çağrı bildirilmesin
      if (!set.slowTool) continue;
      const dur = fmtDuration(snap.at - call.startedAt);
      decisions.push({
        kind: 'slow',
        sessionId: s.id,
        title: clip(`${s.name}: yavaş araç`, NOTIFY.titleMax),
        body: clip(set.redactLabels ? `${call.name} · ${dur}` : `${call.name} ${clip(call.label, NOTIFY.labelMax)} · ${dur}`, NOTIFY.bodyMax),
        dedupeKey: `slow:${call.id}`,
        delayMs: 0,
      });
    }
    return { cancel, decisions };
  }

  /** Gecikme sonrası: koşul hâlâ geçerli mi? */
  stillValid(d: NotifyDecision, snap: BoardSnapshot): boolean {
    const s = snap.sessions.find((x) => x.id === d.sessionId);
    if (!s) return false;
    if (d.kind === 'waiting') return s.status === 'waiting';
    if (d.kind === 'slow') return s.flags.includes('slow-tool');
    return true;
  }

  isThrottled(sessionId: string, kind: NotifyKind, now: number): boolean {
    const t = this.lastShown.get(`${kind}:${sessionId}`);
    return t !== undefined && now - t < NOTIFY.throttleMs;
  }

  recordShown(d: NotifyDecision, now: number): void {
    this.lastShown.set(`${d.kind}:${d.sessionId}`, now);
    if (d.kind === 'waiting') this.waitingShown.add(d.sessionId);
  }

  /** 3'ten fazla waiting bildirimi: tek özet. Tıklanınca en uzun bekleyen session'a gidilir. */
  summary(snap: BoardSnapshot): (NotifyDecision & { kind: 'waiting' }) | null {
    const waiting = snap.sessions.filter((s) => s.status === 'waiting');
    if (waiting.length <= NOTIFY.maxConcurrent) return null;
    const oldest = waiting.reduce((a, b) => ((a.waitingFor?.since ?? a.statusSince) <= (b.waitingFor?.since ?? b.statusSince) ? a : b));
    return {
      kind: 'waiting',
      sessionId: oldest.id,
      title: `${waiting.length} session onay bekliyor`,
      body: clip(waiting.map((s) => s.name).join(', '), NOTIFY.bodyMax),
      dedupeKey: SUMMARY_KEY,
      delayMs: 0,
    };
  }

  private waitingDecision(s: SessionView, snap: BoardSnapshot): NotifyDecision {
    const set = this.getSettings();
    const w = s.waitingFor;
    const parts = [projectName(snap, s)];
    if (w?.tool) parts.push(w.tool);
    if (w?.label && !set.redactLabels) parts.push(clip(w.label, NOTIFY.labelMax));
    return {
      kind: 'waiting',
      sessionId: s.id,
      title: clip(`${s.name} onay bekliyor`, NOTIFY.titleMax),
      body: clip(parts.join(' · '), NOTIFY.bodyMax),
      dedupeKey: waitingKey(s.id),
      delayMs: NOTIFY.waitingDelayMs,
    };
  }
}

function projectName(snap: BoardSnapshot, s: SessionView): string {
  return snap.projects.find((p) => p.id === s.projectId)?.name ?? 'Claude Code';
}

/** Session'ın en uzun süren, bitmemiş (Agent dışı) çağrısı. */
function slowCall(s: SessionView): ToolCall | null {
  let best: ToolCall | null = null;
  for (const a of s.agents) {
    const c = a.current;
    if (!c || c.endedAt !== undefined || c.category === 'agent') continue;
    if (!best || c.startedAt < best.startedAt) best = c;
  }
  return best;
}
