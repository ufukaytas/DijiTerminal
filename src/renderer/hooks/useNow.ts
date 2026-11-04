// Paylaşılan saat (03/01): aynı aralığı isteyen tüm bileşenler tek bir setInterval'den beslenir.
import { useCallback, useSyncExternalStore } from 'react';

interface Clock {
  now: number;
  timer: ReturnType<typeof setInterval> | null;
  listeners: Set<() => void>;
}
const clocks = new Map<number, Clock>();

function clockFor(ms: number): Clock {
  let c = clocks.get(ms);
  if (!c) {
    c = { now: Date.now(), timer: null, listeners: new Set() };
    clocks.set(ms, c);
  }
  return c;
}

function subscribe(ms: number, cb: () => void): () => void {
  const c = clockFor(ms);
  c.listeners.add(cb);
  if (!c.timer) {
    c.now = Date.now();
    c.timer = setInterval(() => {
      c.now = Date.now();
      for (const l of c.listeners) l();
    }, ms);
  }
  return () => {
    c.listeners.delete(cb);
    if (c.listeners.size === 0 && c.timer) {
      clearInterval(c.timer);
      c.timer = null;
    }
  };
}

/** Şu anki zaman; `intervalMs`'de bir güncellenir. */
export function useNow(intervalMs = 1000): number {
  const sub = useCallback((cb: () => void) => subscribe(intervalMs, cb), [intervalMs]);
  const get = useCallback(() => clockFor(intervalMs).now, [intervalMs]);
  return useSyncExternalStore(sub, get);
}

/**
 * `baseMs` saatinden beslenen ama yalnızca `stepMs`'de bir değişen zaman (aşağı yuvarlanmış).
 * Ayrı bir timer açmaz; değer değişmedikçe bileşen yeniden render olmaz (03/03: 5 sn'lik Workers).
 */
export function useNowStep(stepMs: number, baseMs = 1000): number {
  const sub = useCallback((cb: () => void) => subscribe(baseMs, cb), [baseMs]);
  const get = useCallback(() => Math.floor(clockFor(baseMs).now / stepMs) * stepMs, [baseMs, stepMs]);
  return useSyncExternalStore(sub, get);
}

/** Testler için: çalışan timer sayısı (uygulama genelinde 1 olmalı). */
export function activeClockCount(): number {
  let n = 0;
  for (const c of clocks.values()) if (c.timer) n++;
  return n;
}
