// Harita çizim döngüsü (05/02 Prompt 4): tek sahip, üç hız.
//
//   aktif   — her rAF (≈60 fps): kamera uçuşu/sürükleme/sönümleme, parçacık, şok halkası, büyüme, geçiş tween'leri.
//   ortam   — 15 fps: yalnızca yavaş, sürekli animasyon var (bekleme halkası, direk/ajan/shell nabzı, ısı sönümü).
//             Bunlar 1–1.6 sn periyotlu yumuşak parlaklık/ölçek değişimleri; 15 fps periyot başına 15–24 kare verir,
//             göz farkı görmez ama 60 fps'in dörtte biri kadar çizim yapılır. Saatlerce "onay bekleyen" bir session
//             varken döngünün 60 fps'te kalmaması için bu ara kademe var.
//   boşta   — 4 fps: sahnede değişen bir şey yok. Dekoratif dönme/salınım (amblem, halo) durur; kareler yalnızca
//             etiket süreleri, plaka yeniden boyaması ve kaçmış bir uyandırmayı en geç 250 ms'de yakalamak için.
//             "İstek üzerine çizim" yerine düşük sabit hız seçildi: bir uyandırma unutulursa ekran donmuş kalmaz.
//   durdu   — sayfa gizli, WebGL bağlamı kayıp, sahne kapatıldı: hiç kare yok, zamanlayıcı yok.
//
// Her kare `tick` ne kadar hıza ihtiyaç olduğunu (Demand) döner; bir sonraki kare buna göre planlanır.
// Olay, snapshot, etkileşim `requestFrame()` ile döngüyü bekletmeden uyandırır.

export const DEMAND_NONE = 0;
export const DEMAND_AMBIENT = 1;
export const DEMAND_ACTIVE = 2;
export type Demand = typeof DEMAND_NONE | typeof DEMAND_AMBIENT | typeof DEMAND_ACTIVE;

export type LoopMode = 'active' | 'ambient' | 'idle' | 'stopped';

export const AMBIENT_FPS = 15;
export const IDLE_FPS = 4;
/** dt üst sınırı: aktifte uzun bir takılma animasyonu sıçratmasın; seyrek modlarda gerçek süre işlesin. */
export const MAX_DT_ACTIVE = 0.05;
export const MAX_DT_SLOW = 0.5;
const VSYNC_SLACK_MS = 8;

export interface LoopDeps {
  raf(cb: (t: number) => void): number;
  caf(id: number): void;
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  now(): number;
}

export interface LoopStats {
  frames: { active: number; ambient: number; idle: number };
  /** Her modda geçen süre (ms). */
  ms: { active: number; ambient: number; idle: number; stopped: number };
  frameMsAvg: number;
  frameMsMax: number;
}

const browserDeps = (): LoopDeps => ({
  raf: (cb) => requestAnimationFrame(cb),
  caf: (id) => cancelAnimationFrame(id),
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => performance.now(),
});

export const modeOf = (d: Demand): Exclude<LoopMode, 'stopped'> =>
  d === DEMAND_ACTIVE ? 'active' : d === DEMAND_AMBIENT ? 'ambient' : 'idle';

export class RenderLoop {
  private rafId = 0;
  private timer: unknown = null;
  private readonly stops = new Set<string>();
  private _mode: LoopMode = 'idle';
  private lastT: number | null = null;
  private readonly deps: LoopDeps;
  // istatistik
  private frames = { active: 0, ambient: 0, idle: 0 };
  private ms = { active: 0, ambient: 0, idle: 0, stopped: 0 };
  private modeSince: number;
  private costSum = 0;
  private costMax = 0;
  private costN = 0;
  private disposed = false;

  /** `tick(t, dt)` kareyi çizer ve bir sonraki kare için ihtiyacı döner. */
  constructor(
    private readonly tick: (t: number, dt: number, mode: Exclude<LoopMode, 'stopped'>) => Demand,
    deps?: Partial<LoopDeps>,
  ) {
    this.deps = { ...browserDeps(), ...deps };
    this.modeSince = this.deps.now();
  }

  get mode(): LoopMode {
    return this._mode;
  }

  get stopped(): boolean {
    return this.stops.size > 0 || this.disposed;
  }

  /** Bir sonraki ekran yenilemesinde çiz (seyrek moddaysa beklemeyi kes). */
  requestFrame(): void {
    if (this.stopped || this.rafId) return;
    this.clearTimer();
    this.rafId = this.deps.raf(this.onRaf);
  }

  /** Çizim şu an planlı mı (test/teşhis). */
  get pending(): boolean {
    return this.rafId !== 0 || this.timer !== null;
  }

  /** Bir durdurma sebebini aç/kapat ('hidden', 'lost', …). Sebep kalmayınca döngü hemen bir kare çizer. */
  setStopped(reason: string, on: boolean): void {
    if (this.disposed) return;
    const was = this.stopped;
    if (on) this.stops.add(reason);
    else this.stops.delete(reason);
    if (!was && this.stopped) {
      this.cancel();
      this.switchMode('stopped');
      this.lastT = null; // devam edince dt sıfırdan başlasın
    } else if (was && !this.stopped) {
      this.switchMode('active');
      this.requestFrame();
    }
  }

  /** Son ölçümden bu yana istatistikler (ve sıfırla). */
  takeStats(): LoopStats {
    this.switchMode(this._mode); // açık modun süresini kapat
    const s: LoopStats = {
      frames: { ...this.frames },
      ms: { ...this.ms },
      frameMsAvg: this.costN ? Math.round((this.costSum / this.costN) * 100) / 100 : 0,
      frameMsMax: Math.round(this.costMax * 100) / 100,
    };
    this.frames = { active: 0, ambient: 0, idle: 0 };
    this.ms = { active: 0, ambient: 0, idle: 0, stopped: 0 };
    this.costSum = this.costMax = this.costN = 0;
    return s;
  }

  dispose(): void {
    this.cancel();
    this.disposed = true;
    this._mode = 'stopped';
  }

  private readonly onRaf = (t: number): void => {
    this.rafId = 0;
    if (this.stopped) return;
    const prev = this._mode === 'stopped' ? 'active' : this._mode;
    const cap = prev === 'active' ? MAX_DT_ACTIVE : MAX_DT_SLOW;
    const dt = this.lastT === null ? 0 : Math.min(cap, Math.max(0, (t - this.lastT) / 1000));
    this.lastT = t;
    const t0 = this.deps.now();
    let demand: Demand;
    try {
      demand = this.tick(t, dt, prev);
    } finally {
      const cost = this.deps.now() - t0;
      this.costSum += cost;
      this.costN++;
      if (cost > this.costMax) this.costMax = cost;
      this.frames[prev]++;
    }
    if (this.stopped) return; // tick içinde durdurulduysa
    // tick sırasında biri requestFrame() dediyse (ör. kontrolün 'change' olayı) kare zaten istendi: ikinci rAF yok.
    const mode = this.rafId ? 'active' : modeOf(demand);
    this.switchMode(mode);
    if (this.rafId) return;
    if (mode === 'active') {
      this.rafId = this.deps.raf(this.onRaf);
      return;
    }
    // Zamanlayıcı yarım vsync erken uyanır; rAF kareyi bir sonraki yenilemeye hizalar (yoksa 15 fps → 12 fps).
    const interval = 1000 / (mode === 'ambient' ? AMBIENT_FPS : IDLE_FPS);
    const delay = Math.max(0, interval - VSYNC_SLACK_MS - (this.deps.now() - t0));
    this.timer = this.deps.setTimeout(() => {
      this.timer = null;
      if (!this.stopped && !this.rafId) this.rafId = this.deps.raf(this.onRaf);
    }, delay);
  };

  private switchMode(m: LoopMode): void {
    const now = this.deps.now();
    this.ms[this._mode] += Math.max(0, now - this.modeSince);
    this.modeSince = now;
    this._mode = m;
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.deps.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private cancel(): void {
    if (this.rafId) this.deps.caf(this.rafId);
    this.rafId = 0;
    this.clearTimer();
  }
}
