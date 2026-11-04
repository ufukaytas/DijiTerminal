// 05/02: harita ölçümleri main'e yalnızca ölçüm açıkken gider.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERF_REPORT_MS, startPerfReporting } from '@renderer/components/mapLink';
import type { MapPerfSample } from '@renderer/map3d/scene';

const SAMPLE: MapPerfSample = {
  frames: { active: 10, ambient: 0, idle: 4 },
  ms: { active: 200, ambient: 0, idle: 1800, stopped: 0 },
  frameMsAvg: 1,
  frameMsMax: 2,
  calls: 80,
  geometries: 30,
  textures: 5,
  orphanGeometries: 0,
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('startPerfReporting', () => {
  it('main false dönerse gönderim durur', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, data: false });
    startPerfReporting({ perfSample: () => SAMPLE }, { invoke } as never, () => 9.5);
    await vi.advanceTimersByTimeAsync(PERF_REPORT_MS);
    expect(invoke).toHaveBeenCalledWith('perf:renderer', { ...SAMPLE, jsHeapMb: 9.5 });
    await vi.advanceTimersByTimeAsync(PERF_REPORT_MS * 5);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("ölçüm açıkken 2 sn'de bir; durdurunca biter; API yoksa hiçbir şey yapmaz", async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, data: true });
    const stop = startPerfReporting({ perfSample: () => SAMPLE }, { invoke } as never, () => null);
    await vi.advanceTimersByTimeAsync(PERF_REPORT_MS * 3);
    expect(invoke).toHaveBeenCalledTimes(3);
    stop();
    await vi.advanceTimersByTimeAsync(PERF_REPORT_MS * 3);
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(() => startPerfReporting({ perfSample: () => SAMPLE }, undefined)()).not.toThrow();
  });
});
