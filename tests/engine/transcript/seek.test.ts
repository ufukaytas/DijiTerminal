import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seekToTime } from '../../../src/main/engine/transcript/seek';
import { tmpDir } from '../_wait';

const DAY = Date.parse('2026-10-28T00:00:00.000Z');
let dir: string;
let file: string;
let boundary = 0;
let size = 0;

/** ~20 MB: ilk yarısı dün, ikinci yarısı bugün. */
beforeAll(() => {
  dir = tmpDir('diji-seek-');
  file = path.join(dir, 'big.jsonl');
  const fd = fs.openSync(file, 'w');
  const pad = 'p'.repeat(900);
  let pos = 0;
  const write = (ts: number, i: number) => {
    const s = `{"type":"assistant","uuid":"u-${i}","timestamp":"${new Date(ts).toISOString()}","pad":"${pad}"}\n`;
    fs.writeSync(fd, s);
    pos += Buffer.byteLength(s);
  };
  const n = 10_500;
  for (let i = 0; i < n; i++) write(DAY - 86_400_000 + i * 1000, i);
  boundary = pos;
  for (let i = 0; i < n; i++) write(DAY + 3600_000 + i * 1000, n + i);
  fs.closeSync(fd);
  size = pos;
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('seekToTime', () => {
  it('günün başından hemen önceki bir offset döner', async () => {
    expect(size).toBeGreaterThan(19 * 1024 * 1024);
    const off = await seekToTime(file, size, DAY - 10 * 60_000);
    expect(off).toBeLessThanOrEqual(boundary);
    expect(boundary - off).toBeLessThanOrEqual(1.2 * 1024 * 1024);
  });
  it('zaman dosyadan önceyse 0', async () => {
    expect(await seekToTime(file, size, DAY - 3 * 86_400_000)).toBe(0);
  });
  it('zaman damgası olmayan dosyada güvenli taraf: 0', async () => {
    const f = path.join(dir, 'nots.jsonl');
    fs.writeFileSync(f, `${'{"a":1}\n'.repeat(400_000)}`);
    expect(await seekToTime(f, fs.statSync(f).size, DAY)).toBe(0);
  });
});
