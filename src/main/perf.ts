// Performans örnekleyici (05/02). Electron'a doğrudan bağlı değil: süreç metrikleri, motor ve pencere
// dışarıdan verilir; böylece hem uygulamada (app.getAppMetrics) hem başsız benchmark'ta (process.cpuUsage)
// aynı toplama/özet kodu çalışır. Rapor yalnızca sayı içerir; session adı ya da yol yazılmaz.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RendererPerfSample } from '@shared/ipc';
import type { BoardEvent, BoardSnapshot } from '@shared/types';

export type Visibility = 'visible' | 'occluded' | 'hidden';

/** Electron `ProcessMetric`'inin kullandığımız alt kümesi. */
export interface ProcessMetricLike {
  type: string; // 'Browser' (main) | 'Tab' (renderer) | 'GPU' | 'Utility' …
  cpu: { percentCPUUsage: number };
  memory: { workingSetSize: number }; // KB
}

export interface PerfSample {
  at: number;
  cpu: { main: number; renderer: number; gpu: number | null }; // yüzde (tek çekirdek = 100)
  rssMb: { main: number; renderer: number; gpu: number | null; total: number };
  snapshotBytes: number;
  eventsPerSec: number;
  bytesReadPerSec: number;
  visibility: Visibility;
}

export interface PerfPhase {
  name: 'visible' | 'hidden';
  durationMs: number;
  samples: number;
  avg: PerfSample;
  p95: PerfSample;
}

export interface MachineInfo {
  cpuModel: string;
  cores: number;
  memGb: number;
  os: string;
}

export interface PerfReport {
  version: 1;
  mode: 'app' | 'headless';
  machine: MachineInfo;
  startedAt: number;
  durationMs: number;
  firstSnapshotMs: number | null;
  /** Ölçüm boyunca görülen en büyük snapshot (JSON bayt). */
  maxSnapshotBytes: number;
  /** Örnekler arası RSS (toplam) — soak trendi için 5 dk'lık kovalar: [dk, MB]. */
  rssTrend: [number, number][];
  phases: PerfPhase[];
  renderer?: RendererPerfSummary;
  budgetViolations: { metric: string; value: number; limit: number }[];
}

/**
 * 3B harita çizim döngüsü özeti (renderer'ın 'perf:renderer' örneklerinden). fps değerleri o modda
 * geçen süreye göre; bir modda 2 sn'den az kalındıysa null (ölçüm anlamsız).
 */
export interface RendererPerfSummary {
  samples: number;
  /** Görünür (durmamış) süre boyunca ortalama kare/sn. */
  fpsAvg: number;
  fpsActive: number | null;
  fpsAmbient: number | null;
  fpsIdle: number | null;
  /** Sürenin modlara dağılımı (0–1). */
  modeShare: { active: number; ambient: number; idle: number; stopped: number };
  frameMsAvg: number;
  frameMsMax: number;
  /** Son örnekteki three sayaçları ve ilk örnekteki geometri/texture (sızıntı sapması için). */
  calls: number;
  geometries: number;
  textures: number;
  geometriesFirst: number;
  texturesFirst: number;
  /** Son örnekte ve ölçüm boyunca en çok sahipsiz geometri (null: renderer bildirmedi). */
  orphanGeometries: number | null;
  orphanGeometriesMax: number | null;
  jsHeapMb: number | null;
}

const MIN_MODE_MS = 2000;

/** IPC'den gelen renderer örneğini doğrula: yalnızca sonlu, negatif olmayan sayılar. */
export function sanitizeRendererSample(x: unknown): RendererPerfSample | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const n = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e9 ? v : null;
  const sub = <K extends string>(v: unknown, keys: readonly K[]): Record<K, number> | null => {
    if (!v || typeof v !== 'object') return null;
    const out = {} as Record<K, number>;
    for (const k of keys) {
      const val = n((v as Record<string, unknown>)[k]);
      if (val === null) return null;
      out[k] = val;
    }
    return out;
  };
  const frames = sub(o['frames'], ['active', 'ambient', 'idle'] as const);
  const ms = sub(o['ms'], ['active', 'ambient', 'idle', 'stopped'] as const);
  const scalars = sub(o, ['frameMsAvg', 'frameMsMax', 'calls', 'geometries', 'textures'] as const);
  if (!frames || !ms || !scalars) return null;
  const heap = o['jsHeapMb'] === null ? null : n(o['jsHeapMb']);
  const orphans = n(o['orphanGeometries']);
  return { frames, ms, ...scalars, ...(orphans !== null ? { orphanGeometries: orphans } : {}), jsHeapMb: heap };
}

/** Motorun örnekleyiciye verdiği yüzey (SessionEngine ve DemoEngine ikisi de uyar). */
export interface EngineLike {
  onSnapshot(cb: (s: BoardSnapshot) => void): () => void;
  onEvents(cb: (e: BoardEvent[]) => void): () => void;
}

export interface PerfSamplerOptions {
  /** Süreç metrikleri: uygulamada `app.getAppMetrics()`. */
  metrics: () => ProcessMetricLike[];
  engine?: EngineLike | null;
  /** Okunan toplam transcript baytı (TranscriptPool.stats().bytesRead); yoksa 0. */
  bytesRead?: () => number;
  visibility?: () => Visibility;
  now?: () => number;
  machine?: MachineInfo;
  mode?: PerfReport['mode'];
}

const TREND_BUCKET_MS = 5 * 60_000;

export function machineInfo(): MachineInfo {
  const cpus = os.cpus();
  return {
    cpuModel: cpus[0]?.model?.trim() || 'bilinmiyor',
    cores: cpus.length,
    memGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    os: `${os.platform()} ${os.release()} ${os.arch()}`,
  };
}

/** Süreç tiplerine göre topla. Electron working set KB verir. */
export function aggregateMetrics(list: ProcessMetricLike[]): Pick<PerfSample, 'cpu' | 'rssMb'> {
  let mainCpu = 0;
  let rendererCpu = 0;
  let gpuCpu: number | null = null;
  let mainKb = 0;
  let rendererKb = 0;
  let gpuKb: number | null = null;
  let otherKb = 0;
  for (const m of list) {
    const cpu = Number.isFinite(m.cpu.percentCPUUsage) ? m.cpu.percentCPUUsage : 0;
    const kb = Number.isFinite(m.memory.workingSetSize) ? m.memory.workingSetSize : 0;
    if (m.type === 'Browser') {
      mainCpu += cpu;
      mainKb += kb;
    } else if (m.type === 'Tab') {
      rendererCpu += cpu;
      rendererKb += kb;
    } else if (m.type === 'GPU') {
      gpuCpu = (gpuCpu ?? 0) + cpu;
      gpuKb = (gpuKb ?? 0) + kb;
    } else {
      // Utility (ağ servisi vb.): CPU'su main'e yazılmaz ama toplam bellekte sayılır.
      otherKb += kb;
    }
  }
  const mb = (kb: number) => round1(kb / 1024);
  return {
    cpu: { main: round1(mainCpu), renderer: round1(rendererCpu), gpu: gpuCpu === null ? null : round1(gpuCpu) },
    rssMb: {
      main: mb(mainKb),
      renderer: mb(rendererKb),
      gpu: gpuKb === null ? null : mb(gpuKb),
      total: mb(mainKb + rendererKb + (gpuKb ?? 0) + otherKb),
    },
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i] ?? 0;
}
function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}
function nullableStat(values: (number | null)[], f: (v: number[]) => number): number | null {
  const v = values.filter((x): x is number => x !== null);
  return v.length ? round1(f(v)) : null;
}

/** Örnekler → ortalama ya da yüzdelik dilim örneği. */
export function summarize(samples: PerfSample[], kind: 'avg' | 'p95'): PerfSample {
  const f = kind === 'avg' ? mean : (v: number[]) => percentile(v, 95);
  const pick = (g: (s: PerfSample) => number) => round1(f(samples.map(g)));
  return {
    at: samples[samples.length - 1]?.at ?? 0,
    cpu: {
      main: pick((s) => s.cpu.main),
      renderer: pick((s) => s.cpu.renderer),
      gpu: nullableStat(
        samples.map((s) => s.cpu.gpu),
        f,
      ),
    },
    rssMb: {
      main: pick((s) => s.rssMb.main),
      renderer: pick((s) => s.rssMb.renderer),
      gpu: nullableStat(
        samples.map((s) => s.rssMb.gpu),
        f,
      ),
      total: pick((s) => s.rssMb.total),
    },
    snapshotBytes: Math.round(f(samples.map((s) => s.snapshotBytes))),
    eventsPerSec: pick((s) => s.eventsPerSec),
    bytesReadPerSec: Math.round(f(samples.map((s) => s.bytesReadPerSec))),
    visibility: samples[samples.length - 1]?.visibility ?? 'visible',
  };
}

/** Görünürlüğe göre fazlara böl ('occluded' görünmez sayılır). */
export function phasesOf(samples: PerfSample[], intervalMs: number): PerfPhase[] {
  const out: PerfPhase[] = [];
  for (const name of ['visible', 'hidden'] as const) {
    const ss = samples.filter((s) => (name === 'visible' ? s.visibility === 'visible' : s.visibility !== 'visible'));
    if (!ss.length) continue;
    out.push({
      name,
      durationMs: ss.length * intervalMs,
      samples: ss.length,
      avg: summarize(ss, 'avg'),
      p95: summarize(ss, 'p95'),
    });
  }
  return out;
}

/** 5 dk'lık kovalarda ortalama toplam RSS: [kova başlangıcı (dk), MB]. */
export function rssTrend(samples: PerfSample[], startedAt: number): [number, number][] {
  const buckets = new Map<number, number[]>();
  for (const s of samples) {
    const b = Math.floor((s.at - startedAt) / TREND_BUCKET_MS);
    const arr = buckets.get(b) ?? [];
    arr.push(s.rssMb.total);
    buckets.set(b, arr);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([b, v]) => [(b * TREND_BUCKET_MS) / 60_000, round1(mean(v))]);
}

export class PerfSampler {
  private readonly o: Required<Omit<PerfSamplerOptions, 'engine' | 'machine'>> &
    Pick<PerfSamplerOptions, 'engine' | 'machine'>;
  private samples: PerfSample[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private intervalMs = 1000;
  private startedAt = 0;
  private lastAt = 0;
  private events = 0;
  private lastBytes = 0;
  private lastSnapshotBytes = 0;
  private maxSnapshotBytes = 0;
  private firstSnapshotMs: number | null = null;
  private renderer: PerfReport['renderer'];
  private rs: {
    n: number;
    frames: RendererPerfSample['frames'];
    ms: RendererPerfSample['ms'];
    costSum: number;
    costMax: number;
    first: RendererPerfSample | null;
    last: RendererPerfSample | null;
    orphanMax: number | null;
  } = {
    n: 0,
    frames: { active: 0, ambient: 0, idle: 0 },
    ms: { active: 0, ambient: 0, idle: 0, stopped: 0 },
    costSum: 0,
    costMax: 0,
    first: null,
    last: null,
    orphanMax: null,
  };
  private offs: (() => void)[] = [];

  constructor(opts: PerfSamplerOptions) {
    this.o = {
      bytesRead: () => 0,
      visibility: () => 'visible',
      now: () => Date.now(),
      mode: 'app',
      ...opts,
    };
  }

  start(intervalMs = 1000): void {
    if (this.timer) return;
    this.intervalMs = intervalMs;
    this.startedAt = this.o.now();
    this.lastAt = this.startedAt;
    this.lastBytes = this.o.bytesRead();
    const e = this.o.engine;
    if (e) {
      this.offs.push(
        e.onSnapshot((s) => {
          const bytes = Buffer.byteLength(JSON.stringify(s));
          this.lastSnapshotBytes = bytes;
          if (bytes > this.maxSnapshotBytes) this.maxSnapshotBytes = bytes;
          if (s.booted && this.firstSnapshotMs === null) this.markFirstSnapshot(this.o.now() - this.startedAt);
        }),
        e.onEvents((list) => {
          this.events += list.length;
        }),
      );
    }
    this.timer = setInterval(() => this.sample(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const off of this.offs.splice(0)) off();
  }

  /** Motor start() → ilk booted snapshot (ms). Motor olayından otomatik de alınır. */
  markFirstSnapshot(ms: number): void {
    if (this.firstSnapshotMs === null) this.firstSnapshotMs = Math.round(ms);
  }

  /** Renderer'dan gelen hazır özet (eski yol; testler). */
  setRendererInfo(info: NonNullable<PerfReport['renderer']>): void {
    this.renderer = info;
  }

  /** Renderer çizim döngüsü örneği (05/02, ~2 sn'de bir). */
  addRendererSample(s: RendererPerfSample): void {
    const r = this.rs;
    r.n++;
    for (const k of ['active', 'ambient', 'idle'] as const) r.frames[k] += s.frames[k];
    for (const k of ['active', 'ambient', 'idle', 'stopped'] as const) r.ms[k] += s.ms[k];
    const frames = s.frames.active + s.frames.ambient + s.frames.idle;
    r.costSum += s.frameMsAvg * frames;
    r.costMax = Math.max(r.costMax, s.frameMsMax);
    r.first ??= s;
    r.last = s;
    if (s.orphanGeometries !== undefined) r.orphanMax = Math.max(r.orphanMax ?? 0, s.orphanGeometries);
  }

  /** Renderer örneklerinin özeti; örnek yoksa null. */
  rendererSummary(): RendererPerfSummary | null {
    const r = this.rs;
    if (!r.n || !r.last || !r.first) return null;
    const fps = (f: number, ms: number) => (ms >= MIN_MODE_MS ? round1((f * 1000) / ms) : null);
    const frames = r.frames.active + r.frames.ambient + r.frames.idle;
    const running = r.ms.active + r.ms.ambient + r.ms.idle;
    const total = running + r.ms.stopped;
    const share = (v: number) => (total > 0 ? Math.round((v / total) * 1000) / 1000 : 0);
    return {
      samples: r.n,
      fpsAvg: running > 0 ? round1((frames * 1000) / running) : 0,
      fpsActive: fps(r.frames.active, r.ms.active),
      fpsAmbient: fps(r.frames.ambient, r.ms.ambient),
      fpsIdle: fps(r.frames.idle, r.ms.idle),
      modeShare: {
        active: share(r.ms.active),
        ambient: share(r.ms.ambient),
        idle: share(r.ms.idle),
        stopped: share(r.ms.stopped),
      },
      frameMsAvg: frames ? Math.round((r.costSum / frames) * 100) / 100 : 0,
      frameMsMax: Math.round(r.costMax * 100) / 100,
      calls: r.last.calls,
      geometries: r.last.geometries,
      textures: r.last.textures,
      geometriesFirst: r.first.geometries,
      texturesFirst: r.first.textures,
      orphanGeometries: r.last.orphanGeometries ?? null,
      orphanGeometriesMax: r.orphanMax,
      jsHeapMb: r.last.jsHeapMb,
    };
  }

  /** Bir örnek al (timer bunu çağırır; testler doğrudan çağırabilir). */
  sample(): PerfSample {
    const at = this.o.now();
    const dtSec = Math.max(0.001, (at - this.lastAt) / 1000);
    const bytes = this.o.bytesRead();
    const s: PerfSample = {
      at,
      ...aggregateMetrics(this.o.metrics()),
      snapshotBytes: this.lastSnapshotBytes,
      eventsPerSec: round1(this.events / dtSec),
      bytesReadPerSec: Math.max(0, Math.round((bytes - this.lastBytes) / dtSec)),
      visibility: this.o.visibility(),
    };
    this.events = 0;
    this.lastBytes = bytes;
    this.lastAt = at;
    this.samples.push(s);
    return s;
  }

  /** Son N saniyenin tek satırlık özeti (DIJI_PERF=1 konsol çıktısı). */
  line(lastN = 10): string {
    const ss = this.samples.slice(-lastN);
    if (!ss.length) return '[perf] örnek yok';
    const a = summarize(ss, 'avg');
    const gpu = a.cpu.gpu === null ? '—' : `${a.cpu.gpu}%`;
    const rr = this.rendererSummary();
    const map = rr ? ` · harita ${rr.fpsAvg} fps (aktif ${rr.fpsActive ?? '—'}, boşta ${rr.fpsIdle ?? '—'})` : '';
    return `[perf] cpu main ${a.cpu.main}% · renderer ${a.cpu.renderer}% · gpu ${gpu} · rss ${a.rssMb.total} MB · snapshot ${Math.round(a.snapshotBytes / 1024)} KB · ${a.eventsPerSec} olay/sn · ${Math.round(a.bytesReadPerSec / 1024)} KB/sn okuma · ${a.visibility}${map}`;
  }

  report(): PerfReport {
    const r: PerfReport = {
      version: 1,
      mode: this.o.mode,
      machine: this.o.machine ?? machineInfo(),
      startedAt: this.startedAt,
      durationMs: (this.samples[this.samples.length - 1]?.at ?? this.startedAt) - this.startedAt,
      firstSnapshotMs: this.firstSnapshotMs,
      maxSnapshotBytes: this.maxSnapshotBytes,
      rssTrend: rssTrend(this.samples, this.startedAt),
      phases: phasesOf(this.samples, this.intervalMs),
      budgetViolations: [], // scripts/bench.mjs bütçeyle karşılaştırıp doldurur
    };
    const rr = this.rendererSummary() ?? this.renderer;
    if (rr) r.renderer = rr;
    return r;
  }
}

/**
 * DIJI_PERF_OUT güvenli mi? Paketli uygulamada rapor yalnızca kullanıcı dizini ya da geçici dizin altına
 * yazılabilir (05/02 Bölüm 6). Geliştirmede her mutlak yol kabul edilir.
 */
export function safeOutPath(
  raw: string | undefined,
  packaged: boolean,
  home = os.homedir(),
  tmp = os.tmpdir(),
): string | null {
  if (!raw || !path.isAbsolute(raw)) return null;
  const p = path.resolve(raw);
  if (!packaged) return p;
  const inside = (root: string) => {
    const rel = path.relative(path.resolve(root), p);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  return inside(home) || inside(tmp) ? p : null;
}

/** Uygulamanın verdiği yüzey (electron `app` + pencere); perf.ts electron import etmez. */
export interface PerfAppHooks {
  isPackaged: boolean;
  getAppMetrics(): ProcessMetricLike[];
  quit(): void;
  /** Pencere görünürlüğü (isVisible && !isMinimized → visible). */
  visibility(): Visibility;
  /** DIJI_BENCH_HIDE_AT: pencereyi gizle. */
  hideWindow(): void;
  /** Çıkışta senkron rapor yazımı için. */
  onWillQuit(cb: () => void): void;
  /** TranscriptPool okunan bayt (SessionEngine.internals.pool.stats().bytesRead). */
  bytesRead?: () => number;
}

/**
 * Ortam değişkenleriyle ölçüm (yalnızca geliştirme ve benchmark):
 *   DIJI_PERF=1              örnekleyici çalışır, 10 sn'de bir konsola özet satır
 *   DIJI_PERF_OUT=<dosya>    rapor 10 sn'de bir ve çıkışta JSON olarak yazılır
 *   DIJI_BENCH_HIDE_AT=<ms>  açılıştan ms sonra pencere gizlenir (gizli faz ölçümü)
 *   DIJI_BENCH_QUIT_AT=<ms>  açılıştan ms sonra uygulama kapanır (bench.mjs süresi)
 * DIJI_PERF yoksa hiçbir şey yapmaz ve null döner.
 */
export function startPerfFromEnv(
  engine: EngineLike,
  hooks: PerfAppHooks,
  env: NodeJS.ProcessEnv = process.env,
): PerfSampler | null {
  if (env['DIJI_PERF'] !== '1') return null;
  const sampler = new PerfSampler({
    metrics: () => hooks.getAppMetrics(),
    engine,
    bytesRead: hooks.bytesRead ?? (() => 0),
    visibility: () => hooks.visibility(),
    mode: 'app',
  });
  sampler.start(1000);
  const out = safeOutPath(env['DIJI_PERF_OUT'], hooks.isPackaged);
  if (env['DIJI_PERF_OUT'] && !out)
    console.warn('[perf] DIJI_PERF_OUT kabul edilmedi (mutlak ve kullanıcı/geçici dizin altında olmalı).');
  const write = () => {
    if (!out) return;
    try {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const tmp = `${out}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(sampler.report(), null, 2));
      fs.renameSync(tmp, out);
    } catch (e) {
      console.error('[perf] rapor yazılamadı:', e);
    }
  };
  const logTimer = setInterval(() => {
    console.log(sampler.line(10));
    write();
  }, 10_000);
  logTimer.unref?.();
  const ms = (k: string) => {
    const n = Number(env[k]);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const hideAt = ms('DIJI_BENCH_HIDE_AT');
  if (hideAt) setTimeout(() => hooks.hideWindow(), hideAt).unref?.();
  const quitAt = ms('DIJI_BENCH_QUIT_AT');
  if (quitAt)
    setTimeout(() => {
      write();
      hooks.quit();
    }, quitAt).unref?.();
  hooks.onWillQuit(() => {
    clearInterval(logTimer);
    sampler.stop();
    write();
  });
  return sampler;
}
