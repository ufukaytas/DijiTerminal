// 05/02: bütçe karşılaştırması ve replay döngü varyantı / boşluk sıkıştırma.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUDGET, evaluate, formatTable, isReferenceMachine } from '../../scripts/lib/budget.mjs';
import { replay, sessionIdsOf, withVariant } from '../../scripts/lib/replay-core.mjs';
import { readTree, REPO_ROOT, tmpDir } from './_tmp';

const sample = (cpuMain: number, cpuRenderer: number, rss: number, footprint: number | null = rss - 60) => ({
  at: 0,
  cpu: { main: cpuMain, renderer: cpuRenderer, gpu: null },
  rssMb: { main: rss, renderer: 0, gpu: null, total: rss },
  footprintMb: footprint,
  snapshotBytes: 0,
  eventsPerSec: 0,
  bytesReadPerSec: 0,
  visibility: 'visible',
});
const report = (o: Partial<Record<string, unknown>> = {}) => ({
  mode: 'app',
  machine: { cpuModel: 'Apple M3 Pro', cores: 11, memGb: 18, os: 'darwin' },
  firstSnapshotMs: 900,
  maxSnapshotBytes: 50 * 1024,
  rssTrend: [
    [0, 200],
    [55, 230],
  ],
  phases: [
    { name: 'visible', durationMs: 100_000, samples: 100, avg: sample(3, 12, 250), p95: sample(6, 20, 280) },
    { name: 'hidden', durationMs: 20_000, samples: 20, avg: sample(0.4, 0.1, 240), p95: sample(1, 0.2, 260) },
  ],
  renderer: {
    geometries: 40,
    textures: 5,
    fpsAvg: 58,
    fpsActive: 59.5,
    fpsIdle: 4,
    geometriesFirst: 39,
    texturesFirst: 5,
    orphanGeometries: 0,
  },
  ...o,
});

describe('budget', () => {
  it('aktif senaryo: uygulama modunda tüm kurallar değerlendirilir ve geçer', () => {
    const rows = evaluate(report(), 'active');
    expect(rows.map((r) => r.key)).toEqual([
      'mainCpuActive',
      'rendererCpuActive',
      'hiddenCpuTotal',
      'footprintTotal',
      'rssTotal',
      'snapshotBytes',
      'fpsActive',
      'fpsIdle',
      'geometryOrphans',
    ]);
    expect(rows.every((r) => r.status === 'ok')).toBe(true);
  });

  it('aşım fail, ölçülemeyen n/a; fps ">=" kuralı', () => {
    const r = report({ renderer: { geometries: 1, textures: 1, fpsAvg: 30 }, maxSnapshotBytes: 300 * 1024 });
    const rows = evaluate({ ...r, phases: (r.phases as unknown[]).slice(0, 1) }, 'active');
    const by = Object.fromEntries(rows.map((x) => [x.key, x.status]));
    expect(by).toMatchObject({ fpsActive: 'fail', snapshotBytes: 'fail', hiddenCpuTotal: 'n/a', mainCpuActive: 'ok' });
  });

  it('başsız mod renderer/fps/toplam RSS kurallarını atlar; soak trendi', () => {
    const keys = evaluate(report({ mode: 'headless' }), 'active').map((r) => r.key);
    expect(keys).not.toContain('rendererCpuActive');
    expect(keys).not.toContain('fpsActive');
    expect(keys).toContain('engineRss');
    const soak = evaluate(report(), 'soak').find((r) => r.key === 'soakRssGrowth');
    expect(soak).toMatchObject({ value: 30, status: 'ok' });
  });

  it('bellek bütçesi footprint ile; RSS aşımı yalnızca bilgi ve exit kodunu etkilemez', () => {
    const phases = [
      { name: 'visible', durationMs: 1, samples: 1, avg: sample(1, 1, 400, 300), p95: sample(1, 1, 460, 320) },
    ];
    const rows = evaluate(report({ phases }), 'active');
    const by = Object.fromEntries(rows.map((x) => [x.key, x]));
    expect(by['footprintTotal']).toMatchObject({ value: 320, status: 'ok' });
    expect(by['rssTotal']).toMatchObject({ value: 460, status: 'info' });
    expect(rows.filter((x) => x.status === 'fail')).toEqual([]);
    expect(formatTable(rows)).toContain('bilgi');
    const over = evaluate(report({ phases: [{ ...phases[0], p95: sample(1, 1, 460, 380) }] }), 'active').find(
      (x) => x.key === 'footprintTotal',
    );
    expect(over?.status).toBe('fail');
    const old = evaluate(report({ phases: [{ ...phases[0], p95: sample(1, 1, 460, null) }] }), 'active');
    expect(old.find((x) => x.key === 'footprintTotal')?.status).toBe('n/a');
  });

  it('büyük klasör: ilk snapshot eşiği', () => {
    expect(evaluate(report({ firstSnapshotMs: 1800 }), 'big').find((r) => r.key === 'firstSnapshotBig')?.status).toBe(
      'fail',
    );
  });

  it('referans makine ve tablo biçimi', () => {
    expect(isReferenceMachine({ cpuModel: 'Apple M3' })).toBe(true);
    expect(isReferenceMachine({ cpuModel: 'Apple M1 Max' })).toBe(false);
    const t = formatTable(evaluate(report(), 'active'));
    expect(t).toContain('✓');
    expect(t).toContain('KB');
    expect(BUDGET.length).toBeGreaterThanOrEqual(9);
  });
});

describe('replay döngüsü (bench)', () => {
  it('withVariant: session kimliği korunur, kayıt/mesaj/araç kimlikleri değişir; 0 → aynen', () => {
    const sid = '11111111-0000-4000-8000-000000000001';
    const line = {
      sessionId: sid,
      uuid: '22222222-0000-4000-8000-000000000002',
      message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'toolu_9' }] },
    };
    const keep = new Set([sid]);
    expect(withVariant(line, 0, keep)).toBe(line);
    const v = withVariant(line, 3, keep);
    expect(v.sessionId).toBe(sid);
    expect(v.uuid).not.toBe(line.uuid);
    expect(v.message.id).toBe('msg_v3_1');
    expect(v.message.content[0]?.id).toBe('toolu_v3_9');
    expect(withVariant(line, 4, keep).uuid).not.toBe(v.uuid);
  });

  it("gerçek fixture: iki döngü aynı session dosyasına yeni uuid'lerle yazar; maxGapMs bekleme üst sınırı", async () => {
    const fx = path.join(REPO_ROOT, 'fixtures', 'subagents-team');
    const target = tmpDir('diji-bench-');
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
    };
    const S = Date.parse('2026-10-28T12:00:00.000Z');
    await replay({ fixtureDir: fx, targetDir: target, speed: 5, sleep, maxGapMs: 400, allocPid: () => 1, startMs: S });
    const before = waits.reduce((a, b) => a + b, 0);
    await replay({
      fixtureDir: fx,
      targetDir: target,
      speed: 5,
      sleep,
      maxGapMs: 400,
      allocPid: () => 1,
      variant: 1,
      startMs: S + before,
    });
    expect(Math.max(...waits)).toBeLessThanOrEqual(400);
    const lines = [...readTree(target)]
      .filter(([p]) => p.endsWith('.jsonl'))
      .flatMap(([, t]) =>
        t
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l)),
      );
    const uuids = lines.map((l) => l.uuid).filter(Boolean);
    expect(new Set(uuids).size).toBe(uuids.length);
    const sids = new Set(lines.map((l) => l.sessionId));
    expect(sids.size).toBe(1);
    expect([...sids][0]).toBe([...sessionIdsOf(JSON.parse(readTree(fx).get('timeline.json') ?? '[]'))][0]);
    // Atlanan süre zaman damgalarından düşülür: son kayıt, gerçekten beklenen toplam sürenin ötesine geçmez.
    const last = Math.max(...lines.map((l) => Date.parse(l.timestamp)).filter(Number.isFinite));
    expect(last).toBeLessThanOrEqual(S + waits.reduce((a, b) => a + b, 0) + 1);
  });

  it('abort uzun bir bekleme sırasında hemen bitirir', async () => {
    const fx = path.join(REPO_ROOT, 'fixtures', 'subagents-team');
    const ac = new AbortController();
    const t0 = Date.now();
    const p = replay({
      fixtureDir: fx,
      targetDir: tmpDir('diji-bench-'),
      speed: 1,
      signal: ac.signal,
      allocPid: () => 1,
    });
    setTimeout(() => ac.abort(), 50);
    await p;
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe('formatTable yuvarlama', () => {
  it('kayan nokta toplamı tek ondalıkla yazılır', async () => {
    const { evaluate: ev, formatTable: ft } = await import('../../scripts/lib/budget.mjs');
    const r = {
      machine: { cpuModel: 'x', cores: 1, memGb: 1, os: 'x' },
      firstSnapshotMs: 1,
      maxSnapshotBytes: 1,
      phases: [
        {
          name: 'visible',
          durationMs: 1,
          samples: 1,
          avg: { cpu: { main: 0.1, renderer: 0.2, gpu: 0 }, rssMb: { main: 1, renderer: 1, gpu: 1, total: 3 } },
          p95: { cpu: { main: 0.1, renderer: 0.2, gpu: 0 }, rssMb: { main: 1, renderer: 1, gpu: 1, total: 3 } },
        },
      ],
    };
    const out = ft(ev(r as never, 'idle'));
    expect(out).toContain('0.3 %');
    expect(out).not.toContain('0.30000000000000004');
  });
});
