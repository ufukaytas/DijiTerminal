// BoardStore durum kuralları — 02/07 Bölüm 4 tablosu, sahte saatle.
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@shared/settings';
import type { BoardEvent, SessionView } from '@shared/types';
import { ManualClock } from '@main/engine/clock';
import type { EngineEvent } from '@main/engine/events';
import { ProjectResolver } from '@main/engine/projects';
import type { RegistryEntry } from '@main/engine/registry';
import { BoardStore } from '@main/engine/store';
import { SubagentTracker } from '@main/engine/subagents';

const T0 = Date.parse('2026-01-01T09:00:00Z');
const DAY0 = Date.parse('2026-01-01T00:00:00Z');
const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';

function setup(opts: { hidden?: string[] } = {}) {
  const clock = new ManualClock(T0, (ts) => DAY0 + Math.floor((ts - DAY0) / 86_400_000) * 86_400_000);
  const projects = new ProjectResolver({
    git: async () => null,
    settings: () => ({ ...DEFAULT_SETTINGS, projects: Object.fromEntries((opts.hidden ?? []).map((r) => [r, { hidden: true }])) }),
    home: '/Users/demo',
    countAgents: async () => 0,
    now: () => clock.now(),
  });
  let storeRef: BoardStore | null = null;
  const tracker = new SubagentTracker({
    projectRootOf: (sid) => storeRef?.rootOf(sid) ?? null,
    now: () => clock.now(),
    readMeta: async () => null,
    agentFileExists: async () => false,
  });
  const store = new BoardStore({ clock, projects, subagents: tracker, onError: () => undefined });
  storeRef = store;
  store.setBooted(true);
  const reg = (sid: string, status: RegistryEntry['status'], extra: Partial<RegistryEntry> = {}): RegistryEntry => ({
    sessionId: sid,
    pid: sid === A ? 101 : 202,
    status,
    rawStatus: status,
    waitingForRaw: null,
    name: null,
    cwd: '/Users/demo/Projects/demo-1',
    entrypoint: 'cli',
    startedAt: T0 - 60_000,
    updatedAt: clock.now(),
    statusSince: clock.now(),
    procStart: null,
    file: `/x/${sid}.json`,
    ...extra,
  });
  const view = (sid: string): SessionView | undefined => store.snapshot().sessions.find((s) => s.id === sid);
  const drainTypes = (): string[] => store.drainEvents().map((e) => e.type);
  return { clock, store, tracker, reg, view, drainTypes };
}

const base = (sid: string, ts: number, agentId: string | null = null) => ({ sessionId: sid, agentId, ts });
const start = (sid: string, id: string, ts: number, name = 'Read', file?: string, agentId: string | null = null): EngineEvent => ({
  ...base(sid, ts, agentId),
  type: 'tool-start',
  toolUseId: id,
  name,
  category: name === 'Bash' ? 'bash' : name === 'Agent' ? 'agent' : name === 'Read' ? 'read' : 'edit',
  label: file ?? `${name} çağrısı`,
  ...(file ? { file } : {}),
});
const end = (sid: string, id: string, ts: number, ok = true, agentId: string | null = null, extra: object = {}): EngineEvent => ({
  ...base(sid, ts, agentId),
  type: 'tool-end',
  toolUseId: id,
  ok,
  ...extra,
});
const usage = (sid: string, msgId: string, ts: number, input = 1000, cacheRead = 0): EngineEvent => ({
  ...base(sid, ts),
  type: 'usage',
  msgId,
  model: 'claude-opus-5-5',
  input,
  output: 100,
  cacheRead,
  cacheWrite: 0,
  cacheWrite1h: 0,
  speed: 'standard',
});

describe('BoardStore durum kuralları', () => {
  it('registry: busy → waiting → idle; status olayları ve statusSince registry\'den', () => {
    const { store, reg, view, clock, drainTypes } = setup();
    store.applyRegistry([reg(A, 'busy')]);
    expect(view(A)?.status).toBe('busy');
    clock.advance(5000);
    store.applyRegistry([reg(A, 'waiting', { waitingForRaw: 'permission:Bash', statusSince: clock.now() - 1000 })]);
    const w = view(A)!;
    expect(w.status).toBe('waiting');
    expect(w.statusSince).toBe(clock.now() - 1000);
    expect(w.waitingFor?.tool).toBe('Bash');
    clock.advance(5000);
    store.applyRegistry([reg(A, 'idle', { rawStatus: 'shell' })]);
    expect(view(A)?.status).toBe('idle');
    expect(drainTypes().filter((t) => t === 'status')).toHaveLength(3);
  });

  it('waitingFor: registry aracı + ana ajanın bekleyen çağrısının etiketi; waitingFor yoksa son pending', () => {
    const { store, reg, view } = setup();
    store.applyRegistry([reg(A, 'busy')]);
    store.apply(start(A, 't1', T0, 'Bash', undefined));
    store.applyRegistry([reg(A, 'waiting', { waitingForRaw: 'permission:Bash' })]);
    expect(view(A)?.waitingFor).toMatchObject({ tool: 'Bash', label: 'Bash çağrısı' });
    store.applyRegistry([reg(A, 'waiting', { waitingForRaw: null })]);
    expect(view(A)?.waitingFor).toMatchObject({ tool: 'Bash' });
  });

  it('idle + arka plan subagent çalışıyor → busy; bitti 15 sn → busy, 25 sn → idle', () => {
    const { store, reg, view, clock } = setup();
    store.applyRegistry([reg(A, 'idle')]);
    store.apply({ ...base(A, T0), type: 'subagent-hint', toolUseId: 'tu', description: 'izle', subagentType: 'Explore', background: true });
    store.apply(start(A, 'x1', T0 + 100, 'Read', '/Users/demo/Projects/demo-1/a.ts', 'bg1'));
    store.apply(end(A, 'tu', T0 + 200, true, null, { linkedAgentId: 'bg1', meta: 'async_launched' }));
    expect(view(A)?.status).toBe('busy');
    store.apply(end(A, 'x1', T0 + 1000, true, 'bg1'));
    store.apply({ ...base(A, T0 + 1000, 'bg1'), type: 'stop', reason: 'end_turn' });
    clock.set(T0 + 1000 + 21_000);
    store.tick(); // tracker arka plan ajanını bitirir (doneAt = şimdi)
    const doneAt = clock.now();
    clock.set(doneAt + 15_000);
    store.tick();
    expect(view(A)?.status).toBe('busy');
    clock.set(doneAt + 25_000);
    store.tick();
    expect(view(A)?.status).toBe('idle');
  });

  it('registry\'den düştü (terminal kapandı): hemen ended, son aktivite yakın olsa da; ended 31 dk → listede yok', () => {
    const { store, reg, view, clock } = setup();
    store.applyRegistry([reg(A, 'busy')]);
    store.apply(start(A, 't1', T0));
    store.applyRegistry([]);
    expect(view(A)?.status).toBe('ended');
    expect(view(A)?.live).toBe(false);
    clock.set(T0 + 60_000);
    expect(view(A)?.status).toBe('ended');
    clock.set(T0 + 31 * 60_000);
    expect(view(A)).toBeUndefined();
  });

  it('kapanan session yeniden registry\'de görülürse canlanır', () => {
    const { store, reg, view } = setup();
    store.applyRegistry([reg(A, 'idle')]);
    store.applyRegistry([]);
    expect(view(A)?.status).toBe('ended');
    store.applyRegistry([reg(A, 'busy')]);
    expect(view(A)?.status).toBe('busy');
  });

  it('supersededBy: aynı pid\'de yeni sessionId → eski gizlenir (canlı değilse)', () => {
    const { store, reg, view } = setup();
    store.applyRegistry([reg(A, 'busy', { pid: 500 })]);
    store.apply(start(A, 't1', T0));
    store.applyRegistry([reg(B, 'idle', { pid: 500 })]);
    expect(store.debugSession(A)?.supersededBy).toBe(B);
    expect(view(A)).toBeUndefined();
    expect(view(B)?.status).toBe('idle');
  });

  it('idle olunca ana ajanın kesilen çağrıları temizlenir', () => {
    const { store, reg, tracker } = setup();
    store.applyRegistry([reg(A, 'busy')]);
    store.apply(start(A, 't1', T0, 'Bash'));
    expect(tracker.get(A, 'main')?.pending.size).toBe(1);
    store.applyRegistry([reg(A, 'idle')]);
    expect(tracker.get(A, 'main')?.pending.size).toBe(0);
  });

  it('slow-tool: busy ve 3 dk\'yı aşan çağrı (Agent çağrıları hariç)', () => {
    const { store, reg, view, clock } = setup();
    store.applyRegistry([reg(A, 'busy')]);
    store.apply(start(A, 'ag', T0, 'Agent'));
    store.apply(start(A, 't1', T0 + 1000, 'Bash'));
    clock.set(T0 + 2 * 60_000);
    expect(view(A)?.flags).not.toContain('slow-tool');
    clock.set(T0 + 3 * 60_000 + 2000);
    store.applyRegistry([reg(A, 'busy')]);
    const snap = store.snapshot();
    expect(snap.sessions[0]?.flags).toContain('slow-tool');
    expect(snap.totals.slowTools).toBe(1);
  });

  it('ctx-80: context ≥ %80', () => {
    const { store, reg, view } = setup();
    store.applyRegistry([reg(A, 'busy')]);
    store.apply({ ...base(A, T0), type: 'session-meta', model: 'claude-opus-5-5' });
    store.apply(usage(A, 'm1', T0, 700_000));
    expect(view(A)?.flags).not.toContain('ctx-80');
    store.apply(usage(A, 'm2', T0 + 1, 100_000, 710_000));
    const v = view(A)!;
    expect(v.ctxRatio).toBeCloseTo(0.81, 5);
    expect(v.ctxMax).toBe(1e6);
    expect(v.flags).toContain('ctx-80');
  });

  it('loop-suspect: son 4 araç imzası aynı', () => {
    const { store, reg, view } = setup();
    store.applyRegistry([reg(A, 'busy')]);
    for (let i = 0; i < 4; i++) {
      store.apply(start(A, `t${i}`, T0 + i, 'Read', '/Users/demo/Projects/demo-1/x.ts'));
      store.apply(end(A, `t${i}`, T0 + i));
    }
    expect(view(A)?.flags).toContain('loop-suspect');
  });

  it('çakışma: 2 session aynı dosyaya 20 dk içinde yazar; 21 dk sonra çakışma yok', () => {
    const { store, reg, view, clock, drainTypes } = setup();
    const f = '/Users/demo/Projects/demo-1/lib/types.ts';
    store.applyRegistry([reg(A, 'busy'), reg(B, 'busy')]);
    drainTypes();
    store.apply(start(A, 'e1', T0, 'Edit', f));
    store.apply(start(B, 'e2', T0 + 5 * 60_000, 'Write', f));
    expect(drainTypes()).toContain('conflict');
    clock.set(T0 + 6 * 60_000);
    const snap = store.snapshot();
    expect(snap.totals.conflicts).toBe(1);
    expect(snap.projects[0]?.conflicts[0]).toMatchObject({ path: f, sessionIds: expect.arrayContaining([A, B]) });
    expect(view(A)?.flags).toContain('conflict');
    expect(snap.projects[0]?.hotFiles[0]?.writes).toBe(2);
    clock.set(T0 + 26 * 60_000);
    expect(store.snapshot().totals.conflicts).toBe(0);
  });

  it('usage: aynı messageId iki kez sayılmaz; maliyet session, proje ve toplamda', () => {
    const { store, reg } = setup();
    store.applyRegistry([reg(A, 'busy')]);
    store.apply(usage(A, 'm1', T0, 1_000_000));
    store.apply(usage(A, 'm1', T0, 1_000_000));
    const snap = store.snapshot();
    expect(snap.sessions[0]?.costUsd).toBeCloseTo(4 + 0.002, 6);
    expect(snap.totals.costTodayUsd).toBeCloseTo(4.002, 6);
    expect(snap.projects[0]?.costUsd).toBeCloseTo(4.002, 6);
  });

  it('gün dönümü: maliyet ve sayaçlar sıfırlanır, session kalır', () => {
    const { store, reg, clock } = setup();
    store.applyRegistry([reg(A, 'busy')]);
    store.apply(start(A, 't1', T0));
    store.apply(usage(A, 'm1', T0));
    expect(store.tickDay()).toBe(false);
    clock.set(DAY0 + 86_400_000 + 60_000);
    store.applyRegistry([reg(A, 'busy')]);
    expect(store.tickDay()).toBe(true);
    const s = store.snapshot();
    expect(s.sessions[0]?.toolCount).toBe(0);
    expect(s.sessions[0]?.costUsd).toBe(0);
    expect(s.totals.costTodayUsd).toBe(0);
    expect(s.dayStart).toBe(DAY0 + 86_400_000);
    // Dünkü usage tekrar gelirse (seenUsage sıfırlandı) — dünkü olay sayaca girmez.
    store.apply(usage(A, 'm1', T0));
    expect(store.snapshot().totals.costTodayUsd).toBe(0);
  });

  it('dünkü olay: durum güncellenir ama sayaç ve log\'a girmez', () => {
    const { store, reg } = setup();
    store.applyRegistry([reg(A, 'busy')]);
    store.apply({ ...base(A, DAY0 - 3600_000), type: 'session-meta', title: 'dünden', model: 'claude-opus-5-5' });
    store.apply(start(A, 'old', DAY0 - 3600_000));
    const s = store.snapshot();
    expect(s.sessions[0]?.title).toBe('dünden');
    expect(s.sessions[0]?.toolCount).toBe(0);
    expect(s.log).toHaveLength(0);
  });

  it('olaylar booted öncesi kuyruğa girmez', () => {
    const { store, reg } = setup();
    store.setBooted(false);
    store.applyRegistry([reg(A, 'busy')]);
    store.apply(start(A, 't1', T0));
    expect(store.drainEvents()).toEqual([]);
    store.setBooted(true);
    store.apply(start(A, 't2', T0 + 1));
    expect(store.drainEvents().map((e: BoardEvent) => e.type)).toContain('tool-start');
  });

  it('dirty bayrağı: değişiklik yoksa false kalır', () => {
    const { store, reg } = setup();
    store.applyRegistry([reg(A, 'busy')]);
    store.snapshot();
    expect(store.dirty).toBe(false);
    store.tick();
    expect(store.dirty).toBe(false);
    store.apply(start(A, 't1', T0));
    expect(store.dirty).toBe(true);
  });

  it('log: tool-end giriş durumunu ve süresini günceller; sıra dışı tool-end yoksayılır', () => {
    const { store, reg } = setup();
    store.applyRegistry([reg(A, 'busy')]);
    store.apply(start(A, 't1', T0, 'Bash'));
    store.apply(end(A, 't1', T0 + 1500, false));
    store.apply(end(A, 'yok', T0 + 1600, true));
    const log = store.snapshot().log;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ id: 't1', state: 'err', durationMs: 1500, toolName: 'Bash' });
    expect(store.snapshot().sessions[0]?.errorCount).toBe(1);
  });

  it('log halkası: sırasız gelen kayıtlardan en yeni 300\'ü zaman sırasıyla kalır', () => {
    const { store, reg } = setup();
    store.applyRegistry([reg(A, 'busy')]);
    const order = Array.from({ length: 700 }, (_, i) => i);
    let seed = 3;
    for (let i = order.length - 1; i > 0; i--) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const j = seed % (i + 1);
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    for (const k of order) store.apply(start(A, `t${k}`, T0 + k * 1000));
    const ids = store.snapshot().log.map((e) => e.id);
    expect(ids).toEqual(Array.from({ length: 300 }, (_, i) => `t${699 - i}`));
  });

  it('sıralama: waiting → busy → idle → ended, sonra lastTs', () => {
    const C = 'cccccccc-0000-4000-8000-000000000003';
    const { store, reg } = setup();
    store.applyRegistry([reg(A, 'idle'), reg(B, 'waiting', { pid: 303 }), reg(C, 'busy', { pid: 404 })]);
    expect(store.snapshot().sessions.map((s) => s.status)).toEqual(['waiting', 'busy', 'idle']);
  });

  it('hotkey: yapışkan; yeni session en küçük boş numarayı alır', () => {
    const C = 'cccccccc-0000-4000-8000-000000000003';
    const { store, reg } = setup();
    store.applyRegistry([reg(A, 'busy', { startedAt: 1 }), reg(B, 'busy', { pid: 303, startedAt: 2 })]);
    let s = store.snapshot();
    expect(s.sessions.find((x) => x.id === A)?.hotkey).toBe(1);
    expect(s.sessions.find((x) => x.id === B)?.hotkey).toBe(2);
    store.applyRegistry([reg(B, 'busy', { pid: 303, startedAt: 2 })]);
    store.applyRegistry([reg(B, 'busy', { pid: 303, startedAt: 2 }), reg(C, 'busy', { pid: 404, startedAt: 3 })]);
    s = store.snapshot();
    expect(s.sessions.find((x) => x.id === B)?.hotkey).toBe(2);
    expect(s.sessions.find((x) => x.id === C)?.hotkey).toBe(1);
  });

  it('gizli proje: session ve proje görünmez', () => {
    const { store, reg } = setup({ hidden: ['/Users/demo/Projects/secret'] });
    store.applyRegistry([reg(A, 'busy', { cwd: '/Users/demo/Projects/secret' }), reg(B, 'busy')]);
    const s = store.snapshot();
    expect(s.sessions.map((x) => x.id)).toEqual([B]);
    expect(s.projects).toHaveLength(1);
  });

  it('subagent: spawn/done olayları ve görünürlük (15 dk)', async () => {
    const { store, reg, clock, view } = setup();
    store.applyRegistry([reg(A, 'busy')]);
    store.drainEvents();
    store.apply(start(A, 'x1', T0, 'Read', undefined, 'sa1'));
    store.apply(end(A, 'tu', T0 + 1000, true, null, { linkedAgentId: 'sa1' }));
    const types = store.drainEvents().map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['agent-spawn', 'agent-done']));
    expect(view(A)?.agents.map((a) => a.id)).toEqual(['main', 'sa1']);
    clock.set(T0 + 16 * 60_000);
    store.applyRegistry([reg(A, 'busy')]);
    store.tick();
    expect(view(A)?.agents.map((a) => a.id)).toEqual(['main']);
  });

  it('boot: ajan dosyası kayıtlarından önce görülürse \'başladı\' satırı ilk kaydın zamanını alır', async () => {
    const { store, tracker, reg, clock } = setup();
    store.applyRegistry([reg(A, 'busy')]);
    clock.set(T0 + 30 * 60_000); // boot anı: ajan yarım saat önce başlamış
    store.applyTrackerChanges(await tracker.onFileAdded(`/x/${A}/subagents/agent-sa9.jsonl`, A, 'sa9'));
    store.apply(start(A, 'y1', T0 + 60_000, 'Read', undefined, 'sa9'));
    const spawn = store.snapshot().log.find((e) => e.kind === 'agent' && e.agentId === 'sa9');
    expect(spawn?.ts).toBe(T0 + 60_000);
  });

  it('ad: Claude Code\'un otomatik adı (derived) yerine başlık; kullanıcının verdiği ad başlıktan önce', () => {
    const { store, reg, view } = setup();
    store.applyRegistry([reg(A, 'idle', { name: 'claude-18', nameSource: 'derived' }), reg(B, 'idle', { name: 'ödeme', nameSource: 'user' })]);
    for (const sid of [A, B]) store.apply({ ...base(sid, T0), type: 'session-meta', title: 'Webhook doğrulaması' } as EngineEvent);
    expect(view(A)?.name).toBe('Webhook doğrulaması');
    expect(view(B)?.name).toBe('ödeme');
  });

  it('gc: 24 saatten eski canlı olmayan session silinir; dosya sınırı', () => {
    const { store, reg, clock } = setup();
    store.applyRegistry([reg(A, 'busy')]);
    store.apply(start(A, 't1', T0));
    store.applyRegistry([]);
    clock.set(T0 + 25 * 3600_000);
    store.gc();
    expect(store.debugSession(A)).toBeNull();
  });

  it('performans: 10 session, 50 ajan, 300 log → snapshot < 5 ms (ortalama)', () => {
    const { store, reg } = setup();
    const regs: RegistryEntry[] = [];
    for (let i = 0; i < 10; i++) {
      const sid = `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`;
      regs.push(reg(sid, 'busy', { pid: 1000 + i }));
    }
    store.applyRegistry(regs);
    let n = 0;
    for (const r of regs) {
      for (let a = 0; a < 5; a++) {
        for (let k = 0; k < 6; k++) {
          store.apply(start(r.sessionId, `t${n++}`, T0 + n, 'Read', `/Users/demo/Projects/demo-1/f${k}.ts`, `ag${a}`));
        }
      }
    }
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) store.snapshot();
    const avg = (performance.now() - t0) / 20;
    expect(avg).toBeLessThan(5 * 4); // CI payı: hedef 5 ms, eşik 20 ms
    expect(JSON.stringify(store.snapshot()).length).toBeLessThan(200 * 1024);
  });
});
