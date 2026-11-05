// Kullanım limitleri (02/08): parse tablosu, okuyucu davranışı, store/engine bağlantısı.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { UsageLimits } from '@shared/types';
import { isStale, LIMITS_STALE_MS, LimitsReader, parseLimits } from '@main/engine/limits';
import { SessionEngine } from '@main/engine/index';
import { tmpDir } from './_wait';

const FX = path.join(__dirname, '__fixtures__', 'limits');
const fx = (n: string): unknown => JSON.parse(fs.readFileSync(path.join(FX, n), 'utf8'));
const MT = 1_793_100_000_000;

describe('parseLimits', () => {
  it('saniye cinsinden resets_at ×1000; yüzdeler aynen', () => {
    expect(parseLimits(fx('ok-seconds.json'), MT)).toEqual({
      fiveHour: { pct: 42.5, resetsAt: 1_793_150_000_000 },
      week: { pct: 61, resetsAt: 1_793_600_000_000 },
      at: MT,
    });
  });

  it('milisaniye resets_at olduğu gibi; yüzde 0–100 aralığına kırpılır', () => {
    const l = parseLimits(fx('ok-ms.json'), MT);
    expect(l?.fiveHour?.resetsAt).toBe(1_793_150_000_000);
    expect(l?.week?.pct).toBe(100);
  });

  it('yalnızca haftalık pencere → fiveHour null', () => {
    const l = parseLimits(fx('only-week.json'), MT);
    expect(l?.fiveHour).toBeNull();
    expect(l?.week?.pct).toBe(88.2);
  });

  it('rate_limits yok ya da pencereler geçersiz → null', () => {
    expect(parseLimits(fx('no-rate-limits.json'), MT)).toBeNull();
    expect(parseLimits({ rate_limits: { five_hour: { used_percentage: 'x' } } }, MT)).toBeNull();
    expect(parseLimits(null, MT)).toBeNull();
    expect(parseLimits('metin', MT)).toBeNull();
  });

  it('isStale: 6 saat', () => {
    const l = parseLimits(fx('ok-seconds.json'), MT) as UsageLimits;
    expect(isStale(l, MT + LIMITS_STALE_MS - 1)).toBe(false);
    expect(isStale(l, MT + LIMITS_STALE_MS + 1)).toBe(true);
  });
});

describe('LimitsReader', () => {
  const dirs: string[] = [];
  const readers: LimitsReader[] = [];
  afterEach(() => {
    for (const r of readers.splice(0)) r.stop();
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  const make = (opts: { watch?: boolean } = {}) => {
    const dir = tmpDir('diji-limits-');
    dirs.push(dir);
    const file = path.join(dir, 'limits.json');
    const r = new LimitsReader({ filePath: file, pollMs: 0, watch: opts.watch ?? false });
    readers.push(r);
    const changes: (UsageLimits | null)[] = [];
    r.on('change', (l: UsageLimits | null) => changes.push(l));
    return { dir, file, r, changes };
  };
  const put = (file: string, name: string) => {
    // statusline.sh gibi: tmp + rename
    const tmp = `${file}.tmp`;
    fs.copyFileSync(path.join(FX, name), tmp);
    fs.renameSync(tmp, file);
  };

  it('dosya yoksa null, olay yok', async () => {
    const { r, changes } = make();
    await r.start();
    expect(r.current()).toBeNull();
    expect(changes).toEqual([]);
  });

  it('yazılınca değer; bozuk JSON önceki değeri korur; silinince null', async () => {
    const { file, r, changes } = make();
    await r.start();
    put(file, 'ok-seconds.json');
    await r.readNow();
    expect(r.current()?.fiveHour?.pct).toBe(42.5);
    put(file, 'broken.json');
    await r.readNow();
    expect(r.current()?.fiveHour?.pct).toBe(42.5);
    fs.rmSync(file);
    await r.readNow();
    expect(r.current()).toBeNull();
    expect(changes.map((c) => c?.fiveHour?.pct ?? null)).toEqual([42.5, null]);
  });

  it('aynı içerik ve mtime → tekrar olay yok', async () => {
    const { file, r, changes } = make();
    put(file, 'ok-seconds.json');
    await r.start();
    await r.readNow();
    await r.readNow();
    expect(changes).toHaveLength(1);
  });

  it('dizin izleme: atomik rename sonrası debounce ile okunur', async () => {
    const { file, r, changes } = make({ watch: true });
    await r.start();
    // macOS FSEvents akışı fs.watch döndükten sonra asenkron başlar; yük altında ilk rename kaçabiliyordu.
    // Üretimde yoklama yedeği var; burada (pollMs 0) olay gelene kadar atomik yazma yinelenir.
    const t0 = Date.now();
    let last = 0;
    while (changes.length === 0 && Date.now() - t0 < 5000) {
      if (Date.now() - last >= 500) {
        put(file, 'only-week.json');
        last = Date.now();
      }
      await new Promise((res) => setTimeout(res, 20));
    }
    expect(changes).toHaveLength(1);
    expect(changes[0]?.week?.pct).toBe(88.2);
  });
});

describe('SessionEngine + limits', () => {
  it('appDataDir/limits.json snapshot.limits alanına gelir', async () => {
    const root = tmpDir('diji-eng-limits-');
    const app = path.join(root, 'app');
    fs.mkdirSync(app, { recursive: true });
    fs.copyFileSync(path.join(FX, 'ok-seconds.json'), path.join(app, 'limits.json'));
    const engine = new SessionEngine({
      configDir: path.join(root, 'claude'),
      appDataDir: app,
      hookEventsPath: null,
      manual: true,
      isAlive: () => false,
      processStartMs: async () => null,
      procStartToken: async () => null,
      git: async () => null,
    });
    try {
      await engine.start();
      expect(engine.getSnapshot().limits?.week?.pct).toBe(61);
      fs.copyFileSync(path.join(FX, 'only-week.json'), path.join(app, 'limits.json'));
      const s = await engine.pumpNow();
      expect(s.limits?.fiveHour).toBeNull();
      expect(s.limits?.week?.pct).toBe(88.2);
    } finally {
      await engine.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
