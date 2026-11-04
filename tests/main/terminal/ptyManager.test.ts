// 07/01: PtyManager — açma/yeniden kullanma, birleştirme, gizliyken tampon, kapatma, çıkış sınıflandırması.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyExit, PtyManager, type OpenRequest, type PtyProcess, type PtySpawn } from '@main/terminal/ptyManager';

class FakeProc implements PtyProcess {
  static n = 100;
  readonly pid = FakeProc.n++;
  dataCbs: ((d: string) => void)[] = [];
  exitCbs: ((e: { exitCode: number }) => void)[] = [];
  writes: string[] = [];
  sizes: [number, number][] = [];
  kills: string[] = [];
  onData(cb: (d: string) => void) {
    this.dataCbs.push(cb);
    return { dispose: () => (this.dataCbs = this.dataCbs.filter((x) => x !== cb)) };
  }
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exitCbs.push(cb);
    return { dispose: () => (this.exitCbs = this.exitCbs.filter((x) => x !== cb)) };
  }
  write(d: string) {
    this.writes.push(d);
  }
  resize(c: number, r: number) {
    this.sizes.push([c, r]);
  }
  kill(sig?: string) {
    this.kills.push(sig ?? 'SIGTERM');
  }
  emit(d: string) {
    for (const cb of this.dataCbs) cb(d);
  }
  exit(code = 0) {
    for (const cb of [...this.exitCbs]) cb({ exitCode: code });
  }
}

const SID = '11111111-1111-4111-8111-111111111111';
const SID2 = '22222222-2222-4222-8222-222222222222';
const req = (sessionId = SID, bgId = '0a1b2c3d'): OpenRequest => ({
  sessionId,
  bgId,
  cwd: '/tmp',
  cols: 100,
  rows: 30,
  claudePath: '/opt/claude',
  env: { TERM: 'xterm-256color' },
});

let procs: FakeProc[];
let spawnCalls: [string, string[], unknown][];
let data: [string, string][];
let exits: [string, string, number | null][];
let still: boolean;
let ids: number;

function make(extra: Partial<ConstructorParameters<typeof PtyManager>[0]> = {}): PtyManager {
  const spawn: PtySpawn = async (file, args, opts) => {
    spawnCalls.push([file, args, opts]);
    const p = new FakeProc();
    procs.push(p);
    return p;
  };
  return new PtyManager({
    spawn,
    flushMs: 16,
    newId: () => `t-${(ids++).toString(16).padStart(8, '0')}`,
    stillBackground: () => still,
    onData: (t, d) => data.push([t, d]),
    onExit: (t, r, c) => exits.push([t, r, c]),
    ...extra,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  procs = [];
  spawnCalls = [];
  data = [];
  exits = [];
  still = true;
  ids = 1;
});
afterEach(() => vi.useRealTimers());

describe('PtyManager', () => {
  it('claude attach <id> argv ile, shell olmadan başlar; aynı session ikinci kez açılınca sekme yeniden kullanılır', async () => {
    const m = make();
    const a = await m.open(req());
    expect(a).toEqual({ ok: true, termId: 't-00000001', reused: false });
    expect(spawnCalls[0]).toEqual([
      '/opt/claude',
      ['attach', '0a1b2c3d'],
      { name: 'xterm-256color', cols: 100, rows: 30, cwd: '/tmp', env: { TERM: 'xterm-256color' } },
    ]);
    expect(await m.open(req())).toEqual({ ok: true, termId: 't-00000001', reused: true });
    expect(spawnCalls).toHaveLength(1);
  });

  it("çıktı ≈16 ms birleştirilip tek mesaj olur; yazma ve resize (debounce) pty'ye gider", async () => {
    const m = make();
    const r = await m.open(req());
    const id = r.ok ? r.termId : '';
    procs[0]?.emit('a');
    procs[0]?.emit('b');
    expect(data).toHaveLength(0);
    vi.advanceTimersByTime(16);
    expect(data).toEqual([[id, 'ab']]);
    expect(m.write(id, 'x')).toBe(true);
    expect(procs[0]?.writes).toEqual(['x']);
    m.resize(id, 80, 20);
    m.resize(id, 90, 25);
    vi.advanceTimersByTime(50);
    expect(procs[0]?.sizes).toEqual([[90, 25]]);
    expect(m.write('t-ffffffff', 'x')).toBe(false);
  });

  it('gizliyken tampona alır, görünür olunca tek parça gönderir; taşmada sıfırlar ve yeniden çizdirir', async () => {
    const m = make({ bufferBytes: 10 });
    const r = await m.open(req());
    const id = r.ok ? r.termId : '';
    m.setVisible(false);
    procs[0]?.emit('12345');
    vi.advanceTimersByTime(100);
    expect(data).toHaveLength(0);
    m.setVisible(true);
    expect(data).toEqual([[id, '12345']]);
    m.setVisible(false);
    procs[0]?.emit('123456789012');
    procs[0]?.emit('xyz');
    m.setVisible(true);
    expect(data[1]).toEqual([id, '\x1bc']);
    expect(procs[0]?.sizes[0]).toEqual([99, 30]);
    vi.advanceTimersByTime(80);
    expect(procs[0]?.sizes[1]).toEqual([100, 30]);
  });

  it('kapatma: SIGHUP, süre dolunca SIGKILL; çıkış "closed"', async () => {
    const m = make();
    const r = await m.open(req());
    const id = r.ok ? r.termId : '';
    m.close(id);
    expect(procs[0]?.kills).toEqual(['SIGHUP']);
    vi.advanceTimersByTime(2000);
    expect(procs[0]?.kills).toEqual(['SIGHUP', 'SIGKILL']);
    procs[0]?.exit(0);
    expect(exits).toEqual([[id, 'closed', 0]]);
    expect(m.has(id)).toBe(false);
  });

  it('kullanıcı kapatmadan çıkış: session hâlâ arka plandaysa "taken-over", yeniden bağlanma aynı sekme kimliğiyle', async () => {
    const m = make();
    const r = await m.open(req());
    const id = r.ok ? r.termId : '';
    procs[0]?.exit(0);
    expect(exits).toEqual([[id, 'taken-over', 0]]);
    expect(m.openCount()).toBe(0);
    expect(spawnCalls).toHaveLength(1);
    const again = await m.open(req());
    expect(again).toEqual({ ok: true, termId: id, reused: true });
    expect(spawnCalls).toHaveLength(2);
    // Eski sürecin geç gelen çıkışı yeni bağlantıyı etkilemez.
    procs[0]?.exit(1);
    expect(exits).toHaveLength(1);
  });

  it('"No session" çıktısı → not-found; session arka planda değilse → exited', async () => {
    const m = make();
    await m.open(req());
    procs[0]?.emit('\x1b[31mNo session matches 0a1b2c3d\x1b[0m\r\n');
    procs[0]?.exit(1);
    expect(exits[0]?.[1]).toBe('not-found');
    still = false;
    await m.open(req(SID2, '1a2b3c4d'));
    procs[1]?.exit(1);
    expect(exits[1]?.[1]).toBe('exited');
  });

  it('en fazla maxOpen canlı sekme; spawn hatası sekme bırakmaz', async () => {
    const m = make({ maxOpen: 1 });
    await m.open(req());
    expect(await m.open(req(SID2))).toMatchObject({ ok: false, error: 'limit' });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = new PtyManager({
      spawn: async () => Promise.reject(new Error('posix_spawnp failed')),
      onData: () => undefined,
      onExit: () => undefined,
    });
    expect(await broken.open(req())).toMatchObject({ ok: false, error: 'spawn-failed' });
    expect(broken.openCount()).toBe(0);
    expect(broken.tabOf(SID)).toBeNull();
    err.mockRestore();
  });

  it('closeAll bütün istemcilere SIGHUP gönderir', async () => {
    const m = make();
    await m.open(req());
    await m.open(req(SID2, '1a2b3c4d'));
    m.closeAll();
    expect(procs.map((p) => p.kills[0])).toEqual(['SIGHUP', 'SIGHUP']);
    expect(m.openCount()).toBe(0);
  });
});

describe('classifyExit', () => {
  it('öncelik sırası', () => {
    expect(classifyExit({ closing: true, tail: 'No session' }, true)).toBe('closed');
    expect(classifyExit({ closing: false, tail: 'error: ENOJOB' }, true)).toBe('not-found');
    expect(classifyExit({ closing: false, tail: '' }, true)).toBe('taken-over');
    expect(classifyExit({ closing: false, tail: '' }, false)).toBe('exited');
  });
});

describe('redraw', () => {
  it('sekmeye dönünce cols-1 → cols resize ile yeniden çizdirir; saniyede en fazla bir kez', async () => {
    procs = [];
    spawnCalls = [];
    const m = make();
    const r = await m.open(req());
    const id = r.ok ? r.termId : '';
    vi.setSystemTime(10_000);
    expect(m.redraw(id)).toBe(true);
    expect(procs[0]?.sizes).toEqual([[99, 30]]);
    vi.advanceTimersByTime(80);
    expect(procs[0]?.sizes).toEqual([
      [99, 30],
      [100, 30],
    ]);
    m.redraw(id);
    expect(procs[0]?.sizes).toHaveLength(2);
    vi.setSystemTime(11_500);
    m.redraw(id);
    expect(procs[0]?.sizes).toHaveLength(3);
    expect(m.redraw('t-ffffffff')).toBe(false);
  });
});
