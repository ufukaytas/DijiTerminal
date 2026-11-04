import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudePaths, type ClaudePaths } from '../../src/main/engine/paths';
import { parseEntry, RegistryWatcher, type RegistryDiff } from '../../src/main/engine/registry';
import { bumpMtime, FIXTURES, tmpDir, waitFor } from './_wait';

const REG = path.join(FIXTURES, 'registry');
const fx = (name: string) => JSON.parse(fs.readFileSync(path.join(REG, name), 'utf8')) as Record<string, unknown>;

let root: string;
let paths: ClaudePaths;
let alive: Set<number>;
let watchers: RegistryWatcher[];

/** Fixture'ı sessions/<pid>.json olarak yazar. */
function put(name: string, override: Record<string, unknown> = {}): string {
  const j = { ...fx(name), ...override };
  const file = path.join(paths.sessions, `${String(j['pid'])}.json`);
  fs.mkdirSync(paths.sessions, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(j));
  return file;
}

function make(opts: ConstructorParameters<typeof RegistryWatcher>[1] = {}): RegistryWatcher {
  const w = new RegistryWatcher(paths, {
    pollMs: 100,
    now: () => 1793161000000,
    isAlive: (pid) => alive.has(pid),
    processStartMs: async () => null,
    ...opts,
  });
  watchers.push(w);
  return w;
}

beforeEach(() => {
  root = tmpDir('diji-reg-');
  paths = claudePaths({ configDir: root });
  alive = new Set([41001, 41002, 41003, 41004, 41005, 41006, 41007]);
  watchers = [];
});
afterEach(async () => {
  for (const w of watchers) await w.stop();
  vi.restoreAllMocks();
});

describe('parseEntry', () => {
  it('zorunlu alanlar yoksa null', () => {
    expect(parseEntry({ pid: 1 }, 'f')).toBeNull();
    expect(parseEntry({ sessionId: 'x' }, 'f')).toBeNull();
    expect(parseEntry([], 'f')).toBeNull();
  });
  it('shell → idle, saniye cinsinden zamanlar ms olur', () => {
    const p = parseEntry(fx('interactive-shell.json'), 'f');
    expect(p?.entry.status).toBe('idle');
    expect(p?.entry.rawStatus).toBe('shell');
    expect(p?.entry.startedAt).toBe(1793160000000);
    expect(p?.entry.updatedAt).toBe(1793160300000);
  });
  it('bilinmeyen status busy sayılır', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(parseEntry({ ...fx('interactive-busy.json'), status: 'thinking-hard' }, 'f')?.entry.status).toBe('busy');
    expect(warn).toHaveBeenCalledOnce();
  });
  it('waitingFor ham metin olarak saklanır; statusSince = statusUpdatedAt', () => {
    const p = parseEntry(fx('interactive-waiting.json'), 'f');
    expect(p?.entry.waitingForRaw).toBe('Bash');
    expect(p?.entry.statusSince).toBe(1793160290000);
  });
});

describe('RegistryWatcher', () => {
  it('yalnızca canlı interaktif sohbetler listelenir', async () => {
    for (const f of ['interactive-busy.json', 'interactive-waiting.json', 'interactive-shell.json', 'spare.json', 'background-kind.json', 'hosted.json']) put(f);
    const w = make();
    const diffs: RegistryDiff[] = [];
    w.on('change', (d) => diffs.push(d));
    await w.start();
    const list = w.list().sort((a, b) => a.pid - b.pid);
    expect(list.map((e) => [e.pid, e.status])).toEqual([
      [41001, 'busy'],
      [41002, 'waiting'],
      [41003, 'idle'],
    ]);
    expect(diffs[0]?.added).toHaveLength(3);
    expect(w.get('22222222-2222-4222-8222-222222222222')?.cwd).toBe('/Users/demo/Projects/demo-api');
  });

  it('ölü pid listede yok; ölünce removed olayı', async () => {
    put('interactive-busy.json');
    put('interactive-waiting.json');
    alive.delete(41002);
    const w = make();
    await w.start();
    expect(w.list().map((e) => e.pid)).toEqual([41001]);
    const diffs: RegistryDiff[] = [];
    w.on('change', (d) => diffs.push(d));
    alive.delete(41001);
    await w.refresh();
    expect(w.list()).toEqual([]);
    expect(diffs[0]?.removed).toEqual([{ sessionId: '11111111-1111-4111-8111-111111111111', pid: 41001, endedAt: 1793161000000 }]);
  });

  it('PID reuse: başlangıç zamanı > 5 sn farklıysa ölü sayılır', async () => {
    put('interactive-busy.json'); // startedAt 1793160000000
    put('interactive-waiting.json');
    const w = make({
      processStartMs: async (pid) => (pid === 41001 ? 1793160000000 + 60_000 : 1793160000000 + 1200),
    });
    await w.start();
    expect(w.list().map((e) => e.pid)).toEqual([41002]);
  });

  it('procStart: canlı belirteç eşleşirse ps çağrılmaz; farklıysa pid reuse', async () => {
    put('interactive-busy.json');
    put('interactive-waiting.json');
    // Fixture'lara procStart ekle (yeni Claude Code sürümleri yazar).
    for (const f of fs.readdirSync(paths.sessions)) {
      const p = path.join(paths.sessions, f);
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      j.procStart = String(j.pid === 41001 ? 347 : 900);
      fs.writeFileSync(p, JSON.stringify(j));
    }
    let psCalls = 0;
    const w = make({
      procStartToken: async (pid) => (pid === 41001 ? '347' : '901'),
      processStartMs: async () => {
        psCalls++;
        return null;
      },
    });
    await w.start();
    expect(w.list().map((e) => e.pid)).toEqual([41001]);
    expect(w.list()[0]?.procStart).toBe('347');
    expect(psCalls).toBe(0);
  });

  it('procStart var ama platform belirteci yok (null) → ps lstart yoluna düşer', async () => {
    put('interactive-busy.json');
    const p = path.join(paths.sessions, fs.readdirSync(paths.sessions)[0] as string);
    fs.writeFileSync(p, JSON.stringify({ ...JSON.parse(fs.readFileSync(p, 'utf8')), procStart: '12345' }));
    const w = make({ procStartToken: async () => null, processStartMs: async () => 1793160000000 + 60_000 });
    await w.start();
    expect(w.list()).toEqual([]);
  });

  it('ps başarısızsa (null) yalnızca isAlive\'a güvenilir', async () => {
    put('interactive-busy.json');
    const w = make({ processStartMs: async () => null });
    await w.start();
    expect(w.list()).toHaveLength(1);
  });

  it('aynı pid\'de yeni sessionId → superseded', async () => {
    const file = put('superseded-a.json');
    const w = make();
    await w.start();
    expect(w.list().map((e) => e.sessionId)).toEqual(['77777777-7777-4777-8777-777777777777']);
    const diffs: RegistryDiff[] = [];
    w.on('change', (d) => diffs.push(d));
    fs.writeFileSync(file, JSON.stringify(fx('superseded-b.json')));
    bumpMtime(file);
    await w.refresh();
    const d = diffs.find((x) => x.superseded.length);
    expect(d?.superseded).toEqual([{ from: '77777777-7777-4777-8777-777777777777', to: '88888888-8888-4888-8888-888888888888' }]);
    expect(w.list().map((e) => e.sessionId)).toEqual(['88888888-8888-4888-8888-888888888888']);
  });

  it('aynı session iki canlı süreçte: updatedAt yeni olan kazanır', async () => {
    put('interactive-busy.json', { pid: 41001, updatedAt: 1793160000500 });
    put('interactive-busy.json', { pid: 41002, updatedAt: 1793160999000, status: 'waiting' });
    const w = make();
    await w.start();
    expect(w.list()).toHaveLength(1);
    expect(w.list()[0]?.pid).toBe(41002);
  });

  it('mtime değişmezse dosya yeniden okunmaz; hiç yazma yapılmaz', async () => {
    put('interactive-busy.json');
    put('interactive-waiting.json');
    const read = vi.spyOn(fs.promises, 'readFile');
    const write = vi.spyOn(fs.promises, 'writeFile');
    const w = make();
    await w.start();
    const first = read.mock.calls.length;
    expect(first).toBe(2);
    await w.refresh();
    await w.refresh();
    expect(read.mock.calls.length).toBe(first);
    expect(write).not.toHaveBeenCalled();
  });

  it('yarım yazılmış JSON atlanır, sonraki taramada okunur', async () => {
    fs.mkdirSync(paths.sessions, { recursive: true });
    const file = path.join(paths.sessions, '41001.json');
    fs.writeFileSync(file, '{"pid":41001,"sessionId":"1111');
    const w = make();
    await w.start();
    expect(w.list()).toEqual([]);
    fs.writeFileSync(file, JSON.stringify(fx('interactive-busy.json')));
    bumpMtime(file);
    await w.refresh();
    expect(w.list()).toHaveLength(1);
  });

  it('status değişince fs olayıyla updated gelir', async () => {
    const file = put('interactive-busy.json');
    const w = make({ pollMs: 60_000 }); // yedek poll yok: yalnızca chokidar
    await w.start();
    const diffs: RegistryDiff[] = [];
    w.on('change', (d) => diffs.push(d));
    await new Promise((r) => setTimeout(r, 300)); // watcher hazır olsun
    fs.writeFileSync(file, JSON.stringify({ ...fx('interactive-busy.json'), status: 'waiting', waitingFor: 'Edit' }));
    await waitFor(() => diffs.some((d) => d.updated.length > 0), 5000);
    expect(w.get('11111111-1111-4111-8111-111111111111')?.status).toBe('waiting');
  });

  it('sessions klasörü yoksa boş; oluşunca kendiliğinden başlar', async () => {
    const w = make({ pollMs: 50 });
    await w.start();
    expect(w.list()).toEqual([]);
    put('interactive-busy.json');
    await waitFor(() => w.list().length === 1, 5000);
  });

  it('isimsiz ve kaynak dışı dosyalar yok sayılır', async () => {
    put('interactive-busy.json');
    fs.writeFileSync(path.join(paths.sessions, 'notes.json'), '{}');
    fs.writeFileSync(path.join(paths.sessions, '41009.json.tmp'), '{}');
    const w = make();
    await w.start();
    expect(w.list()).toHaveLength(1);
  });
});
