// Kullanım limiti gösterimi (02/08 → 03/01 üst bar). Saf fonksiyonlar.
import type { LimitWindow, UsageLimits } from '@shared/types';

export const LIMIT_WARN_PCT = 85;
export const LIMIT_CRIT_PCT = 95;
export const LIMIT_STALE_MS = 6 * 3_600_000;

const pad = (n: number) => String(n).padStart(2, '0');
const DAYS = ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'];

export type LimitLevel = 'ok' | 'warn' | 'crit';

export interface LimitItem {
  key: 'fiveHour' | 'week';
  label: string; // '5s' | 'hafta'
  pct: number; // gösterilen tam sayı yüzde
  level: LimitLevel;
  /** Pencere bitti ama yeni status line gelmedi. */
  reset: boolean;
  /** `14:30` (24 saat içinde) ya da `Cum 09:00`; bilinmiyorsa null. */
  resetsLabel: string | null;
  title: string;
}

export interface LimitsView {
  items: LimitItem[];
  stale: boolean;
  /** "Son güncelleme 3 sa önce" gibi. */
  updatedLabel: string;
}

export function fmtResets(resetsAt: number, now: number): string | null {
  if (!resetsAt) return null;
  const d = new Date(resetsAt);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return resetsAt - now < 24 * 3_600_000 ? hm : `${DAYS[d.getDay()]} ${hm}`;
}

export function fmtAgo(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 1) return 'az önce';
  if (m < 60) return `${m} dk önce`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} sa önce`;
  return `${Math.round(h / 24)} gün önce`;
}

function item(key: LimitItem['key'], w: LimitWindow, now: number): LimitItem {
  const label = key === 'fiveHour' ? '5s' : 'hafta';
  const reset = w.resetsAt > 0 && w.resetsAt <= now;
  const pct = reset ? 0 : Math.round(w.pct);
  const level: LimitLevel = reset ? 'ok' : w.pct >= LIMIT_CRIT_PCT ? 'crit' : w.pct >= LIMIT_WARN_PCT ? 'warn' : 'ok';
  const resetsLabel = reset ? null : fmtResets(w.resetsAt, now);
  const name = key === 'fiveHour' ? '5 saatlik limit' : 'Haftalık limit';
  const title = reset ? `${name}: pencere sıfırlandı` : `${name}: %${pct} kullanıldı${resetsLabel ? ` · sıfırlanma ${resetsLabel}` : ''}`;
  return { key, label, pct, level, reset, resetsLabel, title };
}

/** null → üst barda hiçbir şey gösterilmez. */
export function limitsView(l: UsageLimits | null, now: number): LimitsView | null {
  if (!l) return null;
  const items: LimitItem[] = [];
  if (l.fiveHour) items.push(item('fiveHour', l.fiveHour, now));
  if (l.week) items.push(item('week', l.week, now));
  if (items.length === 0) return null;
  return { items, stale: now - l.at > LIMIT_STALE_MS, updatedLabel: `Son güncelleme ${fmtAgo(now - l.at)}` };
}
