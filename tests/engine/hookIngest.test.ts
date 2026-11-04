// 02/09 — hook olaylarını okuma: parse, sınıflandırma, tail (yarım satır, rotasyon, ino), öncelik kuralı.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@shared/settings';
import type { BoardEvent, BoardSnapshot } from '@shared/types';
import { ManualClock } from '@main/engine/clock';
import {
  BACKFILL_BYTES,
  classifyNotification,
  HookIngest,
  parseHookLine,
  parseHookLineDetailed,
  STALE_LINE_MS,
  toTransition,
  type HookTransition,
} from '@main/engine/hookIngest';
import { SessionEngine } from '@main/engine/index';
import { ProjectResolver } from '@main/engine/projects';
import type { RegistryEntry } from '@main/engine/registry';
import { BoardStore, PROV_TTL_MS } from '@main/engine/store';
import { SubagentTracker } from '@main/engine/subagents';
import { tmpDir, waitFor } from './_wait';

const FX = path.join(__dirname, '__fixtures__', 'hooks');
const T = 1793160000000;
const S = 'c1c1c1c1-0000-4000-8000-000000000001';
const S2 = 'c2c2c2c2-0000-4000-8000-000000000002';
const CWD = '/Users/demo/Projects/demo-app';

const line = (o: Record<string, unknown>) =>
  JSON.stringify({ v: 1, ts: T, event: 'Stop', sessionId: S, cwd: CWD, tty: '/dev/ttys004', claudePid: 41001, ...o });

const dirs: string[] = [];
const closers: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = tmpDir('diji-hook-');
  dirs.push(d);
  return d;
}

function ingestFor(file: string, now = T + 10_000) {
  const ing = new HookIngest({ filePath: file, now: () => now, pollMs: 0, watch: false });
  const got: HookTransition[] = [];
  ing.on('transition', (t: HookTransition) => got.push(t));
  closers.push(() => ing.stop());
  return { ing, got };
}

describe('parseHookLine', () => {
  it('geçerli satır; message 200 karakterde kesilir; geçersiz tty null olur', () => {
    const p = parseHookLine(line({ message: 'x'.repeat(500), tty: '/dev/ttys004; rm -rf ~' }));
    expect(p?.event).toBe('Stop');
    expect(p?.message).toHaveLength(200);
    expect(p?.tty).toBeNull();
  });

  it('bozuk satırlar null; v:2 ayrıca işaretlenir', () => {
    const lines = fs.readFileSync(path.join(FX, 'garbage.jsonl'), 'utf8').split('\n').filter(Boolean);
    const parsed = lines.map((l) => parseHookLine(l));
    // Son satır geçerli: tty ve claudePid geçersiz olduğu için null/0'a düşer, satır atılmaz.
    expect(parsed.slice(0, -1).every((p) => p === null)).toBe(true);
    expect(parsed.at(-1)).toMatchObject({ tty: null, claudePid: 0 });
    expect(parseHookLineDetailed(lines[1] ?? '').unsupportedVersion).toBe(true);
  });
});

describe('classifyNotification / toTransition', () => {
  it('notification_type önce gelir; yoksa mesaj kalıpları; bilinmeyen → waiting', () => {
    expect(classifyNotification('Claude is waiting for your input', 'permission_prompt')).toBe('waiting');
    expect(classifyNotification('Claude needs your permission to use Bash', 'idle_prompt')).toBe('idle');
    expect(classifyNotification(undefined, 'auth_success')).toBeNull();
    expect(classifyNotification('Claude needs your permission to use Bash')).toBe('waiting');
    expect(classifyNotification('Claude is waiting for your input')).toBe('idle');
    expect(classifyNotification('Yepyeni bir mesaj')).toBe('waiting');
  });

  it('izin bildirimi aracı mesajdan çıkarır; ExitPlanMode/AskUserQuestion bekleme; diğer PreToolUse yumuşak busy', () => {
    const n = toTransition(parseHookLine(line({ event: 'Notification', message: 'Claude needs your permission to use Bash', notificationType: 'permission_prompt' }))!);
    expect(n).toMatchObject({ to: 'waiting', waitingFor: { tool: 'Bash' } });
    expect(toTransition(parseHookLine(line({ event: 'PreToolUse', tool: 'ExitPlanMode' }))!)).toMatchObject({ to: 'waiting', waitingFor: { tool: 'ExitPlanMode', label: 'plan onayı' } });
    expect(toTransition(parseHookLine(line({ event: 'PreToolUse', tool: 'Read' }))!)).toMatchObject({ to: 'busy', soft: true });
    expect(toTransition(parseHookLine(line({ event: 'SessionStart' }))!)).toMatchObject({ to: null, seed: { tty: '/dev/ttys004' } });
    expect(toTransition(parseHookLine(line({ event: 'SessionEnd' }))!)?.to).toBe('ended');
  });
});

describe('HookIngest tail', () => {
  it('izin akışı: tüm geçişler sırayla', async () => {
    const d = tmp();
    const f = path.join(d, 'hook-events.jsonl');
    fs.copyFileSync(path.join(FX, 'permission-flow.jsonl'), f);
    const { ing, got } = ingestFor(f);
    await ing.start();
    expect(ing.status()).toBe('active');
    expect(got.map((t) => `${t.event}:${t.to}`)).toEqual([
      'UserPromptSubmit:busy',
      'PreToolUse:busy',
      'Notification:waiting',
      'PostToolUse:busy',
      'Stop:idle',
    ]);
  });

  it('yarım satır bir sonraki okumaya taşınır', async () => {
    const d = tmp();
    const f = path.join(d, 'hook-events.jsonl');
    fs.copyFileSync(path.join(FX, 'partial-line.jsonl'), f);
    const { ing, got } = ingestFor(f);
    await ing.start();
    expect(got).toHaveLength(1);
    fs.appendFileSync(f, `ionId":"${S}","cwd":"${CWD}","tty":null,"claudePid":41001}\n`);
    await ing.readNow();
    expect(got.map((t) => t.event)).toEqual(['UserPromptSubmit', 'Stop']);
  });

  it('120 sn\'den eski satırlar atlanır; açılışta yalnızca son 64 KB okunur', async () => {
    const d = tmp();
    const f = path.join(d, 'hook-events.jsonl');
    const old = Array.from({ length: 2000 }, (_, i) => line({ ts: T - STALE_LINE_MS - 1000 + i })).join('\n') + '\n';
    expect(old.length).toBeGreaterThan(BACKFILL_BYTES);
    fs.writeFileSync(f, old + line({ ts: T + 5000 }) + '\n');
    const { ing, got } = ingestFor(f);
    await ing.start();
    expect(got).toHaveLength(1);
    expect(ing.counters.lines).toBeLessThan(2000);
    expect(ing.counters.bad).toBe(0); // ilk yarım satır sayılmadan atıldı
  });

  it('dosya yok → missing; oluşunca okumaya başlar', async () => {
    const d = tmp();
    const f = path.join(d, 'hook-events.jsonl');
    const { ing, got } = ingestFor(f);
    await ing.start();
    expect(ing.status()).toBe('missing');
    fs.writeFileSync(f, line({ ts: T + 1 }) + '\n');
    await ing.readNow();
    expect(ing.status()).toBe('active');
    expect(got).toHaveLength(1);
  });

  it('rotasyon (betik mv → .1): eski dosyanın okunmamış kuyruğu .1\'den tamamlanır, yeni dosya baştan okunur', async () => {
    const d = tmp();
    const f = path.join(d, 'hook-events.jsonl');
    fs.writeFileSync(f, line({ ts: T + 1, event: 'UserPromptSubmit' }) + '\n');
    const { ing, got } = ingestFor(f);
    await ing.start();
    fs.appendFileSync(f, line({ ts: T + 2, event: 'PostToolUse' }) + '\n'); // okunmadan döndürülecek
    fs.renameSync(f, `${f}.1`);
    await ing.readNow(); // arada dosya yok
    expect(ing.status()).toBe('missing');
    fs.writeFileSync(f, line({ ts: T + 3, event: 'Stop' }) + '\n');
    await ing.readNow();
    expect(got.map((t) => t.event)).toEqual(['UserPromptSubmit', 'PostToolUse', 'Stop']);
  });

  it('kesilen dosya (truncate) baştan okunur', async () => {
    const d = tmp();
    const f = path.join(d, 'hook-events.jsonl');
    fs.writeFileSync(f, line({ ts: T + 1 }) + '\n' + line({ ts: T + 2 }) + '\n');
    const { ing, got } = ingestFor(f);
    await ing.start();
    fs.writeFileSync(f, line({ ts: T + 3, event: 'UserPromptSubmit' }) + '\n');
    await ing.readNow();
    expect(got.map((t) => t.at)).toEqual([T + 1, T + 2, T + 3]);
  });

  it('bozuk satırlar sayılır, akış durmaz', async () => {
    const d = tmp();
    const f = path.join(d, 'hook-events.jsonl');
    fs.copyFileSync(path.join(FX, 'garbage.jsonl'), f);
    fs.appendFileSync(f, line({ ts: T + 9 }) + '\n');
    const { ing, got } = ingestFor(f);
    await ing.start();
    expect(ing.counters.bad).toBe(6);
    expect(got).toHaveLength(2);
  });
});

// ---------- öncelik kuralı (BoardStore.applyHook) ----------

function storeSetup() {
  const clock = new ManualClock(T, () => T - 9 * 3600_000);
  const projects = new ProjectResolver({
    git: async () => null,
    settings: () => DEFAULT_SETTINGS,
    home: '/Users/demo',
    countAgents: async () => 0,
    now: () => clock.now(),
  });
  let ref: BoardStore | null = null;
  const tracker = new SubagentTracker({ projectRootOf: (sid) => ref?.rootOf(sid) ?? null, now: () => clock.now(), readMeta: async () => null, agentFileExists: async () => false });
  const store = new BoardStore({ clock, projects, subagents: tracker, onError: () => undefined });
  ref = store;
  store.setBooted(true);
  const reg = (status: RegistryEntry['status'], extra: Partial<RegistryEntry> = {}): RegistryEntry => ({
    sessionId: S,
    pid: 41001,
    status,
    rawStatus: status,
    waitingForRaw: null,
    name: null,
    cwd: CWD,
    entrypoint: 'cli',
    startedAt: T - 60_000,
    updatedAt: T - 30_000,
    statusSince: T - 30_000,
    statusUpdatedAt: T - 30_000,
    procStart: null,
    file: `/x/${S}.json`,
    ...extra,
  });
  const hook = (o: Record<string, unknown>): HookTransition => toTransition(parseHookLine(line(o))!)!;
  const view = (sid = S) => store.snapshot().sessions.find((s) => s.id === sid);
  return { clock, store, reg, hook, view };
}

describe('BoardStore.applyHook', () => {
  it('izin bildirimi registry\'den önce waiting yapar; registry daha yeni durum yazınca registry kazanır', () => {
    const { clock, store, reg, hook, view } = storeSetup();
    store.applyRegistry([reg('busy')]);
    store.drainEvents();
    clock.set(T + 100);
    store.applyHook(hook({ ts: T + 50, event: 'Notification', message: 'Claude needs your permission to use Bash', notificationType: 'permission_prompt' }));
    expect(store.takeUrgent()).toBe(true);
    expect(view()?.status).toBe('waiting');
    expect(view()?.waitingFor).toMatchObject({ tool: 'Bash', since: T + 50 });
    expect(store.drainEvents().map((e: BoardEvent) => e.type)).toContain('status');
    // Registry hâlâ eski (statusUpdatedAt < olay): hook kazanır.
    store.applyRegistry([reg('busy', { updatedAt: T + 80 })]);
    expect(view()?.status).toBe('waiting');
    // Kullanıcı onayladı, registry olaydan sonra busy yazdı.
    clock.set(T + 3000);
    store.applyRegistry([reg('busy', { statusUpdatedAt: T + 2500, statusSince: T + 2500, updatedAt: T + 2500 })]);
    expect(view()?.status).toBe('busy');
  });

  it('registry statusUpdatedAt yazmıyorsa çelişen hook durumu en geç 15 sn\'de registry\'ye döner', () => {
    const { clock, store, reg, hook, view } = storeSetup();
    store.applyRegistry([reg('busy', { statusUpdatedAt: null })]);
    store.applyHook(hook({ ts: T, event: 'Stop' }));
    expect(view()?.status).toBe('idle');
    clock.set(T + PROV_TTL_MS - 1);
    store.tick();
    expect(view()?.status).toBe('idle');
    clock.set(T + PROV_TTL_MS + 1);
    store.tick();
    expect(view()?.status).toBe('busy');
  });

  it('PreToolUse izin bekleyen session\'ı busy\'ye çekmez; PostToolUse çeker', () => {
    const { store, reg, hook, view } = storeSetup();
    store.applyRegistry([reg('busy')]);
    store.applyHook(hook({ ts: T + 10, event: 'Notification', notificationType: 'permission_prompt', message: 'Claude needs your permission to use Bash' }));
    store.applyHook(hook({ ts: T + 20, event: 'PreToolUse', tool: 'Bash' }));
    expect(view()?.status).toBe('waiting');
    store.applyHook(hook({ ts: T + 30, event: 'PostToolUse', tool: 'Bash' }));
    expect(view()?.status).toBe('busy');
  });

  it('eski olay yeni geçici durumu ezmez', () => {
    const { store, reg, hook, view } = storeSetup();
    store.applyRegistry([reg('busy')]);
    store.applyHook(hook({ ts: T + 100, event: 'Stop' }));
    store.applyHook(hook({ ts: T + 50, event: 'UserPromptSubmit' }));
    expect(view()?.status).toBe('idle');
  });

  it('registry\'den önce gelen olay kartı açar, tty ile terminal bilinir; registry gelince normal session olur', () => {
    const { store, reg, hook, view } = storeSetup();
    store.applyRegistry([]);
    store.applyHook(hook({ ts: T, event: 'SessionStart', sessionId: S2, claudePid: 52002 }));
    const v = view(S2);
    expect(v?.live).toBe(true);
    expect(v?.status).toBe('idle');
    expect(v?.terminal).toEqual({ app: 'unknown', tty: '/dev/ttys004', pid: 52002 });
    expect(v?.hotkey).toBe(1);
    // Başka bir registry değişikliği hook'la açılmış kartı kapatmaz.
    store.applyRegistry([reg('busy')]);
    expect(view(S2)?.live).toBe(true);
    // SessionEnd: yalnızca hook'la açılmış session'ı kapatır.
    store.applyHook(hook({ ts: T + 10, event: 'SessionEnd', sessionId: S2, claudePid: 52002 }));
    expect(view(S2)?.live).toBe(false);
    store.applyHook(hook({ ts: T + 10, event: 'SessionEnd' }));
    expect(view()?.live).toBe(true);
  });

  it('süreç denetçisi tty bulamazsa hook tty\'si kullanılır', () => {
    const { store, reg, hook, view } = storeSetup();
    store.applyRegistry([reg('busy')]);
    store.applyHook(hook({ ts: T, event: 'UserPromptSubmit' }));
    store.applyProcess(S, { terminal: { app: 'iterm2', tty: null, pid: 41001 }, cpuPct: 1, memMb: 100, alive: true });
    expect(view()?.terminal).toEqual({ app: 'iterm2', tty: '/dev/ttys004', pid: 41001 });
  });

  it('bilinmeyen session için durum değiştirmeyen olay kart açmaz', () => {
    const { store, hook, view } = storeSetup();
    store.applyHook(hook({ ts: T, event: 'SubagentStop', sessionId: S2 }));
    expect(view(S2)).toBeUndefined();
  });
});

// ---------- motor: olaydan snapshot'a ----------

describe('SessionEngine + hook olayları', () => {
  it('manual: hook satırı pumpNow ile waiting snapshot\'ı üretir; hızlı durum active', async () => {
    const d = tmp();
    const cfg = path.join(d, 'claude');
    fs.mkdirSync(path.join(cfg, 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(cfg, 'projects'), { recursive: true });
    const hookFile = path.join(d, 'hook-events.jsonl');
    const now = Date.now();
    const e = new SessionEngine({ configDir: cfg, hookEventsPath: hookFile, manual: true, isAlive: () => true, git: async () => null });
    closers.push(() => e.stop());
    await e.start();
    expect(e.getSnapshot().fastStatus).toBe('missing');
    fs.writeFileSync(hookFile, line({ ts: now, event: 'Notification', sessionId: S2, notificationType: 'permission_prompt', message: 'Claude needs your permission to use Bash' }) + '\n');
    const snap = await e.pumpNow();
    expect(snap.fastStatus).toBe('active');
    expect(snap.sessions.find((s) => s.id === S2)?.status).toBe('waiting');
  });

  it('canlı: satır yazımından waiting snapshot\'ına < 500 ms (fs.watch + hızlı yayın)', async () => {
    const d = tmp();
    const cfg = path.join(d, 'claude');
    fs.mkdirSync(path.join(cfg, 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(cfg, 'projects'), { recursive: true });
    const hookFile = path.join(d, 'hook-events.jsonl');
    fs.writeFileSync(hookFile, '');
    const e = new SessionEngine({ configDir: cfg, hookEventsPath: hookFile, isAlive: () => true, git: async () => null });
    closers.push(() => e.stop());
    const snaps: { at: number; s: BoardSnapshot }[] = [];
    e.onSnapshot((s) => snaps.push({ at: Date.now(), s }));
    await e.start();
    await new Promise((r) => setTimeout(r, 300)); // açılış yayınından 250 ms uzaklaş
    const latencies: number[] = [];
    for (let i = 0; i < 5; i++) {
      const sid = `c3c3c3c3-0000-4000-8000-00000000000${i}`;
      const t0 = Date.now();
      fs.appendFileSync(hookFile, line({ ts: t0, event: 'Notification', sessionId: sid, notificationType: 'permission_prompt', message: 'Claude needs your permission to use Bash' }) + '\n');
      await waitFor(() => snaps.some((x) => x.s.sessions.some((s) => s.id === sid && s.status === 'waiting')), 2000, 5);
      const hit = snaps.find((x) => x.s.sessions.some((s) => s.id === sid && s.status === 'waiting'));
      latencies.push((hit?.at ?? Infinity) - t0);
      await new Promise((r) => setTimeout(r, 300));
    }
    latencies.sort((a, b) => a - b);
    console.log(`[02/09] hook satırı → waiting snapshot gecikmesi (ms): ${latencies.join(', ')}`);
    expect(latencies.at(-1)).toBeLessThan(500);
  }, 10_000);
});
