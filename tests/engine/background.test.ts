// 07/01: arka plan session'ları — registry (kind "bg" + jobId), agents --json ayrıştırma ve poller, motor bağlantısı.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentsPoller,
  backgroundStates,
  parseAgentsJson,
  type AgentsEntry,
  type AgentsPollerLike,
} from '@main/engine/agents';
import type { CliExec, ExecOut, ResolvedClaude } from '@main/engine/claudeCli';
import { SessionEngine } from '@main/engine/index';
import { parseEntry } from '@main/engine/registry';
import { FIXTURES, tmpDir } from './_wait';

const REG = path.join(FIXTURES, 'registry');
const AG = path.join(FIXTURES, 'agents');
const fx = (name: string) => JSON.parse(fs.readFileSync(path.join(REG, name), 'utf8')) as Record<string, unknown>;
const agentsFx = (name: string) => fs.readFileSync(path.join(AG, name), 'utf8');

const BG_SID = '88888888-8888-4888-8888-888888888888';

describe('registry: arka plan kayıtları', () => {
  it('kind "bg" + jobId kabul edilir, jobId taşınır', () => {
    const p = parseEntry(fx('bg-job.json'), 'f');
    expect(p?.interactive).toBe(true);
    expect(p?.entry.jobId).toBe('0a1b2c3d');
  });
  it('kimliksiz ya da biçimsiz jobId → elenir (attach edilemez)', () => {
    expect(parseEntry({ ...fx('bg-job.json'), jobId: undefined }, 'f')?.interactive).toBe(false);
    expect(parseEntry({ ...fx('bg-job.json'), jobId: '../../x' }, 'f')?.interactive).toBe(false);
    expect(parseEntry(fx('background-kind.json'), 'f')?.interactive).toBe(false);
  });
  it('etkileşimli kayıtta jobId null', () => {
    expect(parseEntry(fx('interactive-busy.json'), 'f')?.entry.jobId).toBeNull();
  });
});

describe('parseAgentsJson', () => {
  it('Mac çıktısı biçimi: alanlar ve arka plan state haritası', () => {
    const list = parseAgentsJson(agentsFx('mixed.json'));
    expect(list.map((e) => [e.kind, e.state, e.status])).toEqual([
      ['background', 'failed', null],
      ['interactive', null, 'idle'],
      ['background', 'done', 'idle'],
      ['background', 'running', 'busy'],
    ]);
    expect(list[2]).toMatchObject({
      id: '0a1b2c3d',
      sessionId: BG_SID,
      pid: 41008,
      cwd: '/Users/demo/Projects/demo-app',
    });
    const m = backgroundStates(list);
    expect(m.get('0a1b2c3d')).toBe('done');
    expect(m.get('9f8e7d6c')).toBe('failed');
    expect(m.size).toBe(3);
  });
  it('bozuk girdi: boş liste; bozuk öğe atlanır; bilinmeyen değer ham tutulur ve bir kez uyarılır', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(parseAgentsJson('not json')).toEqual([]);
    expect(parseAgentsJson('{"a":1}')).toEqual([]);
    const list = parseAgentsJson(
      JSON.stringify([
        null,
        3,
        { id: 'x' },
        { id: 'aaaaaaaa', kind: 'background', state: 'paused' },
        { id: 'bbbbbbbb', kind: 'background', state: 'paused' },
      ]),
    );
    expect(list).toHaveLength(2);
    expect(list[0]?.state).toBe('paused');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
  it('id biçimine uymayan arka plan kaydı state haritasına girmez', () => {
    const m = backgroundStates(
      parseAgentsJson(JSON.stringify([{ id: 'not-hex!', kind: 'background', state: 'done' }])),
    );
    expect(m.size).toBe(0);
  });
});

const CLI: ResolvedClaude = { path: '/opt/claude', version: '2.1.312', env: {} };
const out = (stdout: string, ok = true): ExecOut => ({ ok, stdout, stderr: '', code: ok ? 0 : 1, timedOut: false });

describe('AgentsPoller', () => {
  afterEach(() => vi.useRealTimers());

  it('aralık: arka plan yokken 5 dk, varken 30 sn, gizliyken 90 sn', () => {
    const p = new AgentsPoller({ cli: async () => CLI, exec: async () => out('[]') });
    expect(p.interval()).toBe(300_000);
    p.setActive(true);
    expect(p.interval()).toBe(30_000);
    p.setSlow(true);
    expect(p.interval()).toBe(90_000);
    p.stop();
  });

  it('argv sabit, shell yok; değişmeyen sonuç yeniden yayınlanmaz', async () => {
    const calls: [string, string[]][] = [];
    const exec: CliExec = async (f, a) => {
      calls.push([f, a]);
      return out(agentsFx('mixed.json'));
    };
    const p = new AgentsPoller({ cli: async () => CLI, exec });
    const got: AgentsEntry[][] = [];
    p.onUpdate((m) => got.push(m));
    await p.pollNow();
    await p.pollNow();
    expect(calls).toEqual([
      ['/opt/claude', ['agents', '--json', '--all']],
      ['/opt/claude', ['agents', '--json', '--all']],
    ]);
    expect(got).toHaveLength(1);
    expect(p.status()).toBe('ok');
    p.stop();
  });

  it('aynı anda tek çağrı: süren çağrı sırasında gelen istekler tek bir ek çağrıya birleşir', async () => {
    let n = 0;
    let release: () => void = () => undefined;
    const exec: CliExec = () => {
      n++;
      return new Promise((r) => {
        release = () => r(out('[]'));
      });
    };
    const p = new AgentsPoller({ cli: async () => CLI, exec });
    const a = p.pollNow();
    await Promise.resolve();
    await Promise.resolve();
    void p.pollNow();
    void p.pollNow();
    release();
    await new Promise((r) => setTimeout(r, 0));
    release();
    await a;
    expect(n).toBe(2);
    p.stop();
  });

  it('art arda 3 hata → geri çekilme; claude yoksa unavailable', async () => {
    let t = 1000;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const exec = vi.fn<CliExec>(async () => out('', false));
    const p = new AgentsPoller({ cli: async () => CLI, exec, now: () => t, backoffMs: 60_000 });
    for (let i = 0; i < 4; i++) await p.pollNow();
    expect(exec).toHaveBeenCalledTimes(3);
    t += 61_000;
    await p.pollNow();
    expect(exec).toHaveBeenCalledTimes(4);
    warn.mockRestore();
    p.stop();
    const q = new AgentsPoller({ cli: async () => null, exec });
    await q.pollNow();
    expect(q.status()).toBe('unavailable');
    q.stop();
  });
});

/** Testte zamanlayıcısız, elle beslenen poller. */
class FakeAgents implements AgentsPollerLike {
  cbs = new Set<(m: AgentsEntry[]) => void>();
  active = false;
  polls = 0;
  start(): void {}
  stop(): void {}
  async pollNow(): Promise<void> {
    this.polls++;
  }
  setSlow(): void {}
  setActive(a: boolean): void {
    this.active = a;
  }
  onUpdate(cb: (m: AgentsEntry[]) => void): () => void {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }
  status() {
    return 'ok' as const;
  }
  emit(m: Partial<AgentsEntry>[]): void {
    const list = m.map((e) => ({
      id: '',
      sessionId: null,
      kind: 'background',
      pid: null,
      cwd: null,
      name: null,
      state: null,
      status: null,
      startedAt: null,
      ...e,
    }));
    for (const cb of this.cbs) cb(list);
  }
}

describe('SessionEngine: arka plan session alanı', () => {
  const engines: SessionEngine[] = [];
  afterEach(async () => {
    for (const e of engines.splice(0)) await e.stop();
  });
  it("yalnızca agents --json'da olan (registry'de olmayan) uyuyan session açılışta görünür; 24 saatten eskisi görünmez", async () => {
    const dir = tmpDir('diji-bg-');
    fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
    const now = Date.now();
    const agents = new FakeAgents();
    const e = new SessionEngine({
      configDir: dir,
      isAlive: () => true,
      processStartMs: async () => null,
      procStartToken: async () => null,
      git: async () => null,
      agents,
      manual: true,
    });
    engines.push(e);
    await e.start();
    expect(agents.polls).toBe(1); // açılışta registry'de arka plan yokken de bir kez
    agents.emit([
      { id: '2cefe1b1', sessionId: BG_SID, cwd: '/private/tmp', state: 'done', startedAt: now - 3600_000 },
      {
        id: '8594bf34',
        sessionId: '77777777-7777-4777-8777-777777777777',
        cwd: '/private/tmp',
        state: 'done',
        startedAt: now - 3 * 86_400_000,
      },
    ]);
    const snap = await e.pumpNow();
    expect(snap.sessions.map((s) => [s.id, s.status, s.background?.id])).toEqual([[BG_SID, 'idle', '2cefe1b1']]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("registry'deki arka plan session'ı background alanıyla görünür; state agents --json'dan gelir", async () => {
    const dir = tmpDir('diji-bg-');
    fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
    const now = Date.now();
    const fresh = (name: string) => ({
      ...fx(name),
      startedAt: now - 60_000,
      updatedAt: now - 1000,
      statusUpdatedAt: now - 1000,
    });
    fs.writeFileSync(path.join(dir, 'sessions', '41008.json'), JSON.stringify(fresh('bg-job.json')));
    fs.writeFileSync(path.join(dir, 'sessions', '41001.json'), JSON.stringify(fresh('interactive-busy.json')));
    const agents = new FakeAgents();
    const e = new SessionEngine({
      configDir: dir,
      isAlive: () => true,
      processStartMs: async () => null,
      procStartToken: async () => null,
      git: async () => null,
      agents,
      manual: true,
    });
    engines.push(e);
    await e.start();
    expect(agents.active).toBe(true);
    expect(agents.polls).toBeGreaterThan(0);
    let snap = await e.pumpNow();
    const bg = snap.sessions.find((s) => s.id === BG_SID);
    expect(bg?.background).toEqual({ id: '0a1b2c3d', state: null });
    expect(bg?.status).toBe('idle');
    expect(snap.sessions.find((s) => s.id !== BG_SID)?.background).toBeNull();
    expect(e.backgroundTarget(BG_SID)).toEqual({
      bgId: '0a1b2c3d',
      cwd: '/Users/demo/Projects/demo-app',
      running: true,
    });
    expect(e.backgroundTarget('22222222-2222-4222-8222-222222222222')).toBeNull();

    const listed = {
      id: '0a1b2c3d',
      sessionId: BG_SID,
      cwd: '/Users/demo/Projects/demo-app',
      pid: 41008,
      startedAt: now - 60_000,
    };
    agents.emit([{ ...listed, state: 'running' }]);
    snap = e.getSnapshot();
    expect(snap.sessions.find((s) => s.id === BG_SID)?.background?.state).toBe('running');

    // İşçi kapandı (registry dosyası silindi), agents --json'da `done` + pid null: uyuyan session olarak kalır.
    fs.rmSync(path.join(dir, 'sessions', '41008.json'));
    agents.emit([{ ...listed, pid: null, state: 'done' }]);
    snap = await e.pumpNow();
    const dormant = snap.sessions.find((s) => s.id === BG_SID);
    expect(dormant?.status).toBe('idle');
    expect(dormant?.live).toBe(false);
    expect(dormant?.background).toEqual({ id: '0a1b2c3d', state: 'done' });
    expect(e.backgroundTarget(BG_SID)).toEqual({
      bgId: '0a1b2c3d',
      cwd: '/Users/demo/Projects/demo-app',
      running: false,
    });
    expect(agents.active).toBe(true);

    // Listeden çıkınca (claude stop / rm) ya da başarısız olunca kalkar; poller pasife geçer.
    agents.emit([{ ...listed, pid: null, state: 'failed' }]);
    snap = await e.pumpNow();
    expect(e.backgroundTarget(BG_SID)).toBeNull();
    expect(snap.sessions.find((s) => s.id === BG_SID)?.status ?? 'ended').toBe('ended');
    expect(agents.active).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("SessionEngine: kapatılan arka plan session'ları", () => {
  it('kapatılan uyuyan session haritadan kalkar ve kaydedilir; yeniden çalışınca geri gelir; listeden düşen budanır', async () => {
    const dir = tmpDir('diji-bg-');
    fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
    const now = Date.now();
    const agents = new FakeAgents();
    const saved: string[][] = [];
    const e = new SessionEngine({
      configDir: dir,
      isAlive: () => true,
      processStartMs: async () => null,
      procStartToken: async () => null,
      git: async () => null,
      agents,
      manual: true,
      dismissedBackground: ['deadbeef'],
      onDismissedChange: (ids) => saved.push(ids),
    });
    await e.start();
    const listed = {
      id: '0a1b2c3d',
      sessionId: BG_SID,
      cwd: '/Users/demo/Projects/demo-app',
      state: 'done',
      startedAt: now - 60_000,
    };
    agents.emit([listed]);
    // 'deadbeef' listede yok → budandı.
    expect(saved.at(-1)).toEqual([]);
    expect(e.backgroundTarget(BG_SID)).toEqual({
      bgId: '0a1b2c3d',
      cwd: '/Users/demo/Projects/demo-app',
      running: false,
    });

    e.dismissBackground('0a1b2c3d');
    let snap = await e.pumpNow();
    expect(snap.sessions.find((s) => s.id === BG_SID)?.status ?? 'ended').toBe('ended');
    expect(saved.at(-1)).toEqual(['0a1b2c3d']);
    agents.emit([{ ...listed, pid: null }]);
    snap = await e.pumpNow();
    expect(snap.sessions.find((s) => s.id === BG_SID && s.status !== 'ended')).toBeUndefined();

    // iTerm2'den attach → işçi çalışıyor (registry) → yeniden görünür ve kapatma listesinden çıkar.
    fs.writeFileSync(
      path.join(dir, 'sessions', '41008.json'),
      JSON.stringify({ ...fx('bg-job.json'), startedAt: now - 60_000, updatedAt: now, statusUpdatedAt: now }),
    );
    snap = await e.pumpNow();
    expect(snap.sessions.find((s) => s.id === BG_SID)?.background?.id).toBe('0a1b2c3d');
    expect(saved.at(-1)).toEqual([]);
    await e.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('SessionEngine: geçmiş ve yeniden aktif etme', () => {
  it('haritada olmayanlar geçmişte (neden ile); aktif et haritaya getirir ve kapatılanlardan çıkarır', async () => {
    const dir = tmpDir('diji-bg-');
    fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
    const now = Date.now();
    const agents = new FakeAgents();
    const saved: string[][] = [];
    const e = new SessionEngine({
      configDir: dir,
      isAlive: () => true,
      processStartMs: async () => null,
      procStartToken: async () => null,
      git: async () => null,
      agents,
      manual: true,
      onDismissedChange: (ids) => saved.push(ids),
    });
    await e.start();
    const S2 = '77777777-7777-4777-8777-777777777777';
    const S3 = '66666666-6666-4666-8666-666666666666';
    const S4 = '55555555-5555-4555-8555-555555555555';
    agents.emit([
      { id: '0a1b2c3d', sessionId: BG_SID, cwd: '/tmp/a', state: 'done', startedAt: now - 60_000 },
      { id: '1a2b3c4d', sessionId: S2, cwd: '/tmp/b', state: 'stopped', startedAt: now - 60_000 },
      { id: '2a2b3c4d', sessionId: S3, cwd: '/tmp/c', state: 'done', startedAt: now - 3 * 86_400_000 },
      { id: '3a2b3c4d', sessionId: S4, cwd: '/tmp/d', name: 'gece işi', state: 'failed', startedAt: now - 120_000 },
    ]);
    e.dismissBackground('0a1b2c3d');
    let hist = e.backgroundHistory();
    expect(hist.map((h) => [h.id, h.reason])).toEqual([
      ['0a1b2c3d', 'closed'],
      ['1a2b3c4d', 'stopped'],
      ['3a2b3c4d', 'failed'],
      ['2a2b3c4d', 'old'],
    ]);
    expect(hist.find((h) => h.id === '3a2b3c4d')?.name).toBe('gece işi');
    expect(hist.find((h) => h.id === '1a2b3c4d')?.name).toBe('b');

    expect(e.restoreBackground('0a1b2c3d')).toBe(BG_SID);
    expect(e.restoreBackground('1a2b3c4d')).toBe(S2);
    expect(e.restoreBackground('ffffffff')).toBeNull();
    const snap = await e.pumpNow();
    const live = snap.sessions.filter((s) => s.status !== 'ended').map((s) => s.background?.id);
    expect(live.sort()).toEqual(['0a1b2c3d', '1a2b3c4d']);
    expect(saved.at(-1)).toEqual([]);
    hist = e.backgroundHistory();
    expect(hist.map((h) => h.id)).toEqual(['3a2b3c4d', '2a2b3c4d']);
    // Yeniden kapatınca geçmişe döner.
    e.dismissBackground('1a2b3c4d');
    expect(e.backgroundHistory().map((h) => h.id)).toContain('1a2b3c4d');
    await e.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
