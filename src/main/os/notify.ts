// Bildirimler ve Dock rozeti — 04/02. Kararlar notifyRules.ts'te; burada zamanlama, gösterme,
// tıklama ve iptal. Electron nesneleri bağımlılık olarak gelir (index.ts bağlar), böylece test edilebilir.
import type { IpcEventMap } from '@shared/ipc';
import type { AppSettings, BoardEvent, BoardSnapshot, TerminalRef } from '@shared/types';
import type { BoardEngine } from '../engine/index';
import { attentionText, waitingCount } from './attention';
import { NOTIFY, NotifyPlanner, SUMMARY_KEY, type NotifyDecision } from './notifyRules';
import type { FocusResult } from './iterm';

export interface NotificationLike {
  on(ev: 'click' | 'failed', cb: (...args: unknown[]) => void): void;
  show(): void;
  close(): void;
}

export interface DockLike {
  setBadge(text: string): void;
  bounce(type: 'informational' | 'critical'): number;
  cancelBounce(id: number): void;
}

export interface NotifierDeps {
  engine: Pick<BoardEngine, 'onEvents' | 'onSnapshot' | 'getSnapshot'>;
  getSettings: () => AppSettings;
  isWindowFocused: () => boolean;
  showWindow: () => void;
  send: <K extends keyof IpcEventMap>(ch: K, p: IpcEventMap[K]) => void;
  focus: (ref: TerminalRef) => Promise<FocusResult>;
  /** null → işletim sistemi bildirimi yok (desteklenmiyor ya da Faz 1 hook'ları bildiriyor); rozet yine çalışır. */
  createNotification: ((o: { title: string; body: string; silent: boolean }) => NotificationLike) | null;
  dock: DockLike | null;
  now?: () => number;
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export class Notifier {
  private readonly planner: NotifyPlanner;
  private readonly now: () => number;
  private readonly setTimer: (cb: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;
  private active = new Map<string, { n: NotificationLike; kind: NotifyDecision['kind'] }>();
  private timers = new Set<unknown>();
  private unsubs: (() => void)[] = [];
  private badge = -1;
  private bounceId: number | null = null;
  private failedWarned = false;
  private running = false;

  constructor(private readonly deps: NotifierDeps) {
    this.planner = new NotifyPlanner(() => deps.getSettings().notifications);
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.unsubs.push(this.deps.engine.onEvents((e) => this.onEvents(e)));
    this.unsubs.push(this.deps.engine.onSnapshot((s) => this.onSnapshot(s)));
    this.updateBadge(this.deps.engine.getSnapshot());
  }

  stop(): void {
    this.running = false;
    for (const u of this.unsubs.splice(0)) u();
    for (const t of this.timers) this.clearTimer(t);
    this.timers.clear();
    for (const { n } of this.active.values()) n.close();
    this.active.clear();
    this.deps.dock?.setBadge('');
    this.badge = -1;
  }

  /** Pencere odak kazandı: zıplamayı durdur. */
  onWindowFocus(): void {
    if (this.bounceId !== null) this.deps.dock?.cancelBounce(this.bounceId);
    this.bounceId = null;
  }

  private onEvents(events: BoardEvent[]): void {
    const snap = this.deps.engine.getSnapshot();
    const decisions = this.planner.onEvents(events, snap, this.now());
    const newWaiting = events.some((e) => e.type === 'status' && e.to === 'waiting' && e.from !== 'waiting');
    if (newWaiting && !this.deps.isWindowFocused() && this.deps.dock && this.bounceId === null) {
      this.bounceId = this.deps.dock.bounce('informational');
    }
    for (const d of decisions) this.schedule(d);
  }

  private onSnapshot(snap: BoardSnapshot): void {
    this.updateBadge(snap);
    const { cancel, decisions } = this.planner.onSnapshot(snap, this.now());
    for (const key of cancel) this.close(key);
    if (this.active.has(SUMMARY_KEY) && !this.planner.summary(snap)) this.close(SUMMARY_KEY);
    for (const d of decisions) this.schedule(d);
  }

  private updateBadge(snap: BoardSnapshot): void {
    const n = waitingCount(snap);
    if (n === this.badge) return;
    this.badge = n;
    this.deps.dock?.setBadge(attentionText(n));
    if (n === 0) this.onWindowFocus();
  }

  private schedule(d: NotifyDecision): void {
    if (!this.deps.createNotification) return;
    if (d.delayMs <= 0) {
      this.fire(d);
      return;
    }
    const t = this.setTimer(() => {
      this.timers.delete(t);
      this.fire(d);
    }, d.delayMs);
    this.timers.add(t);
  }

  private fire(d: NotifyDecision): void {
    if (!this.running || !this.deps.createNotification) return;
    const snap = this.deps.engine.getSnapshot();
    const now = this.now();
    if (!this.planner.stillValid(d, snap)) return;
    if (this.deps.isWindowFocused()) return; // pano zaten önünde
    if (this.active.has(d.dedupeKey) || this.planner.isThrottled(d.sessionId, d.kind, now)) return;

    if (d.kind === 'waiting') {
      const summary = this.planner.summary(snap);
      const openWaiting = [...this.active.entries()].filter(([k, v]) => v.kind === 'waiting' && k !== SUMMARY_KEY);
      if (summary && openWaiting.length >= NOTIFY.maxConcurrent) {
        for (const [k] of openWaiting) this.close(k);
        this.close(SUMMARY_KEY);
        this.show(summary);
        this.planner.recordShown(d, now); // tek tek waiting'i de gösterilmiş say (throttle ve iptal için)
        return;
      }
      if (this.active.has(SUMMARY_KEY)) {
        // Özet zaten ekranda: güncel sayıyla yenile.
        this.close(SUMMARY_KEY);
        if (summary) {
          this.show(summary);
          this.planner.recordShown(d, now);
          return;
        }
      }
    }
    this.show(d);
    this.planner.recordShown(d, now);
  }

  private show(d: NotifyDecision): void {
    const create = this.deps.createNotification;
    if (!create) return;
    const n = create({ title: d.title, body: d.body, silent: !this.deps.getSettings().notifications.sound });
    n.on('click', () => void this.onClick(d));
    n.on('failed', () => this.onFailed());
    this.active.set(d.dedupeKey, { n, kind: d.kind });
    n.show();
  }

  private close(key: string): void {
    const a = this.active.get(key);
    if (!a) return;
    this.active.delete(key);
    a.n.close();
  }

  private async onClick(d: NotifyDecision): Promise<void> {
    this.active.delete(d.dedupeKey);
    this.deps.showWindow();
    this.deps.send('ui:selectSession', { sessionId: d.sessionId });
    const s = this.deps.engine.getSnapshot().sessions.find((x) => x.id === d.sessionId);
    // 07/01: arka plan session'ı pencerede gömülü terminalde açılır.
    if (s?.background) {
      this.deps.send('ui:openInApp', { sessionId: s.id });
      return;
    }
    if (!s?.terminal) return;
    const r = await this.deps.focus(s.terminal);
    if (!r.ok && r.reason === 'not-found') this.deps.send('app:toast', { level: 'warn', message: 'Sekme bulunamadı; session kapanmış olabilir.' });
  }

  private onFailed(): void {
    if (this.failedWarned) return;
    this.failedWarned = true;
    this.deps.send('app:toast', {
      level: 'warn',
      message: "Bildirimler kapalı — Sistem Ayarları > Bildirimler'den DijiTerminal'i açın.",
      action: { id: 'open-notification-settings', label: 'Ayarları aç' },
    });
  }
}
