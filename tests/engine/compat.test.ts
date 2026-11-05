// 09/01 format kayması kalkanı: CompatMonitor eşikleri, kayan pencere, çelişki sinyali,
// yalnızca şema içeren rapor ve motor entegrasyonu.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock } from '@main/engine/clock';
import { COMPAT_THRESHOLDS, COMPAT_WINDOW_MS, CompatMonitor, CONTRADICTION_MS } from '@main/engine/compat';
import { createNormalizerState } from '@main/engine/events';
import { SessionEngine } from '@main/engine/index';
import { normalizeRecord } from '@main/engine/normalize';
import { isInteractiveClaude, type ProcessInspectorLike } from '@main/engine/process';
import type { RegistryHealth } from '@main/engine/registry';
import { createCompatHandlers } from '@main/handlers';
import { buildCompatMarkdown, buildIssueUrl, compareVersions, ISSUE_URL_MAX, type CompatReport } from '@shared/compat';
import { copyDir, FIXTURES, tmpDir } from './_wait';

const T0 = Date.parse('2026-11-05T10:00:00Z');
const ENV = { appVersion: '0.2.0', osVersion: 'macOS 15.6 (arm64)' };
const healthy = (over: Partial<RegistryHealth> = {}): RegistryHealth => ({
  files: 2,
  parsed: 2,
  live: 2,
  shapeErrors: 0,
  jsonErrors: 0,
  unknownStatus: {},
  ...over,
});

function monitor(start = T0) {
  const clock = new ManualClock(start);
  const m = new CompatMonitor({ now: () => clock.now(), testedMin: '2.1.288', testedMax: '2.1.318' });
  return { m, clock };
}

const records = (m: CompatMonitor, n: number) => {
  for (let i = 0; i < n; i++) m.record();
};
const unknown = (m: CompatMonitor, type: string, n: number, rec: Record<string, unknown> = { type }) => {
  for (let i = 0; i < n; i++) {
    m.record();
    m.unknownType(type, rec);
  }
};

describe('CompatMonitor eşikleri', () => {
  it('başlangıçta ok; tek bozuk satır rozet üretmez', () => {
    const { m } = monitor();
    expect(m.report().level).toBe('ok');
    unknown(m, 'foo-bar', 1);
    m.hookBadLine(false);
    m.statusLineUnparsed();
    for (let i = 0; i < 5; i++) m.missingKey('message.usage');
    const r = m.report();
    expect(r.level).toBe('ok');
    expect(r.signals).toEqual([]);
  });

  it('tanınmayan oran > %1 (en az 10 kayıt) → warn', () => {
    const { m } = monitor();
    records(m, 900);
    unknown(m, 'foo-bar', 9);
    expect(m.report().level).toBe('ok'); // 9 < unknownRatioMin
    unknown(m, 'baz', 1);
    const r = m.report();
    expect(r.level).toBe('warn');
    const s = r.signals.find((x) => x.id === 'unknownRecordTypes');
    expect(s?.detail).toEqual({ 'foo-bar': 9, baz: 1 });
    expect(s?.count).toBe(10);
  });

  it('oran düşük ama tek tip ≥ 50 → warn', () => {
    const { m } = monitor();
    records(m, 100_000);
    unknown(m, 'foo-bar', COMPAT_THRESHOLDS.unknownPerType - 1);
    expect(m.report().level).toBe('ok');
    unknown(m, 'foo-bar', 1);
    expect(m.report().level).toBe('warn');
  });

  it('eksik alan ≥ 20, hook ≥ 10, statusLine ≥ 3', () => {
    const { m } = monitor();
    for (let i = 0; i < 19; i++) m.missingKey('message.usage');
    for (let i = 0; i < 9; i++) m.hookBadLine(i === 0);
    m.statusLineUnparsed();
    m.statusLineUnparsed();
    expect(m.report().level).toBe('ok');
    m.missingKey('timestamp');
    m.hookBadLine(false);
    m.statusLineUnparsed();
    const r = m.report();
    expect(r.signals.map((s) => s.id).sort()).toEqual(['hookBadLines', 'statusLineUnparsed', 'unknownRecordKeys']);
    expect(r.signals.find((s) => s.id === 'hookBadLines')?.detail).toEqual({ unsupportedVersion: 1, invalid: 9 });
  });

  it('registry: parse hatası ya da bilinmeyen status ≥ 1 → warn; düzelince kalkar', () => {
    const { m } = monitor();
    m.setRegistry(healthy({ shapeErrors: 1 }));
    expect(m.report().signals.map((s) => s.id)).toEqual(['registryParseErrors']);
    m.setRegistry(healthy({ unknownStatus: { sleeping: 2 } }));
    const r = m.report();
    expect(r.signals.map((s) => s.id)).toEqual(['unknownRegistryStatus']);
    expect(r.signals[0]?.detail).toEqual({ sleeping: 2 });
    m.setRegistry(healthy());
    expect(m.report().level).toBe('ok');
  });

  it('30 dk kayan pencere: süresi dolan olaylar düşer', () => {
    const { m, clock } = monitor();
    unknown(m, 'foo-bar', 60);
    expect(m.report().level).toBe('warn');
    clock.t += COMPAT_WINDOW_MS - 60_000;
    expect(m.report().level).toBe('warn');
    clock.t += 2 * 60_000;
    expect(m.report().level).toBe('ok');
  });

  it('süreç var / canlı session yok: 60 sn kesintisiz → error; session gelince kalkar', () => {
    const { m, clock } = monitor();
    m.setRegistry(healthy({ files: 0, parsed: 0, live: 0 }));
    m.observeProcesses(2);
    clock.t += CONTRADICTION_MS - 1000;
    m.observeProcesses(2);
    expect(m.report().level).toBe('ok');
    clock.t += 1000;
    m.observeProcesses(2);
    const r = m.report();
    expect(r.level).toBe('error');
    expect(r.signals[0]?.id).toBe('processWithoutSession');
    m.setRegistry(healthy({ live: 1 }));
    m.observeProcesses(2);
    expect(m.report().level).toBe('ok');
  });

  it('çelişki: süreç tablosu yok (null) ya da 0 süreç → sayaç sıfırlanır', () => {
    const { m, clock } = monitor();
    m.setRegistry(healthy({ live: 0 }));
    m.observeProcesses(1);
    clock.t += 50_000;
    m.observeProcesses(null);
    clock.t += 20_000;
    m.observeProcesses(1);
    expect(m.report().level).toBe('ok');
  });

  it('sürüm farkı tek başına uyarı değil, bilgi', () => {
    const { m } = monitor();
    m.setClaudeVersion('2.1.340');
    const r = m.report();
    expect(r.level).toBe('ok');
    expect(r.untestedVersion).toBe(true);
    expect(r.claudeVersion).toBe('2.1.340');
    m.setClaudeVersion('2.1.318');
    expect(m.report().untestedVersion).toBe(false);
    m.setClaudeVersion('sahte');
    expect(m.report().claudeVersion).toBeNull();
  });

  it('değişmeyen rapor aynı nesne (snapshot karşılaştırması ucuz)', () => {
    const { m } = monitor();
    unknown(m, 'foo-bar', 60);
    const a = m.report();
    expect(m.report()).toBe(a);
    m.setRegistry(healthy());
    expect(m.report()).toBe(a); // içerik aynı
  });

  it('tanınmayan tipin yalnızca şeması saklanır; adı enum değilse ‹değer›', () => {
    const { m } = monitor();
    unknown(m, 'foo-bar', 60, { type: 'foo-bar', sessionId: 'x', payload: { prompt: 'gizli', n: 1 }, list: [1] });
    unknown(m, 'Bu bir cümle ve tip adı değil', 60);
    const r = m.report();
    expect(r.unknownShapes?.['foo-bar']).toEqual({
      list: 'array',
      payload: 'object',
      'payload.n': 'number',
      'payload.prompt': 'string',
      sessionId: 'string',
      type: 'string',
    });
    expect(Object.keys(r.signals[0]?.detail ?? {})).toEqual(['foo-bar', '‹değer›']);
  });
});

describe('normalizer → sink', () => {
  it('her kayıt sayılır; bilinmeyen tip ve eksik alanlar bildirilir; yok sayılan tipler sessiz', () => {
    const { m } = monitor();
    const state = createNormalizerState();
    state.sink = m;
    const ctx = { sessionId: 's', agentId: null, state };
    normalizeRecord({ type: 'mode' }, ctx);
    normalizeRecord({ type: 'api-request-blob' }, ctx);
    normalizeRecord({ type: 'yeni-tip', foo: 1 }, ctx);
    normalizeRecord({ type: 'assistant', message: { content: [] } }, ctx); // sessionId, timestamp, model, usage yok
    normalizeRecord(
      { type: 'assistant', sessionId: 's', timestamp: '2026-11-05T10:00:00Z', message: { model: 'claude-opus-5-5', usage: {}, content: [] } },
      ctx,
    );
    normalizeRecord({ type: 'assistant', isApiErrorMessage: true, sessionId: 's', timestamp: '2026-11-05T10:00:00Z', message: { model: '<synthetic>' } }, ctx);
    expect(state.unknownTypes).toEqual({ 'yeni-tip': 1 });
    for (let i = 0; i < 19; i++) normalizeRecord({ type: 'user', message: { content: 'x' } }, ctx);
    const r = m.report();
    expect(r.records).toBe(25);
    const keys = r.signals.find((s) => s.id === 'unknownRecordKeys');
    expect(keys?.detail).toEqual({ sessionId: 20, timestamp: 20, 'message.model': 1, 'message.usage': 1 });
  });
});

describe('isInteractiveClaude', () => {
  const row = (comm: string, tty = 'ttys001') => ({ pid: 1, ppid: 0, tty, cpu: 0, rssKb: 0, comm });
  it('claude ya da sürüm adı + tty', () => {
    expect(isInteractiveClaude(row('claude'))).toBe(true);
    expect(isInteractiveClaude(row('/Users/demo/.local/share/claude/versions/2.1.318'))).toBe(true);
    expect(isInteractiveClaude(row('claude', '??'))).toBe(false);
    expect(isInteractiveClaude(row('node'))).toBe(false);
    expect(isInteractiveClaude(row('bun'))).toBe(false);
  });
});

// ---------- rapor ----------

const SECRETS = [
  'Lütfen müşteri veritabanındaki parolaları sıfırla',
  '/Users/alice/Projects/gizli-proje',
  '2372ca6c-4a3c-4976-b221-4ce4d67bde8a',
  'toolu_01ABCDEFGHIJKLMNOPQRSTUV',
  'sk-ant-api03-gerçekgibianahtar',
];

function realisticReport(): CompatReport {
  const { m } = monitor();
  m.setClaudeVersion('2.1.340');
  const rec = {
    type: 'brand-new-type',
    sessionId: SECRETS[2],
    cwd: SECRETS[1],
    prompt: SECRETS[0],
    toolu_01ABCDEFGHIJKLMNOPQRSTUV: { apiKey: SECRETS[4] },
    '2372ca6c-4a3c-4976-b221-4ce4d67bde8a': 1,
  };
  unknown(m, 'brand-new-type', 80, rec);
  unknown(m, SECRETS[0] as string, 60, rec); // tip adı serbest metin olsa bile
  for (let i = 0; i < 25; i++) m.missingKey('message.usage');
  m.setRegistry(healthy({ unknownStatus: { '‹değer›': 1, sleeping: 1 } }));
  return m.report();
}

describe('buildCompatMarkdown / buildIssueUrl', () => {
  it('rapor yalnızca şema içerir: prompt, yol, kimlik, anahtar yok', () => {
    const r = realisticReport();
    const md = buildCompatMarkdown(r, ENV);
    for (const s of SECRETS) expect(md).not.toContain(s);
    expect(md).not.toMatch(/\/Users\/|toolu_|sk-ant/);
    expect(md).toContain('brand-new-type');
    expect(md).toContain('`prompt`: string');
    expect(md).toContain('`‹id›`');
    expect(md).toContain('Claude Code: 2.1.340 (test edilmemiş sürüm)');
    expect(md).toContain('2.1.288–2.1.318');
    const { url } = buildIssueUrl(r, ENV, md);
    const decoded = decodeURIComponent(url);
    for (const s of SECRETS) expect(decoded).not.toContain(s);
  });

  it('issue URL: form alanları; uzun raporda ≤ 6.000 karakter ve "tam rapor panoda" notu', () => {
    const r = realisticReport();
    const short = buildIssueUrl(r, ENV);
    expect(short.url).toMatch(/^https:\/\/github\.com\/ufukaytas\/DijiTerminal\/issues\/new\?template=compat\.yml&title=/);
    expect(short.url).toContain('&claude-version=2.1.340');
    expect(short.url).toContain('&app-version=0.2.0');
    expect(short.url).toContain('&report=');
    const big: CompatReport = {
      ...r,
      unknownShapes: Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => [`tip-${i}`, Object.fromEntries(Array.from({ length: 40 }, (_, k) => [`anahtar_${k}`, 'string|null']))]),
      ),
    };
    const long = buildIssueUrl(big, ENV);
    expect(long.truncated).toBe(true);
    expect(long.url.length).toBeLessThanOrEqual(ISSUE_URL_MAX);
    expect(decodeURIComponent(long.url)).toContain('tam rapor panoda');
  });

  it('compareVersions', () => {
    expect(compareVersions('2.1.340', '2.1.318')).toBeGreaterThan(0);
    expect(compareVersions('2.1.318', '2.1.318')).toBe(0);
    expect(compareVersions('2.0.99', '2.1.0')).toBeLessThan(0);
    expect(compareVersions('2.1', '2.1.0')).toBe(0);
  });
});

describe('compat IPC handler', () => {
  it('rapor yoksa NOT_FOUND; issue açınca rapor panoya da yazılır', async () => {
    const clip: string[] = [];
    const opened: string[] = [];
    let report: CompatReport | null = null;
    const h = createCompatHandlers({
      report: () => report,
      env: () => ENV,
      writeClipboard: (t) => clip.push(t),
      openExternal: async (u) => {
        opened.push(u);
      },
    });
    const none = await h['compat:copyReport']();
    expect(none.ok).toBe(false);
    report = realisticReport();
    expect((await h['compat:copyReport']()).ok).toBe(true);
    const r = await h['compat:openIssue']();
    expect(r.ok && r.data.truncated).toBe(false);
    expect(clip).toHaveLength(2);
    expect(clip[0]).toContain('DijiTerminal uyumluluk raporu');
    expect(opened[0]).toContain('template=compat.yml');
  });
});

// ---------- motor entegrasyonu ----------

const dirs: string[] = [];
const engines: SessionEngine[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.stop();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

class FakeInspector implements ProcessInspectorLike {
  constructor(public count: number | null) {}
  start(): void {}
  stop(): void {}
  async sampleNow(): Promise<void> {}
  describe() {
    return { terminal: null, cpuPct: null, memMb: null, alive: true };
  }
  onSample(): () => void {
    return () => undefined;
  }
  claudeCount(): number | null {
    return this.count;
  }
}

function engine(dir: string, extra: Partial<ConstructorParameters<typeof SessionEngine>[0]> = {}) {
  const e = new SessionEngine({
    configDir: dir,
    hookEventsPath: null,
    limitsPath: null,
    manual: true,
    isAlive: () => true,
    processStartMs: async () => null,
    procStartToken: async () => null,
    git: async () => null,
    ...extra,
  });
  engines.push(e);
  return e;
}

describe('SessionEngine uyumluluk', () => {
  it('bilinmeyen tipli satır enjeksiyonu → sarı; harita çalışmaya devam eder', async () => {
    const dir = tmpDir('diji-compat-');
    dirs.push(dir);
    copyDir(path.join(FIXTURES, 'basic-two-sessions', 'claude'), dir);
    const sid = 'bd3f9d14-24a3-49dc-9820-231026de98ea';
    const file = path.join(dir, 'projects', '-Users-demo-Projects-demo-1', `${sid}.jsonl`);
    const lines = Array.from({ length: 60 }, (_, i) =>
      JSON.stringify({ type: 'brand-new-type', sessionId: sid, timestamp: new Date().toISOString(), n: i, prompt: SECRETS[0] }),
    );
    fs.appendFileSync(file, lines.join('\n') + '\n');
    const e = engine(dir, { claudeVersion: async () => '2.1.340' });
    await e.start();
    const s = await e.pumpNow();
    expect(s.sessions.length).toBe(2);
    expect(s.compat?.level).toBe('warn');
    expect(s.compat?.signals.find((x) => x.id === 'unknownRecordTypes')?.detail).toEqual({ 'brand-new-type': 60 });
    expect(s.compat?.unknownShapes?.['brand-new-type']?.['prompt']).toBe('string');
    expect(s.compat?.claudeVersion).toBe('2.1.340');
    expect(JSON.stringify(s.compat)).not.toContain(SECRETS[0]);
  });

  it('fixture senaryolarında normal kullanım: uyumluluk ok', async () => {
    const dir = tmpDir('diji-compat-');
    dirs.push(dir);
    copyDir(path.join(FIXTURES, 'basic-two-sessions', 'claude'), dir);
    const e = engine(dir);
    await e.start();
    expect((await e.pumpNow()).compat?.level).toBe('ok');
  });

  it('bozuk registry dosyası (zorunlu alan yok ve kalıcı bozuk JSON) → sarı', async () => {
    const dir = tmpDir('diji-compat-');
    dirs.push(dir);
    copyDir(path.join(FIXTURES, 'basic-two-sessions', 'claude'), dir);
    fs.writeFileSync(path.join(dir, 'sessions', '50001.json'), JSON.stringify({ session_id: 'x', processId: 50001 }));
    const broken = path.join(dir, 'sessions', '50002.json');
    fs.writeFileSync(broken, '{"sessionId": "y", "pid": 5');
    const old = new Date(Date.now() - 10_000);
    fs.utimesSync(broken, old, old);
    const e = engine(dir);
    await e.start();
    const s = await e.pumpNow();
    expect(s.sessions.length).toBe(2);
    const sig = s.compat?.signals.find((x) => x.id === 'registryParseErrors');
    expect(sig?.detail).toEqual({ eksikZorunluAlan: 1, bozukJson: 1 });
    expect(s.compat?.level).toBe('warn');
  });

  it('yeni yazılan (yarım) bozuk JSON gürültü üretmez', async () => {
    const dir = tmpDir('diji-compat-');
    dirs.push(dir);
    copyDir(path.join(FIXTURES, 'basic-two-sessions', 'claude'), dir);
    fs.writeFileSync(path.join(dir, 'sessions', '50002.json'), '{"sessionId": "y", "pid": 5');
    const e = engine(dir);
    await e.start();
    expect((await e.pumpNow()).compat?.level).toBe('ok');
  });

  it('claude süreci var, sessions/ boş: 60 sn sonra kırmızı', async () => {
    const dir = tmpDir('diji-compat-');
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
    const clock = new ManualClock(Date.now());
    const inspector = new FakeInspector(1);
    const e = engine(dir, { clock, inspector });
    await e.start();
    expect((await e.pumpNow()).compat?.level).toBe('ok');
    clock.t += 61_000;
    const s = await e.pumpNow();
    expect(s.compat?.level).toBe('error');
    expect(s.compat?.signals[0]?.id).toBe('processWithoutSession');
    inspector.count = 0;
    expect((await e.pumpNow()).compat?.level).toBe('ok');
  });
});
