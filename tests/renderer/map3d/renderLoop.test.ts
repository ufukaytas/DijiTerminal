// Çizim döngüsü (05/02 Prompt 4): aktif/ortam/boşta hızları, uyandırma, durdurma, istatistik.
import { describe, expect, it } from 'vitest';
import {
  AMBIENT_FPS,
  DEMAND_ACTIVE,
  DEMAND_AMBIENT,
  DEMAND_NONE,
  IDLE_FPS,
  MAX_DT_ACTIVE,
  RenderLoop,
  type Demand,
} from '@renderer/map3d/renderLoop';

/** Sahte saat: rAF 16.67 ms'de bir, setTimeout gerçek gecikmeyle. */
function harness(demandOf: (frame: number) => Demand = () => DEMAND_NONE) {
  let now = 0;
  let nextId = 1;
  const rafs = new Map<number, (t: number) => void>();
  const timers = new Map<number, { at: number; cb: () => void }>();
  const frames: { t: number; dt: number; mode: string }[] = [];
  const loop = new RenderLoop(
    (t, dt, mode) => {
      frames.push({ t, dt, mode });
      return demandOf(frames.length);
    },
    {
      raf: (cb) => {
        const id = nextId++;
        rafs.set(id, cb);
        return id;
      },
      caf: (id) => void rafs.delete(id),
      setTimeout: (cb, ms) => {
        const id = nextId++;
        timers.set(id, { at: now + ms, cb });
        return id;
      },
      clearTimeout: (h) => void timers.delete(h as number),
      now: () => now,
    },
  );
  const VSYNC = 1000 / 60;
  /** `ms` boyunca zamanı ilerlet: her vsync'te bekleyen rAF'ler, vadesi gelen zamanlayıcılar çalışır. */
  const advance = (ms: number) => {
    const end = now + ms;
    while (now < end) {
      now = Math.min(end, now + VSYNC);
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id);
          t.cb();
        }
      }
      const due = [...rafs];
      rafs.clear();
      for (const [, cb] of due) cb(now);
    }
  };
  return { loop, frames, advance, pendingRafs: () => rafs.size, pendingTimers: () => timers.size };
}

describe('RenderLoop', () => {
  it('boşta: saniyede ≈4 kare; aktif: her vsync', () => {
    const idle = harness(() => DEMAND_NONE);
    idle.loop.requestFrame();
    idle.advance(10_000);
    expect(idle.frames.length).toBeGreaterThanOrEqual(10 * IDLE_FPS - 2);
    expect(idle.frames.length).toBeLessThanOrEqual(10 * IDLE_FPS + 2);

    const active = harness(() => DEMAND_ACTIVE);
    active.loop.requestFrame();
    active.advance(1000);
    expect(active.frames.length).toBeGreaterThanOrEqual(58);
  });

  it('ortam: saniyede ≈15 kare (yavaş nabızlar)', () => {
    const h = harness(() => DEMAND_AMBIENT);
    h.loop.requestFrame();
    h.advance(4000);
    expect(h.frames.length).toBeGreaterThanOrEqual(4 * AMBIENT_FPS - 6);
    expect(h.frames.length).toBeLessThanOrEqual(4 * AMBIENT_FPS + 2);
    expect(h.loop.mode).toBe('ambient');
  });

  it("requestFrame boşta beklemeyi keser: bir sonraki vsync'te çizer", () => {
    const h = harness(() => DEMAND_NONE);
    h.loop.requestFrame();
    h.advance(20); // ilk kare → boşta, 250 ms zamanlayıcı
    const n = h.frames.length;
    h.loop.requestFrame();
    h.advance(17);
    expect(h.frames.length).toBe(n + 1);
    expect(h.pendingRafs() + h.pendingTimers()).toBe(1); // tek plan: çift döngü yok
  });

  it('aktif → boşta: talep bitince seyrekleşir; uyandırınca yeniden tam hız', () => {
    let busyUntil = 30;
    const h = harness((i) => (i <= busyUntil ? DEMAND_ACTIVE : DEMAND_NONE));
    h.loop.requestFrame();
    h.advance(1000);
    const first = h.frames.length;
    expect(first).toBeGreaterThanOrEqual(30);
    expect(first).toBeLessThan(40); // 30 aktif kare + birkaç boşta
    h.advance(2000);
    expect(h.frames.length - first).toBeLessThanOrEqual(2 * IDLE_FPS + 1);
    expect(h.loop.mode).toBe('idle');
    busyUntil = h.frames.length + 20;
    h.loop.requestFrame();
    h.advance(400);
    expect(h.loop.mode).toBe('idle');
    expect(h.frames.filter((f) => f.mode === 'active').length).toBeGreaterThanOrEqual(49);
  });

  it('kare içinde requestFrame (ör. kontrol "change") ikinci rAF açmaz', () => {
    let loopRef: RenderLoop | null = null;
    const h = harness(() => {
      loopRef?.requestFrame();
      return DEMAND_ACTIVE;
    });
    loopRef = h.loop;
    h.loop.requestFrame();
    h.advance(1000);
    expect(h.frames.length).toBeLessThanOrEqual(61);
    expect(h.pendingRafs()).toBe(1);
  });

  it('durdur: gizliyken hiç kare ve zamanlayıcı yok; açılınca hemen bir kare, dt sıfırdan', () => {
    const h = harness(() => DEMAND_AMBIENT);
    h.loop.requestFrame();
    h.advance(500);
    h.loop.setStopped('hidden', true);
    expect(h.loop.mode).toBe('stopped');
    const n = h.frames.length;
    h.loop.requestFrame(); // gizliyken uyandırma yok sayılır
    h.advance(5000);
    expect(h.frames.length).toBe(n);
    expect(h.pendingRafs() + h.pendingTimers()).toBe(0);
    h.loop.setStopped('hidden', false);
    h.advance(17);
    expect(h.frames.length).toBe(n + 1);
    expect(h.frames[n]!.dt).toBe(0);
  });

  it('birden çok durdurma sebebi: hepsi kalkınca devam eder', () => {
    const h = harness(() => DEMAND_ACTIVE);
    h.loop.requestFrame();
    h.loop.setStopped('hidden', true);
    h.loop.setStopped('lost', true);
    h.loop.setStopped('hidden', false);
    h.advance(200);
    expect(h.frames.length).toBe(0);
    h.loop.setStopped('lost', false);
    h.advance(200);
    expect(h.frames.length).toBeGreaterThan(5);
  });

  it('dt: aktifte en fazla 50 ms; seyrek modda gerçek süre (≈250 ms boşta)', () => {
    const h = harness(() => DEMAND_NONE);
    h.loop.requestFrame();
    h.advance(1000);
    const later = h.frames.slice(2);
    expect(Math.max(...later.map((f) => f.dt))).toBeGreaterThan(0.2);
    const a = harness(() => DEMAND_ACTIVE);
    a.loop.requestFrame();
    a.advance(500);
    expect(Math.max(...a.frames.map((f) => f.dt))).toBeLessThanOrEqual(MAX_DT_ACTIVE);
  });

  it('istatistik: moda göre kare ve süre; takeStats sıfırlar', () => {
    let i = 0;
    const h = harness(() => (++i <= 60 ? DEMAND_ACTIVE : DEMAND_NONE));
    h.loop.requestFrame();
    h.advance(3000);
    const s = h.loop.takeStats();
    expect(s.frames.active).toBeGreaterThanOrEqual(59);
    expect(s.frames.idle).toBeGreaterThanOrEqual(6);
    expect(s.ms.active).toBeGreaterThan(900);
    expect(s.ms.idle).toBeGreaterThan(1500);
    const z = h.loop.takeStats();
    expect(z.frames.active + z.frames.idle + z.frames.ambient).toBe(0);
  });

  it('dispose: bekleyen kare ve zamanlayıcı iptal', () => {
    const h = harness(() => DEMAND_NONE);
    h.loop.requestFrame();
    h.advance(20);
    h.loop.dispose();
    expect(h.pendingRafs() + h.pendingTimers()).toBe(0);
    h.loop.requestFrame();
    expect(h.pendingRafs()).toBe(0);
  });
});
