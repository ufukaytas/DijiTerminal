// Robot ekipleri (03/08) — saf kısımlar: durum, görünüm, döngü talebi, yerleşim, metinler, gövde rengi.
import { describe, expect, it } from 'vitest';
import { CATEGORY_COLOR, SLOW_COLOR, STATUS_COLOR } from '@shared/constants';
import type { AgentView, SessionView, ToolCall } from '@shared/types';
import { SHELL, SHELL_POOL, shellColor } from '@renderer/lib/robotColor';
import { DEMAND_ACTIVE, DEMAND_AMBIENT, DEMAND_NONE } from '@renderer/map3d/renderLoop';
import {
  botDemand,
  botLook,
  botName,
  botState,
  bubbleFor,
  crewSlots,
  ctxArc,
  faceTarget,
  mouthFor,
  SLOT_DEG,
  tipContent,
  tracePoints,
  walkProgress,
  type BotState,
} from '@renderer/map3d/robotLogic';
import { IDS, makeSnapshot } from '../__fixtures__/snapshot';

const NOW = 1_800_000_000_000;
const snap = makeSnapshot(NOW);
const S = (id: string) => snap.sessions.find((s) => s.id === id)!;

const tool = (o: Partial<ToolCall> = {}): ToolCall => ({
  id: 't1',
  sessionId: IDS.busy,
  agentId: null,
  name: 'Read',
  category: 'read',
  label: 'x',
  startedAt: NOW - 1000,
  ...o,
});

const mk = (o: Partial<AgentView> = {}): AgentView => ({
  id: 'a',
  sessionId: IDS.busy,
  isMain: false,
  name: 'yazar',
  agentType: 'general-purpose',
  team: null,
  model: 'sonnet',
  background: false,
  running: true,
  done: false,
  current: null,
  toolCount: 3,
  errorCount: 0,
  costUsd: 0.42,
  firstTs: NOW,
  lastTs: NOW,
  doneAt: null,
  loopSuspect: false,
  ...o,
});

const sess = (o: Partial<SessionView> = {}): SessionView => ({ ...S(IDS.busy), ...o });

describe('botState', () => {
  it('bitmiş ajan ya da sona eren session: off', () => {
    expect(botState(mk({ done: true }), sess(), NOW)).toBe('off');
    expect(botState(mk(), sess({ status: 'ended' }), NOW)).toBe('off');
  });
  it('ana ajan + bekleyen session: ask (alt ajan bekleyemez)', () => {
    expect(botState(mk({ isMain: true }), sess({ status: 'waiting' }), NOW)).toBe('ask');
    expect(botState(mk(), sess({ status: 'waiting' }), NOW)).toBe('think');
  });
  it('boşta session + süren araç yok: sleep; süren araç varsa work', () => {
    expect(botState(mk(), sess({ status: 'idle' }), NOW)).toBe('sleep');
    expect(botState(mk({ current: tool() }), sess({ status: 'idle' }), NOW)).toBe('work');
  });
  it('araç 3 dk eşiğini aşınca slow; biten araç sayılmaz', () => {
    expect(botState(mk({ current: tool({ startedAt: NOW - 181_000 }) }), sess(), NOW)).toBe('slow');
    expect(botState(mk({ current: tool({ startedAt: NOW - 179_000 }) }), sess(), NOW)).toBe('work');
    expect(botState(mk({ current: tool({ endedAt: NOW - 10 }) }), sess(), NOW)).toBe('think');
  });
  it('ana ajan çalışan alt ajanları bekliyorsa watch', () => {
    const s = sess({ agents: [mk({ id: 'main', isMain: true }), mk({ id: 's1' })] });
    expect(botState(s.agents[0]!, s, NOW)).toBe('watch');
    const s2 = sess({ agents: [mk({ id: 'main', isMain: true }), mk({ id: 's1', done: true })] });
    expect(botState(s2.agents[0]!, s2, NOW)).toBe('think');
  });
  it('fixture: agent-lab ekibi', () => {
    const t = S(IDS.team);
    const st = Object.fromEntries(t.agents.map((a) => [a.id, botState(a, t, NOW)]));
    expect(st).toEqual({ main: 'watch', a1: 'work', a2: 'slow', a3: 'off' });
  });
});

describe('botLook / botDemand', () => {
  it('göz rengi: kategori, yavaş kırmızı, bekleyen amber; kapalıda göz kapalı', () => {
    expect(botLook('work', mk({ current: tool({ category: 'edit' }) })).eye).toBe(CATEGORY_COLOR.edit);
    expect(botLook('slow', mk()).eye).toBe(SLOW_COLOR);
    expect(botLook('ask', mk()).pad).toBe(STATUS_COLOR.waiting);
    expect(botLook('off', mk()).lid).toBeLessThan(0.1);
    expect(botLook('sleep', mk()).lid).toBeLessThan(0.5);
  });
  it('yürüme/el sallama/yazma ACTIVE; nefes AMBIENT; kapalı ve hareketi azalt NONE', () => {
    const all: BotState[] = ['ask', 'work', 'slow', 'watch', 'think', 'sleep', 'off'];
    expect(all.map((s) => botDemand(s, false, false))).toEqual([
      DEMAND_ACTIVE,
      DEMAND_ACTIVE,
      DEMAND_ACTIVE,
      DEMAND_AMBIENT,
      DEMAND_AMBIENT,
      DEMAND_AMBIENT,
      DEMAND_NONE,
    ]);
    expect(botDemand('sleep', true, false)).toBe(DEMAND_ACTIVE);
    for (const s of all) expect(botDemand(s, true, true)).toBe(DEMAND_NONE);
  });
});

describe('mouthFor', () => {
  it('çalışırken/düşünürken gülümser, onay ve yavaşta "o", uyku ve bitince düz', () => {
    const all: BotState[] = ['ask', 'work', 'slow', 'watch', 'think', 'sleep', 'off'];
    expect(all.map(mouthFor)).toEqual(['oh', 'smile', 'oh', 'smile', 'smile', 'flat', 'flat']);
  });
});

describe('faceTarget', () => {
  it('bash → shell, web/browser → web, dosyalı araç → dosya, diğerleri yok', () => {
    expect(faceTarget(mk({ current: tool({ category: 'bash' }) }))).toEqual({ kind: 'shell' });
    expect(faceTarget(mk({ current: tool({ category: 'web' }) }))).toEqual({ kind: 'web' });
    expect(faceTarget(mk({ current: tool({ category: 'browser' }) }))).toEqual({ kind: 'web' });
    expect(faceTarget(mk({ current: tool({ file: '/a.ts' }) }))).toEqual({ kind: 'file', path: '/a.ts' });
    expect(faceTarget(mk({ current: tool({ category: 'plan' }) }))).toBeNull();
    expect(faceTarget(mk({ current: tool({ file: '/a.ts', endedAt: NOW }) }))).toBeNull();
    expect(faceTarget(mk())).toBeNull();
  });
});

describe('yerleşim', () => {
  it('crewSlots: önce yanlar (±80°), sonra arka köşeler; ilk 8 r=2.5, sonra dış halka', () => {
    const s = crewSlots(10);
    expect(s).toHaveLength(10);
    const r = (p: { x: number; z: number }) => Math.hypot(p.x, p.z / 0.82);
    for (const p of s.slice(0, 8)) expect(r(p)).toBeCloseTo(2.5, 2);
    for (const p of s.slice(8)) expect(r(p)).toBeCloseTo(3.45, 2);
    expect(s[0]!.x).toBeGreaterThan(2);
    expect(s[1]!.x).toBeLessThan(-2);
    expect(s[0]!.z).toBeCloseTo(-s[1]!.z * -1, 3); // ayna
    expect(s[2]!.z).toBeLessThan(0); // 148° arka
    expect(SLOT_DEG).toHaveLength(8);
    expect(crewSlots(0)).toEqual([]);
  });
  it('tracePoints: liderin pedinden çıkar, dik döner, alt ajan pedinde biter', () => {
    const pts = tracePoints({ x: 2.46, z: 0.36 });
    expect(pts).toHaveLength(4);
    expect(pts[0]).toEqual({ x: 0, y: 0.315, z: 1.05 });
    expect(pts[1]!.x).toBe(0);
    expect(pts[2]!.z).toBe(pts[1]!.z);
    expect(pts[3]!.x).toBe(2.46);
    expect(tracePoints({ x: -1, z: -2 })[0]!.z).toBe(-1.05); // arkadaki pede arkadan çıkar
  });
  it('walkProgress: yumuşak başlangıç/bitiş, sınırlarda 0 ve 1', () => {
    expect(walkProgress(1000, 900)).toBe(0);
    expect(walkProgress(1000, 1000 + 550)).toBeCloseTo(0.5);
    expect(walkProgress(1000, 1000 + 1100)).toBe(1);
    expect(walkProgress(1000, 1000 + 110)).toBeLessThan(0.1);
    expect(walkProgress(0, 5, 0)).toBe(1);
  });
  it('ctxArc: %1 adım, sınırlanır, ≥%80 uyarı, NaN sıfır', () => {
    expect(ctxArc(0.5)).toEqual({ steps: 50, theta: Math.PI, warn: false });
    expect(ctxArc(0.8).warn).toBe(true);
    expect(ctxArc(0.799).warn).toBe(false);
    expect(ctxArc(3).steps).toBe(100);
    expect(ctxArc(Number.NaN)).toEqual({ steps: 0, theta: 0, warn: false });
  });
});

describe('metinler', () => {
  it('botName: ana ajan, ad, tip, kısa id', () => {
    expect(botName(mk({ isMain: true }))).toBe('ana ajan');
    expect(botName(mk({ name: '' }))).toBe('general-purpose');
    expect(botName(mk({ name: '', agentType: '', id: '0123456789' }))).toBe('01234567');
  });
  it('bubbleFor: onay her zaman; yavaş araç süresiyle; çalışan yalnızca seçili/hover; uyuyan ana ajan zz', () => {
    const w = sess({ status: 'waiting', waitingFor: { tool: 'Bash', label: 'rm', since: NOW - 5000 } });
    expect(bubbleFor('ask', mk({ isMain: true }), w, NOW, false)).toEqual({ text: '! onay · Bash', tone: 'ask' });
    const slow = mk({ current: tool({ name: 'Bash', startedAt: NOW - 200_000 }) });
    expect(bubbleFor('slow', slow, sess(), NOW, false)).toEqual({ text: 'Bash · 3:20', tone: 'slow' });
    const work = mk({ current: tool({ name: 'Edit' }) });
    expect(bubbleFor('work', work, sess(), NOW, false)).toBeNull();
    expect(bubbleFor('work', work, sess(), NOW, true)).toEqual({ text: 'Edit', tone: 'work' });
    expect(bubbleFor('sleep', mk({ isMain: true }), sess(), NOW, false)).toEqual({ text: 'zz', tone: 'sleep' });
    expect(bubbleFor('sleep', mk(), sess(), NOW, false)).toBeNull();
  });
  it('tipContent: ad, çip, durum, proje · session · model, şimdiki araç + süre, istatistik; ctx yalnızca ana ajanda', () => {
    const t = S(IDS.team);
    const a1 = t.agents.find((a) => a.id === 'a1')!;
    const tip = tipContent(a1, t, 'agent-lab', NOW);
    expect(tip.state).toBe('work');
    expect(tip.stateWord).toBe('çalışıyor');
    expect(tip.where).toBe(`agent-lab · ${t.name} · ${a1.model}`);
    expect(tip.now).toBe('▶ WebSearch rakip fiyatlandırma 2026 · 12s');
    expect(tip.stats).toMatch(/^\d+ araç · \$/);
    expect(tip.stats).not.toContain('ctx');
    expect(tip.chip.label.length).toBeGreaterThan(0);
    const main = tipContent(t.agents[0]!, { ...t, ctxRatio: 0.84, ctxMax: 200_000 }, 'agent-lab', NOW);
    expect(main.stats).toContain('ctx %84');
    expect(main.now).toBe('◌ 2 ajanın dönmesini bekliyor');
    const a2 = tipContent(
      t.agents.find((a) => a.id === 'a2')!,
      t,
      'agent-lab',
      NOW,
    );
    expect(a2.now).toContain('· yavaş');
    const off = tipContent(
      t.agents.find((a) => a.id === 'a3')!,
      t,
      'agent-lab',
      NOW,
    );
    expect(off.now).toMatch(/^✓ bitti · \d+ araç$/);
    const ask = tipContent(S(IDS.waiting).agents[0]!, S(IDS.waiting), 'demo-app', NOW);
    expect(ask.now).toMatch(/^⏸ /);
    expect(ask.hint).toBe('tıkla: seç · çift tıkla: sekmeye git');
  });
});

describe('shellColor (gövde rengi)', () => {
  it('takım ya da tip rengi; takım önce gelir', () => {
    expect(shellColor(mk({ team: 'pipeline', agentType: 'Explore' }), '#000')).toBe(SHELL.pipeline);
    expect(shellColor(mk({ team: null, agentType: 'Explore' }), '#000')).toBe(SHELL.Explore);
    expect(shellColor(mk({ agentType: 'general-purpose' }), '#000')).toBe(SHELL['general-purpose']);
  });
  it('bilinmeyen takım: havuzdan karma; aynı takım hep aynı renk', () => {
    const a = shellColor(mk({ team: 'growth', agentType: 'x1', id: '1' }), '#000');
    const b = shellColor(mk({ team: 'growth', agentType: 'x2', id: '2' }), '#000');
    expect(a).toBe(b);
    expect(SHELL_POOL).toContain(a);
  });
  it('ana ajan: proje rengi', () => {
    expect(shellColor(mk({ isMain: true, team: 'audience' }), '#123456')).toBe('#123456');
  });
});

describe('oturma', () => {
  it('boştayken ve bitince oturur; çalışırken, düşünürken, yönetirken ve onay isterken ayakta', async () => {
    const { sitsDown } = await import('@renderer/map3d/robotLogic');
    expect(sitsDown('sleep')).toBe(true);
    expect(sitsDown('off')).toBe(true);
    for (const st of ['work', 'slow', 'think', 'watch', 'ask'] as const) expect(sitsDown(st)).toBe(false);
  });

  it('sitPose: 0 ayakta (sıfır), 1 tam oturuş; ara değerler sınırlı ve tekdüze', async () => {
    const { sitPose, SIT_DROP } = await import('@renderer/map3d/robotLogic');
    expect(sitPose(0)).toEqual({ drop: 0, legX: -0, legZ: 0, armX: -0, armZ: 0 });
    const full = sitPose(1);
    expect(full.drop).toBeCloseTo(SIT_DROP);
    expect(full.legX).toBeCloseTo(-1.45);
    let prev = 0;
    for (let k = 0.1; k <= 1.0001; k += 0.1) { const d = sitPose(k).drop; expect(d).toBeGreaterThanOrEqual(prev); prev = d; }
    expect(sitPose(2).drop).toBeCloseTo(SIT_DROP);
  });
});
