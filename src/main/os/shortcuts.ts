// Global kısayollar
// Electron'a doğrudan bağlı değil: globalShortcut, bip ve pencere işlemleri dışarıdan verilir (testler sahte verir).
import { isValidAccelerator, isValidPrefix, sessionAccelerator } from '@shared/accelerator';
import type { AppSettings, BoardSnapshot, SessionView, ShortcutCommand, ShortcutReport, ShortcutReportItem, TerminalRef } from '@shared/types';
import type { FocusResult } from './iterm';

/** Art arda basışta bir sonraki bekleyene geçme penceresi. */
export const CYCLE_MS = 4000;

export interface GlobalShortcutLike {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

export interface ShortcutDeps {
  globalShortcut: GlobalShortcutLike;
  getSnapshot(): BoardSnapshot;
  focusSession(ref: TerminalRef): Promise<FocusResult>;
  /** Panoda session'ı seç ('ui:selectSession'). */
  selectSession(sessionId: string): void;
  /** 07/01: arka plan session'ını pencerede gömülü terminalde aç (verilmezse yalnızca pano öne gelir). */
  openInApp?(sessionId: string): void;
  toggleWindow(): void;
  showWindow(): void;
  beep(): void;
  /** Hedef yok (bekleyen session yok / numara boş); pano görünürse toast gösterir. */
  nothingTo(message: string): void;
  now?: () => number;
}

/** Ayardan komut → accelerator tablosu. Kapalıysa boş. */
export function shortcutTable(s: AppSettings['shortcuts']): { command: ShortcutCommand; accelerator: string }[] {
  if (!s.enabled) return [];
  const rows: { command: ShortcutCommand; accelerator: string }[] = [
    { command: 'focusWaiting', accelerator: s.focusWaiting },
    { command: 'toggleBoard', accelerator: s.toggleBoard },
  ];
  for (let n = 1; n <= 9; n++) {
    rows.push({ command: `session-${n}` as ShortcutCommand, accelerator: isValidPrefix(s.sessionPrefix) ? sessionAccelerator(s.sessionPrefix, n) : '' });
  }
  return rows;
}

/**
 * "Bekleyene git" hedefi: en uzun süredir bekleyen session; bekleyen yoksa en eski yavaş araçlı (3 dk+) session.
 * Son hedef CYCLE_MS içinde tekrar basıldıysa listede bir sonraki (döngüsel).
 */
export function pickWaitingTarget(s: BoardSnapshot, last: { id: string; at: number } | null, now: number): SessionView | null {
  const byAge = (a: SessionView, b: SessionView) => a.statusSince - b.statusSince || a.id.localeCompare(b.id);
  let list = s.sessions.filter((x) => x.live && x.status === 'waiting').sort(byAge);
  if (list.length === 0) list = s.sessions.filter((x) => x.live && x.status === 'busy' && x.flags.includes('slow-tool')).sort(byAge);
  if (list.length === 0) return null;
  if (last && now - last.at < CYCLE_MS) {
    const i = list.findIndex((x) => x.id === last.id);
    if (i >= 0) return list[(i + 1) % list.length] ?? null;
  }
  return list[0] ?? null;
}

export class ShortcutManager {
  private readonly deps: ShortcutDeps;
  private readonly now: () => number;
  private registered: string[] = [];
  private current: ShortcutReport = { enabled: false, items: [] };
  private last: { id: string; at: number } | null = null;

  constructor(deps: ShortcutDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  report(): ShortcutReport {
    return { enabled: this.current.enabled, items: this.current.items.map((i) => ({ ...i })) };
  }

  /** Yalnızca bu modülün kaydettiklerini kaldırır, yeni tabloyu kaydeder. */
  apply(settings: AppSettings['shortcuts']): ShortcutReport {
    this.unregisterAll();
    const items: ShortcutReportItem[] = [];
    const seen = new Set<string>();
    for (const row of shortcutTable(settings)) {
      const item: ShortcutReportItem = { command: row.command, accelerator: row.accelerator, registered: false };
      if (!isValidAccelerator(row.accelerator)) item.reason = 'invalid';
      else if (seen.has(row.accelerator.toLowerCase())) item.reason = 'duplicate';
      else {
        seen.add(row.accelerator.toLowerCase());
        const ok = this.tryRegister(row.accelerator, row.command);
        if (ok) {
          item.registered = true;
          this.registered.push(row.accelerator);
        } else item.reason = 'conflict';
      }
      items.push(item);
    }
    this.current = { enabled: settings.enabled, items };
    return this.report();
  }

  dispose(): void {
    this.unregisterAll();
    this.current = { enabled: false, items: [] };
  }

  /** Komutu çalıştırır (kısayol geri çağrısı; testler doğrudan çağırır). */
  run(command: ShortcutCommand): void {
    if (command === 'toggleBoard') {
      this.deps.toggleWindow();
      return;
    }
    const snap = this.deps.getSnapshot();
    if (command === 'focusWaiting') {
      const now = this.now();
      const target = pickWaitingTarget(snap, this.last, now);
      if (!target) {
        this.last = null;
        this.deps.beep();
        this.deps.nothingTo('Bekleyen session yok.');
        return;
      }
      this.last = { id: target.id, at: now };
      this.goTo(target);
      return;
    }
    const n = Number(command.slice('session-'.length));
    const target = snap.sessions.find((x) => x.live && x.hotkey === n);
    if (!target) {
      this.deps.beep();
      return;
    }
    this.goTo(target);
  }

  private goTo(s: SessionView): void {
    this.deps.selectSession(s.id);
    if (s.background && this.deps.openInApp) {
      this.deps.openInApp(s.id);
      return;
    }
    const ref = s.terminal;
    if (!ref || !ref.tty) {
      this.deps.showWindow();
      return;
    }
    void this.deps.focusSession(ref).then(
      (r) => {
        if (!r.ok) this.deps.showWindow();
      },
      () => this.deps.showWindow(),
    );
  }

  private tryRegister(accelerator: string, command: ShortcutCommand): boolean {
    try {
      return this.deps.globalShortcut.register(accelerator, () => this.run(command));
    } catch {
      return false; // Electron geçersiz accelerator'da exception atar
    }
  }

  private unregisterAll(): void {
    for (const acc of this.registered.splice(0)) {
      try {
        this.deps.globalShortcut.unregister(acc);
      } catch {
        /* zaten kaldırılmış */
      }
    }
  }
}

/** Kayıt raporundaki çakışmalar için kullanıcı metni; çakışma yoksa null. */
export function conflictMessage(r: ShortcutReport, format: (acc: string) => string): string | null {
  const bad = r.items.filter((i) => !i.registered && i.reason === 'conflict');
  if (bad.length === 0) return null;
  const keys = bad.map((i) => format(i.accelerator));
  const list = keys.length > 3 ? `${keys.slice(0, 3).join(', ')} ve ${keys.length - 3} diğer` : keys.join(', ');
  return `${list} kısayolu başka bir uygulama tarafından kullanılıyor. Ayarlardan değiştirin.`;
}
