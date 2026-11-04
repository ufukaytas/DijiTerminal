// 05/02: PerfSampler toplama, fazlar, trend ve ortam değişkenleriyle başlatma (electron'suz).
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { BoardEvent, BoardSnapshot } from '@shared/types';
import {
  aggregateMetrics,
  footprintTotalMb,
  parseFootprint,
  PerfSampler,
  phasesOf,
  rssTrend,
  safeOutPath,
  sanitizeRendererSample,
  startPerfFromEnv,
  type ProcessMetricLike,
  type Visibility,
} from '@main/perf';

const m = (type: string, cpu: number, kb: number): ProcessMetricLike => ({
  type,
  cpu: { percentCPUUsage: cpu },
  memory: { workingSetSize: kb },
});

function fakeEngine() {
  let snap: ((s: BoardSnapshot) => void) | null = null;
  let ev: ((e: BoardEvent[]) => void) | null = null;
  return {
    onSnapshot: (cb: (s: BoardSnapshot) => void) => ((snap = cb), () => (snap = null)),
    onEvents: (cb: (e: BoardEvent[]) => void) => ((ev = cb), () => (ev = null)),
    pushSnapshot: (s: Partial<BoardSnapshot>) => snap?.(s as BoardSnapshot),
    pushEvents: (n: number) =>
      ev?.(Array.from({ length: n }, () => ({ type: 'prompt', sessionId: 'x', label: '', at: 0 }) as BoardEvent)),
    listening: () => snap !== null || ev !== null,
  };
}

describe('aggregateMetrics', () => {
  it('süreç tiplerine göre toplar; KB → MB; Utility yalnızca toplam bellekte', () => {
    const a = aggregateMetrics([
      m('Browser', 2, 102400),
      m('Tab', 10, 204800),
      m('GPU', 4, 51200),
      m('Utility', 1, 10240),
    ]);
    expect(a.cpu).toEqual({ main: 2, renderer: 10, gpu: 4 });
    expect(a.rssMb).toEqual({ main: 100, renderer: 200, gpu: 50, total: 360 });
  });

  it('GPU süreci yoksa null', () => {
    const a = aggregateMetrics([m('Browser', 1, 1024)]);
    expect(a.cpu.gpu).toBeNull();
    expect(a.rssMb.gpu).toBeNull();
  });
});

describe('PerfSampler', () => {
  it('olay/sn, okunan bayt/sn, snapshot boyutu ve ilk snapshot süresi', () => {
    let now = 1_000;
    let bytes = 0;
    const engine = fakeEngine();
    const s = new PerfSampler({
      metrics: () => [m('Browser', 3, 1024)],
      engine,
      bytesRead: () => bytes,
      now: () => now,
      machine: { cpuModel: 'test', cores: 1, memGb: 1, os: 'x' },
    });
    s.start(1000);
    now += 250;
    engine.pushSnapshot({ booted: false, sessions: [] });
    now += 250;
    engine.pushSnapshot({ booted: true, sessions: [] });
    engine.pushEvents(10);
    bytes = 4096;
    now = 3_000;
    const x = s.sample();
    expect(x.eventsPerSec).toBe(5);
    expect(x.bytesReadPerSec).toBe(2048);
    expect(x.snapshotBytes).toBe(Buffer.byteLength(JSON.stringify({ booted: true, sessions: [] })));
    const r = s.report();
    expect(r.firstSnapshotMs).toBe(500);
    expect(r.machine.cpuModel).toBe('test');
    expect(r.phases[0]?.name).toBe('visible');
    s.stop();
    expect(engine.listening()).toBe(false);
  });

  it('görünürlük fazları ve p95', () => {
    let vis: Visibility = 'visible';
    let cpu = 1;
    let now = 0;
    const s = new PerfSampler({
      metrics: () => [m('Browser', cpu, 1024)],
      visibility: () => vis,
      now: () => (now += 1000),
      machine: { cpuModel: 't', cores: 1, memGb: 1, os: 'x' },
    });
    for (let i = 0; i < 20; i++) {
      cpu = i === 19 ? 50 : 2;
      s.sample();
    }
    vis = 'occluded';
    cpu = 0.2;
    for (let i = 0; i < 5; i++) s.sample();
    const ph = s.report().phases;
    expect(ph.map((p) => [p.name, p.samples])).toEqual([
      ['visible', 20],
      ['hidden', 5],
    ]);
    expect(ph[0]?.p95.cpu.main).toBe(2);
    expect(ph[0]?.avg.cpu.main).toBe(4.4);
    expect(ph[1]?.avg.cpu.main).toBe(0.2);
    expect(s.line(5)).toContain('occluded');
  });

  it('rssTrend 5 dk kovaları; phasesOf boş örnekte boş', () => {
    const at = (min: number, mb: number) => ({
      ...aggregateMetrics([m('Browser', 0, mb * 1024)]),
      footprintMb: null,
      at: min * 60_000,
      snapshotBytes: 0,
      eventsPerSec: 0,
      bytesReadPerSec: 0,
      visibility: 'visible' as const,
    });
    expect(rssTrend([at(0, 100), at(4, 110), at(6, 130), at(61, 150)], 0)).toEqual([
      [0, 105],
      [5, 130],
      [60, 150],
    ]);
    expect(phasesOf([], 1000)).toEqual([]);
  });
});

describe('footprint (phys_footprint)', () => {
  const OUT = [
    '======================================================================',
    'DijiTerminal [101]: 64-bit    Footprint: 100 MB (16384 bytes per page)',
    '======================================================================',
    '',
    'Auxiliary data:',
    '    phys_footprint: 104857600 B',
    '    phys_footprint_peak: 209715200 B',
    '',
    'DijiTerminal Helper (Renderer) [202]: 64-bit    Footprint: 50 MB (16384 bytes per page)',
    'Auxiliary data:',
    '    phys_footprint: 52428800 B',
  ].join('\n');

  it('çıktıyı pid → bayt olarak çözer; peak satırını almaz', () => {
    expect([...parseFootprint(OUT)]).toEqual([
      [101, 104857600],
      [202, 52428800],
    ]);
    expect(parseFootprint('footprint: error').size).toBe(0);
  });

  it('toplam MB; eksik pid ya da veri yoksa null', () => {
    const fp = parseFootprint(OUT);
    expect(footprintTotalMb([101, 202], fp)).toBe(150);
    expect(footprintTotalMb([101, 303], fp)).toBeNull();
    expect(footprintTotalMb([101], null)).toBeNull();
    expect(footprintTotalMb([], fp)).toBeNull();
  });

  it('örnekleyici footprint’i arka planda yeniler ve fazlara taşır', async () => {
    let now = 0;
    const calls: number[][] = [];
    const s = new PerfSampler({
      metrics: () => [
        { ...m('Browser', 1, 400 * 1024), pid: 101 },
        { ...m('Tab', 1, 300 * 1024), pid: 202 },
      ],
      footprint: async (pids) => {
        calls.push(pids);
        return parseFootprint(OUT);
      },
      footprintEvery: 2,
      now: () => now,
    });
    s.start(1000);
    s.stop();
    now = 1000;
    expect(s.sample().footprintMb).toBeNull(); // ilk ölçüm henüz dönmedi
    await new Promise((r) => setTimeout(r, 0));
    now = 2000;
    expect(s.sample().footprintMb).toBe(150);
    now = 3000;
    s.sample();
    expect(calls).toEqual([
      [101, 202],
      [101, 202],
    ]); // 3 örnekte 2 çağrı (her 2 örnekte bir)
    const ph = s.report().phases[0];
    expect(ph?.avg.rssMb.total).toBe(700);
    expect(ph?.p95.footprintMb).toBe(150);
  });
});

describe('safeOutPath', () => {
  const home = path.join(os.tmpdir(), 'home-x');
  const tmp = path.join(os.tmpdir(), 'tmp-x');
  it('geliştirmede mutlak her yol; paketlide yalnızca ev/geçici dizin altı', () => {
    expect(safeOutPath('/etc/x.json', false, home, tmp)).toBe('/etc/x.json');
    expect(safeOutPath('/etc/x.json', true, home, tmp)).toBeNull();
    expect(safeOutPath(path.join(home, 'p.json'), true, home, tmp)).toBe(path.join(home, 'p.json'));
    expect(safeOutPath(path.join(tmp, 'a/p.json'), true, home, tmp)).toBe(path.join(tmp, 'a/p.json'));
    expect(safeOutPath(path.join(home, '../escape.json'), true, home, tmp)).toBeNull();
    expect(safeOutPath('rel.json', false)).toBeNull();
    expect(safeOutPath(undefined, false)).toBeNull();
  });
});

describe('startPerfFromEnv', () => {
  const hooks = () => ({
    isPackaged: false,
    getAppMetrics: () => [m('Browser', 1, 1024)],
    quit: vi.fn(),
    visibility: () => 'visible' as const,
    hideWindow: vi.fn(),
    onWillQuit: vi.fn(),
  });

  it('DIJI_PERF yoksa hiçbir şey yapmaz', () => {
    expect(startPerfFromEnv(fakeEngine(), hooks(), {})).toBeNull();
  });

  it('gizleme ve kapanma zamanlayıcıları; çıkışta rapor yazılır', async () => {
    vi.useFakeTimers();
    try {
      const h = hooks();
      const out = path.join(os.tmpdir(), `diji-perf-${process.pid}.json`);
      const s = startPerfFromEnv(fakeEngine(), h, {
        DIJI_PERF: '1',
        DIJI_PERF_OUT: out,
        DIJI_BENCH_HIDE_AT: '2000',
        DIJI_BENCH_QUIT_AT: '5000',
      });
      expect(s).not.toBeNull();
      vi.advanceTimersByTime(2000);
      expect(h.hideWindow).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(3000);
      expect(h.quit).toHaveBeenCalledTimes(1);
      const fs = await import('node:fs');
      expect(JSON.parse(fs.readFileSync(out, 'utf8')).mode).toBe('app');
      fs.rmSync(out, { force: true });
      expect(h.onWillQuit).toHaveBeenCalledTimes(1);
      (h.onWillQuit.mock.calls[0]?.[0] as () => void)();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('renderer çizim döngüsü örnekleri (05/02)', () => {
  const sample = (o: Partial<Record<string, unknown>> = {}) => ({
    frames: { active: 120, ambient: 0, idle: 8 },
    ms: { active: 2000, ambient: 0, idle: 2000, stopped: 0 },
    frameMsAvg: 1.5,
    frameMsMax: 6,
    calls: 150,
    geometries: 40,
    textures: 6,
    jsHeapMb: 12.5,
    ...o,
  });

  it('doğrulama: bozuk/eksik/negatif/sonsuz alanlı örnek reddedilir', () => {
    expect(sanitizeRendererSample(sample())).toEqual(sample());
    expect(sanitizeRendererSample(null)).toBeNull();
    expect(sanitizeRendererSample('x')).toBeNull();
    expect(sanitizeRendererSample(sample({ calls: -1 }))).toBeNull();
    expect(sanitizeRendererSample(sample({ frameMsAvg: Infinity }))).toBeNull();
    expect(sanitizeRendererSample(sample({ frames: { active: 1, ambient: 1 } }))).toBeNull();
    expect(sanitizeRendererSample(sample({ jsHeapMb: null }))?.jsHeapMb).toBeNull();
  });

  it('özet: moda göre fps, süre payı, ilk/son geometri; 2 sn altı mod null', () => {
    const s = new PerfSampler({ metrics: () => [] });
    expect(s.rendererSummary()).toBeNull();
    s.addRendererSample(sanitizeRendererSample(sample())!);
    s.addRendererSample(
      sanitizeRendererSample(sample({ geometries: 42, ms: { active: 2000, ambient: 0, idle: 2000, stopped: 4000 } }))!,
    );
    const r = s.rendererSummary()!;
    expect(r.samples).toBe(2);
    expect(r.fpsActive).toBe(60);
    expect(r.fpsIdle).toBe(4);
    expect(r.fpsAmbient).toBeNull();
    expect(r.fpsAvg).toBe(32);
    expect(r.modeShare).toEqual({ active: 0.333, ambient: 0, idle: 0.333, stopped: 0.333 });
    expect(r.frameMsAvg).toBe(1.5);
    expect(r.frameMsMax).toBe(6);
    expect([r.geometriesFirst, r.geometries]).toEqual([40, 42]);
    expect(s.report().renderer).toEqual(r);
    expect(s.line()).toBe('[perf] örnek yok');
  });
});
