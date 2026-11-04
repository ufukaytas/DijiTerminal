// Robot ekipleri (03/08): snapshot → robot durumu, görünüm, yerleşim ve ipucu içeriği.
// Saf fonksiyonlar — three'ye ve DOM'a bağımlı değil, birim testli.
import { CATEGORY_COLOR, SLOW_COLOR, STATUS_COLOR, THRESHOLDS } from '@shared/constants';
import type { AgentView, SessionView, ToolCategory } from '@shared/types';
import { agentChip } from '../lib/agentChip';
import { basename, fmtCost, fmtDuration } from '../lib/format';
import { DEMAND_ACTIVE, DEMAND_AMBIENT, DEMAND_NONE, type Demand } from './renderLoop';

/**
 * ask   — ana ajan, session onay bekliyor: el kaldırır, kameraya döner
 * work  — araç çalıştırıyor: yazar, hedefe döner
 * slow  — araç 3 dk'yı aştı
 * watch — ana ajan alt ajanları bekliyor: tarar
 * think — çalışıyor ama şu an araç yok
 * sleep — session boşta
 * off   — ajan bitti ya da session sona erdi
 */
export type BotState = 'ask' | 'work' | 'slow' | 'watch' | 'think' | 'sleep' | 'off';

export function isRunningCall(a: AgentView): boolean {
  return Boolean(a.current && a.current.endedAt === undefined);
}

export function botState(a: AgentView, s: SessionView, now: number): BotState {
  if (a.done || s.status === 'ended') return 'off';
  if (a.isMain && s.status === 'waiting') return 'ask';
  if (s.status === 'idle' && !isRunningCall(a)) return 'sleep';
  if (isRunningCall(a)) return now - a.current!.startedAt > THRESHOLDS.slowToolMs ? 'slow' : 'work';
  if (a.isMain && s.agents.some((x) => !x.isMain && x.running && !x.done)) return 'watch';
  return 'think';
}

export const STATE_WORD: Record<BotState, string> = {
  ask: 'onayınızı bekliyor',
  work: 'çalışıyor',
  slow: 'yavaş araç',
  watch: 'ajanları bekliyor',
  think: 'düşünüyor',
  sleep: 'boşta',
  off: 'bitti',
};

export interface BotLook {
  eye: string;
  eyeGlow: number; // 0..1
  pad: string;
  padIntensity: number;
  /** Göz kapağı: 1 açık, .35 kısık, .08 kapalı. */
  lid: number;
  trace: string;
}

const DIM = '#2A3240';

export function botLook(st: BotState, a: AgentView): BotLook {
  switch (st) {
    case 'ask':
      return {
        eye: STATUS_COLOR.waiting,
        eyeGlow: 1,
        pad: STATUS_COLOR.waiting,
        padIntensity: 0.6,
        lid: 1,
        trace: '#2C3646',
      };
    case 'work': {
      const c = CATEGORY_COLOR[a.current?.category ?? 'read'];
      return { eye: c, eyeGlow: 1, pad: c, padIntensity: 0.75, lid: 1, trace: c };
    }
    case 'slow':
      return { eye: SLOW_COLOR, eyeGlow: 1, pad: SLOW_COLOR, padIntensity: 0.65, lid: 1, trace: SLOW_COLOR };
    case 'watch':
      return { eye: '#D7DDE8', eyeGlow: 0.8, pad: STATUS_COLOR.busy, padIntensity: 0.45, lid: 1, trace: '#2C3646' };
    case 'think':
      return { eye: '#9ED0FF', eyeGlow: 0.7, pad: STATUS_COLOR.busy, padIntensity: 0.4, lid: 1, trace: '#2C3646' };
    case 'sleep':
      return {
        eye: STATUS_COLOR.idle,
        eyeGlow: 0.45,
        pad: STATUS_COLOR.idle,
        padIntensity: 0.25,
        lid: 0.35,
        trace: '#2C3646',
      };
    case 'off':
      return { eye: DIM, eyeGlow: 0, pad: '#262C38', padIntensity: 0.08, lid: 0.08, trace: '#1F2632' };
  }
}

/**
 * Robotun çizim döngüsünden istediği hız (05/02): yürüme, el sallama, yazma tam hız; nefes, tarama,
 * göz kırpma yavaş hız. Hareketi azalt açıkken hiçbir şey hareket etmez.
 */
export function botDemand(st: BotState, walking: boolean, reduced: boolean): Demand {
  if (reduced) return DEMAND_NONE;
  if (walking || st === 'ask' || st === 'work' || st === 'slow') return DEMAND_ACTIVE;
  if (st === 'off') return DEMAND_NONE;
  return DEMAND_AMBIENT;
}

/** Robot çalışırken neye döner: dosya küpü, shell pedi ya da web halkası. */
export type FaceKind = { kind: 'file'; path: string } | { kind: 'shell' } | { kind: 'web' } | null;

export function faceTarget(a: AgentView): FaceKind {
  const c = a.current;
  if (!c || c.endedAt !== undefined) return null;
  const cat: ToolCategory = c.category;
  if (cat === 'bash') return { kind: 'shell' };
  if (cat === 'web' || cat === 'browser') return { kind: 'web' };
  if (c.file) return { kind: 'file', path: c.file };
  return null;
}

/** Ağız: çalışırken/düşünürken gülümser, onay isterken ve yavaş araçta "o", uykuda ve bitince düz çizgi. */
export function mouthFor(st: BotState): 'smile' | 'oh' | 'flat' {
  if (st === 'ask' || st === 'slow') return 'oh';
  if (st === 'sleep' || st === 'off') return 'flat';
  return 'smile';
}

// ---- Yerleşim ----

/** Lider ölçeği ve alt ajan ölçeği (robot birimi ~0.72 genişlik). */
export const LEAD_SCALE = 1.8;
export const SUB_SCALE = 1.3;
/** Session'ın lider pedinin platform yerelindeki derinliği (dosya sırası arkada, ad önde). */
export const CREW_Z = -0.7;

/**
 * Alt ajan pedleri lider pedinin etrafında: önce yanlar, sonra arka köşeler, sonra ön köşeler —
 * kimse kamerayla lider arasına girmez. 0° = ön (+z). İlk 8'den sonrası dış halkada aynı açılarla.
 */
export const SLOT_DEG = [80, -80, 148, -148, 34, -34, 180, 0] as const;

export function crewSlots(n: number): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  for (let i = 0; i < n; i++) {
    const ring = Math.floor(i / SLOT_DEG.length);
    const th = (SLOT_DEG[i % SLOT_DEG.length]! * Math.PI) / 180 + ring * 0.2;
    const r = 2.5 + ring * 0.95;
    out.push({ x: round3(Math.sin(th) * r), z: round3(Math.cos(th) * r * 0.82) });
  }
  return out;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * Lider pedinden alt ajan pedine zemindeki devre izi: liderden çıkış, bir dik dönüş, alt ajana giriş.
 * Noktalar crew yerelinde (lider (0,0)).
 */
export function tracePoints(to: { x: number; z: number }, y = 0.315): { x: number; y: number; z: number }[] {
  const dir = Math.sign(to.z) || 1;
  const midZ = to.z * 0.35;
  return [
    { x: 0, y, z: dir * 1.05 },
    { x: 0, y, z: midZ },
    { x: to.x, y, z: midZ },
    { x: to.x, y, z: round3(to.z - dir * 0.6) },
  ].map((p) => ({ x: round3(p.x), y: p.y, z: round3(p.z) }));
}

/** Yeni alt ajan liderin pedinden kendi pedine yürür (1.1 sn, yumuşak başlangıç/bitiş). */
export const WALK_MS = 1100;
export function walkProgress(startMs: number, nowMs: number, durMs = WALK_MS): number {
  if (!(durMs > 0)) return 1;
  const k = Math.min(1, Math.max(0, (nowMs - startMs) / durMs));
  return k * k * (3 - 2 * k);
}

/** Ctx yayının uzunluğu (radyan) — 100 adıma yuvarlanır ki her snapshot'ta geometri kurulmasın. */
export function ctxArc(ratio: number): { steps: number; theta: number; warn: boolean } {
  const r = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  const steps = Math.round(r * 100);
  return { steps, theta: (steps / 100) * Math.PI * 2, warn: r >= THRESHOLDS.ctxWarnRatio };
}

// ---- Metinler ----

export function botName(a: AgentView): string {
  if (a.isMain) return 'ana ajan';
  return a.name || a.agentType || a.id.slice(0, 8);
}

/** Robotun üstündeki konuşma baloncuğu. `showTool`: seçili session ya da hover'daki robot. */
export function bubbleFor(
  st: BotState,
  a: AgentView,
  s: SessionView,
  now: number,
  showTool: boolean,
): { text: string; tone: 'ask' | 'slow' | 'work' | 'sleep' } | null {
  if (st === 'ask') return { text: `! onay · ${s.waitingFor?.tool ?? 'izin'}`, tone: 'ask' };
  if (st === 'slow' && a.current)
    return { text: `${a.current.name} · ${fmtDuration(now - a.current.startedAt)}`, tone: 'slow' };
  if (st === 'work' && showTool && a.current) return { text: a.current.name, tone: 'work' };
  if (st === 'sleep' && a.isMain) return { text: 'zz', tone: 'sleep' };
  return null;
}

export interface TipContent {
  chip: { label: string; bg: string; fg: string };
  name: string;
  state: BotState;
  stateWord: string;
  where: string;
  now: string;
  stats: string;
  hint: string;
}

/** Robota hover'da açılan ipucu kartı. */
export function tipContent(a: AgentView, s: SessionView, projectName: string, now: number): TipContent {
  const st = botState(a, s, now);
  let line: string;
  if (st === 'ask')
    line =
      `⏸ ${s.waitingFor?.tool ?? ''} ${s.waitingFor?.label ?? ''} · ${fmtDuration(now - (s.waitingFor?.since ?? s.statusSince))}`.replace(
        /\s+/g,
        ' ',
      );
  else if ((st === 'work' || st === 'slow') && a.current) {
    const target = a.current.file ? basename(a.current.file) : a.current.label;
    line = `▶ ${a.current.name} ${target} · ${fmtDuration(now - a.current.startedAt)}${st === 'slow' ? ' · yavaş' : ''}`;
  } else if (st === 'watch') {
    const n = s.agents.filter((x) => !x.isMain && x.running && !x.done).length;
    line = `◌ ${n} ajanın dönmesini bekliyor`;
  } else if (st === 'off') line = `✓ bitti · ${a.toolCount} araç`;
  else if (st === 'sleep') line = '… boşta';
  else line = '… düşünüyor';
  const ctx = a.isMain && s.ctxMax > 0 ? ` · ctx %${Math.round(Math.min(1, Math.max(0, s.ctxRatio)) * 100)}` : '';
  return {
    chip: agentChip(a),
    name: botName(a),
    state: st,
    stateWord: STATE_WORD[st],
    where: [projectName, s.name || s.title || s.id.slice(0, 8), a.model].filter(Boolean).join(' · '),
    now: line,
    stats: `${a.toolCount} araç · ${fmtCost(a.costUsd)}${ctx}`,
    hint: s.background ? 'tıkla: seç · çift tıkla: uygulamada aç' : 'tıkla: seç · çift tıkla: sekmeye git',
  };
}

/** Boştaki (session idle) ve işi biten robot oturur; çalışan, düşünen, yöneten ve onay isteyen ayakta durur. */
export function sitsDown(st: BotState): boolean {
  return st === 'sleep' || st === 'off';
}

/** Kalça yüksekliğinden pede inen mesafe (robot yerel birimi): kalça 0.35 → ≈0.09. */
export const SIT_DROP = 0.26;

/**
 * Oturma pozu, `k` 0 (ayakta) → 1 (oturuyor), yumuşatılmış. Bacaklar öne uzanır ve hafif açılır, gövde pede iner,
 * eller kucağa gelir.
 */
export function sitPose(k: number): { drop: number; legX: number; legZ: number; armX: number; armZ: number } {
  const e = Math.max(0, Math.min(1, k));
  const s = e * e * (3 - 2 * e);
  return { drop: SIT_DROP * s, legX: -1.45 * s, legZ: 0.12 * s, armX: -0.55 * s, armZ: 0.15 * s };
}
