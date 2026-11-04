import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudePaths, type ClaudePaths } from '../../../src/main/engine/paths';
import { orderForBoot, TranscriptPool, type RecordsBatch } from '../../../src/main/engine/transcript/pool';
import { copyDir, FIXTURES, tmpDir, waitFor } from '../_wait';

const ENC = '-Users-demo-Projects-demo-app';

let root: string;
let paths: ClaudePaths;
let pools: TranscriptPool[];

function make(): { pool: TranscriptPool; batches: RecordsBatch[]; supersedes: { from: string; to: string }[] } {
  const pool = new TranscriptPool(paths, { debounceMs: 20, activeIntervalMs: 60_000, scanIntervalMs: 60_000 });
  pools.push(pool);
  const batches: RecordsBatch[] = [];
  const supersedes: { from: string; to: string }[] = [];
  pool.on('records', (b) => batches.push(b));
  pool.on('supersede', (s) => supersedes.push(s));
  return { pool, batches, supersedes };
}

const uuids = (bs: RecordsBatch[]) => bs.flatMap((b) => b.records.map((r) => r['uuid']));

beforeEach(() => {
  root = tmpDir('diji-pool-');
  paths = claudePaths({ configDir: root });
  pools = [];
});
afterEach(async () => {
  for (const p of pools) await p.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('TranscriptPool', () => {
  it('resume: kopyalanan kayıtlar atlanır, supersede bir kez yayınlanır', async () => {
    const src = path.join(FIXTURES, 'transcripts', 'resumed', ENC);
    const dest = path.join(paths.projects, ENC);
    fs.mkdirSync(dest, { recursive: true });
    const A = 'b2b2b2b2-0000-4000-8000-00000000000a';
    const B = 'b2b2b2b2-0000-4000-8000-00000000000b';
    // copyFileSync değil: macOS'ta oluşturulma zamanını kaynaktan taşıyor, sıralama bozuluyor.
    // Yeni dosya yazmak gerçek resume'u taklit eder: B, A'dan sonra doğar.
    const fresh = (name: string) => fs.writeFileSync(path.join(dest, name), fs.readFileSync(path.join(src, name)));
    fresh(`${A}.jsonl`);
    await new Promise((r) => setTimeout(r, 30));
    fresh(`${B}.jsonl`);

    const { pool, batches, supersedes } = make();
    await pool.boot(0);
    const bySid = (sid: string) => uuids(batches.filter((b) => b.sessionId === sid));
    expect(bySid(A)).toHaveLength(3);
    expect(bySid(B)).toEqual(['00000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-000000000008']);
    expect(supersedes).toEqual([{ from: A, to: B }]);
    expect(pool.stats().owners).toBe(5);
  });

  it('subagent: iki yol düzeni de agentId ile gelir', async () => {
    copyDir(path.join(FIXTURES, 'transcripts', 'subagents'), paths.projects);
    copyDir(path.join(FIXTURES, 'transcripts', 'subagents-nometa'), paths.projects);
    const { pool, batches, supersedes } = make();
    await pool.boot(0);
    const key = (b: RecordsBatch) => `${b.sessionId}/${String(b.agentId)}`;
    const seen = new Map(batches.map((b) => [key(b), b.records.length]));
    expect(Object.fromEntries(seen)).toEqual({
      'c3c3c3c3-0000-4000-8000-000000000001/null': 3,
      'c3c3c3c3-0000-4000-8000-000000000001/a1b2c3': 3,
      'c3c3c3c3-0000-4000-8000-000000000001/d4e5f6': 2,
      'd4d4d4d4-0000-4000-8000-000000000001/null': 2,
      'd4d4d4d4-0000-4000-8000-000000000001/0f9e8d': 2,
    });
    expect(supersedes).toEqual([]);
    expect(pool.stats().files).toBe(5); // .meta.json okunmaz
  });

  it('dayStart: eski dosyalar boot\'ta okunmaz, extraFiles ile okunur', async () => {
    copyDir(path.join(FIXTURES, 'transcripts', 'subagents-nometa'), paths.projects);
    const main = path.join(paths.projects, ENC, 'd4d4d4d4-0000-4000-8000-000000000001.jsonl');
    const old = new Date(Date.now() - 3 * 86_400_000);
    for (const f of [main, path.join(paths.projects, ENC, 'd4d4d4d4-0000-4000-8000-000000000001', 'agent-0f9e8d.jsonl')]) fs.utimesSync(f, old, old);
    const { pool, batches } = make();
    await pool.boot(Date.now() - 86_400_000, [main]);
    expect(batches.map((b) => [b.sessionId, b.agentId])).toEqual([['d4d4d4d4-0000-4000-8000-000000000001', null]]);
  });

  it('memory ve noktalı klasörler taranmaz', async () => {
    const d = path.join(paths.projects, ENC);
    fs.mkdirSync(path.join(d, 'memory'), { recursive: true });
    fs.mkdirSync(path.join(d, '.cache'), { recursive: true });
    const line = '{"type":"user","uuid":"m","timestamp":"2026-10-28T09:00:00.000Z"}\n';
    fs.writeFileSync(path.join(d, 'memory', 'x.jsonl'), line);
    fs.writeFileSync(path.join(d, '.cache', 'y.jsonl'), line);
    const { pool, batches } = make();
    await pool.boot(0);
    expect(batches).toEqual([]);
  });

  it('watch: yeni dosya ve ekleme 5 sn içinde gelir; silinen dosya bırakılır', async () => {
    const d = path.join(paths.projects, ENC);
    fs.mkdirSync(d, { recursive: true });
    const f = path.join(d, 'e5e5e5e5-0000-4000-8000-000000000001.jsonl');
    fs.writeFileSync(f, '{"type":"user","uuid":"w-1","timestamp":"2026-10-28T09:00:00.000Z"}\n');
    const { pool, batches } = make();
    const added: string[] = [];
    pool.on('file-added', (p) => added.push(p));
    await pool.boot(0);
    expect(uuids(batches)).toEqual(['w-1']);
    pool.watch();
    await new Promise((r) => setTimeout(r, 300));

    fs.appendFileSync(f, '{"type":"assistant","uuid":"w-2","timestamp":"2026-10-28T09:00:01.000Z"}\n');
    await waitFor(() => uuids(batches).includes('w-2'));

    const sub = path.join(d, 'e5e5e5e5-0000-4000-8000-000000000001', 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    const sf = path.join(sub, 'agent-77aa.jsonl');
    fs.writeFileSync(sf, '{"type":"user","uuid":"w-3","isSidechain":true,"timestamp":"2026-10-28T09:00:02.000Z"}\n');
    await waitFor(() => uuids(batches).includes('w-3'));
    expect(added).toContain(sf);
    expect(batches.find((b) => b.path === sf)?.agentId).toBe('77aa');

    const before = pool.stats().files;
    fs.unlinkSync(sf);
    await waitFor(() => pool.stats().files === before - 1);
  });

  it('ensure: yeni dosya file-added yayınlar ve okunur; tekrarında olay yok', async () => {
    const d = path.join(paths.projects, ENC);
    fs.mkdirSync(d, { recursive: true });
    const f = path.join(d, 'f6f6f6f6-0000-4000-8000-000000000001.jsonl');
    fs.writeFileSync(f, '{"type":"user","uuid":"e-1","timestamp":"2026-10-28T09:00:00.000Z"}\n');
    const { pool, batches } = make();
    const added: string[] = [];
    pool.on('file-added', (p) => added.push(p));
    await pool.ensure(f);
    await pool.ensure(f);
    expect(added).toEqual([f]);
    expect(uuids(batches)).toEqual(['e-1']);
  });

  it('kısalıp yeniden yazılan dosyada kayıtlar çift sayılmaz', async () => {
    const d = path.join(paths.projects, ENC);
    fs.mkdirSync(d, { recursive: true });
    const f = path.join(d, 'a7a7a7a7-0000-4000-8000-000000000001.jsonl');
    const l1 = '{"type":"user","uuid":"r-1","timestamp":"2026-10-28T09:00:00.000Z"}\n';
    fs.writeFileSync(f, l1 + l1.replace('r-1', 'r-2'));
    const { pool, batches } = make();
    await pool.boot(0);
    fs.writeFileSync(f, l1);
    await pool.ensure(f);
    expect(uuids(batches)).toEqual(['r-1', 'r-2']);
  });

  it('resume: oluşturulma sırası ters olsa da (geri yüklenmiş/kopyalanmış dosyalar) geçmiş asıl session\'da kalır', async () => {
    const src = path.join(FIXTURES, 'transcripts', 'resumed', ENC);
    const dest = path.join(paths.projects, ENC);
    fs.mkdirSync(dest, { recursive: true });
    const A = 'b2b2b2b2-0000-4000-8000-00000000000a';
    const B = 'b2b2b2b2-0000-4000-8000-00000000000b';
    // Yazma sırası ters: önce devam eden B, sonra asıl A → B "daha eski doğmuş" görünür.
    const fresh = (name: string) => fs.writeFileSync(path.join(dest, name), fs.readFileSync(path.join(src, name)));
    fresh(`${B}.jsonl`);
    await new Promise((r) => setTimeout(r, 30));
    fresh(`${A}.jsonl`);
    // Dosya sistemi oluşturulma zamanı tutmuyorsa (0) bile ters sırayı garanti etmek için anahtar da ters verilir.
    const born = new Map([[path.join(dest, `${B}.jsonl`), 1], [path.join(dest, `${A}.jsonl`), 2]]);
    const pool = new TranscriptPool(paths, { debounceMs: 20, activeIntervalMs: 60_000, scanIntervalMs: 60_000, birthKey: async (f) => born.get(f) ?? 0 });
    pools.push(pool);
    const batches: RecordsBatch[] = [];
    const supersedes: { from: string; to: string }[] = [];
    pool.on('records', (b) => batches.push(b));
    pool.on('supersede', (s) => supersedes.push(s));
    await pool.boot(0);
    const bySid = (sid: string) => uuids(batches.filter((b) => b.sessionId === sid));
    expect(bySid(A)).toHaveLength(3);
    expect(bySid(B)).toEqual(['00000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-000000000008']);
    expect(supersedes).toEqual([{ from: A, to: B }]);
  });

  it('orderForBoot: ilişkisiz dosyalar oluşturulma sırasını korur', async () => {
    const dest = path.join(paths.projects, ENC);
    fs.mkdirSync(dest, { recursive: true });
    const mk = (sid: string, u: string) => {
      const f = path.join(dest, `${sid}.jsonl`);
      fs.writeFileSync(f, JSON.stringify({ type: 'user', uuid: u, timestamp: '2026-01-01T00:00:00Z' }) + '\n');
      return f;
    };
    const x = mk('x', '00000000-0000-4000-8000-0000000000aa');
    const y = mk('y', '00000000-0000-4000-8000-0000000000bb');
    const born = new Map([[x, 2], [y, 1]]);
    expect(await orderForBoot([x, y], paths, async (f) => born.get(f) ?? 0)).toEqual([y, x]);
  });
});
