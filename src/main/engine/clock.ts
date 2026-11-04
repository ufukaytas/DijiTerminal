// Enjekte edilebilir saat — 02/07. Testlerde gün dönümü ve 20 sn / 90 sn kuralları deterministik olsun diye.

export interface Clock {
  now(): number;
  /** ts'nin (varsayılan: şimdi) yerel gün başlangıcı (ms). */
  dayStart(ts?: number): number;
}

/** Yerel saate göre gün başı. Saat dilimi değişirse bir sonraki çağrıda yeni değer döner. */
export function localDayStart(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export const systemClock: Clock = {
  now: () => Date.now(),
  dayStart: (ts?: number) => localDayStart(ts ?? Date.now()),
};

/** Testler için elle ilerletilen saat. */
export class ManualClock implements Clock {
  t: number;
  private readonly dayFn: (ts: number) => number;
  constructor(start: number, dayFn: (ts: number) => number = localDayStart) {
    this.t = start;
    this.dayFn = dayFn;
  }
  now(): number {
    return this.t;
  }
  dayStart(ts?: number): number {
    return this.dayFn(ts ?? this.t);
  }
  advance(ms: number): void {
    this.t += ms;
  }
  set(ms: number): void {
    this.t = ms;
  }
}
