// Canlı efektler (03/06). İki katman:
//   planEffects — saf: BoardEvent[] → EffectCommand[] (three nesnesi üretmez, yalnızca konum okur)
//   LiveEffects — komutları kendi zaman kuyruğunda çalıştırır; sürekli efektleri (nabız, ısı, halka)
//                 olaylardan değil son snapshot'tan ve düğüm durumundan hesaplar.
import * as THREE from 'three';
import { CATEGORY_COLOR, SLOW_COLOR, STATUS_COLOR, THRESHOLDS } from '@shared/constants';
import type { BoardEvent, BoardSnapshot, ToolCall } from '@shared/types';
import type { CrewNode } from './crew';
import type { WebGlobe } from './web';
import { disposeTree, geo, glowSprite } from './geometries';
import { cachedColor, ParticlePool } from './particles';
import type { ProjectNode } from './platform';
import { DEMAND_ACTIVE, DEMAND_AMBIENT, DEMAND_NONE, type Demand } from './renderLoop';
import type { SceneAnchors } from './scene';

// ---- Plan (saf) ----

export interface PlanContext {
  anchors: SceneAnchors;
  /** En sıcak dosya yolları (snapshot sırasıyla). */
  hotFiles(projectId: string): string[];
  projectOfSession(sessionId: string): string | null;
  mainAgentId: 'main';
  reducedMotion: boolean;
}

export type EffectCommand =
  | {
      kind: 'particle';
      from: THREE.Vector3;
      to: THREE.Vector3;
      color: string;
      durationMs: number;
      delayMs: number;
      onArrive?: EffectCommand[];
    }
  | { kind: 'heatFile'; projectId: string; path: string; color: string; delayMs: number }
  | { kind: 'flashLabel'; projectId: string; path: string; ms: number; delayMs: number }
  /** on: true → bash başladı (pad hemen nabız atar); false → bitti (bir sonraki snapshot'a kadar söner). */
  | { kind: 'shellActive'; projectId: string; on: boolean; delayMs: number }
  | { kind: 'haloHeat'; delayMs: number }
  | { kind: 'growAgent'; sessionId: string; agentId: string; delayMs: number }
  | { kind: 'dimAgent'; sessionId: string; agentId: string; delayMs: number }
  | { kind: 'shockRing'; sessionId: string; color: string; delayMs: number }
  | { kind: 'tipBlink'; sessionId: string; color: string; delayMs: number }
  | { kind: 'conflictFlash'; projectId: string; path: string; delayMs: number };

export const DUR = {
  read: 800,
  edit: 900,
  search: 800,
  bash: 800,
  web: 1100,
  webBack: 1000,
  halo: 900,
  spawn: 600,
} as const;
export const BATCH_GAP_MS = 40;
export const SEARCH_GAP_MS = 220;
export const LABEL_MS = 2600;
export const SPAWN_COLOR = '#E4E8EF';
export const PROMPT_COLOR = '#E4E8EF';

/** Reduced motion'da kalan komutlar: yalnızca renk değişimleri ve etiket. */
const CALM: ReadonlySet<EffectCommand['kind']> = new Set(['heatFile', 'flashLabel', 'dimAgent', 'conflictFlash']);

/** Subagent henüz haritada yoksa (snapshot gelmedi) ana ajanın konumu. */
function agentAt(ctx: PlanContext, sessionId: string, agentId: string | null): THREE.Vector3 | null {
  return ctx.anchors.agentPos(sessionId, agentId) ?? (agentId ? ctx.anchors.agentPos(sessionId, null) : null);
}

function toolStart(call: ToolCall, ctx: PlanContext, d: number, out: EffectCommand[]): void {
  const pid = ctx.projectOfSession(call.sessionId);
  if (!pid) return;
  const color = CATEGORY_COLOR[call.category];
  const agent = agentAt(ctx, call.sessionId, call.agentId);
  const file = call.file;
  switch (call.category) {
    case 'edit': {
      const to = ctx.anchors.filePos(pid, file ?? '');
      const arrive: EffectCommand[] = file
        ? [
            { kind: 'heatFile', projectId: pid, path: file, color, delayMs: 0 },
            { kind: 'flashLabel', projectId: pid, path: file, ms: LABEL_MS, delayMs: 0 },
          ]
        : [];
      if (agent && to)
        out.push({ kind: 'particle', from: agent, to, color, durationMs: DUR.edit, delayMs: d, onArrive: arrive });
      else for (const a of arrive) out.push({ ...a, delayMs: d });
      return;
    }
    case 'read': {
      if (file) {
        out.push({ kind: 'heatFile', projectId: pid, path: file, color, delayMs: d });
        out.push({ kind: 'flashLabel', projectId: pid, path: file, ms: LABEL_MS, delayMs: d });
      }
      const from = ctx.anchors.filePos(pid, file ?? '');
      if (agent && from) out.push({ kind: 'particle', from, to: agent, color, durationMs: DUR.read, delayMs: d });
      return;
    }
    case 'search': {
      const files = ctx.hotFiles(pid).slice(0, 2);
      if (files.length === 0) {
        const from = ctx.anchors.filePos(pid, ''); // platformun arka merkezi
        if (agent && from) out.push({ kind: 'particle', from, to: agent, color, durationMs: DUR.search, delayMs: d });
        return;
      }
      files.forEach((f, i) => {
        const dd = d + i * SEARCH_GAP_MS;
        out.push({ kind: 'heatFile', projectId: pid, path: f, color, delayMs: dd });
        const from = ctx.anchors.filePos(pid, f);
        if (agent && from) out.push({ kind: 'particle', from, to: agent, color, durationMs: DUR.search, delayMs: dd });
      });
      return;
    }
    case 'bash': {
      const to = ctx.anchors.shellPos(pid);
      if (agent && to) out.push({ kind: 'particle', from: agent, to, color, durationMs: DUR.bash, delayMs: d });
      out.push({ kind: 'shellActive', projectId: pid, on: true, delayMs: d });
      return;
    }
    case 'web': {
      if (agent)
        out.push({
          kind: 'particle',
          from: agent,
          to: ctx.anchors.haloPos(),
          color,
          durationMs: DUR.web,
          delayMs: d,
          onArrive: [{ kind: 'haloHeat', delayMs: 0 }],
        });
      return;
    }
    case 'browser':
    case 'mcp':
      if (agent)
        out.push({ kind: 'particle', from: agent, to: ctx.anchors.haloPos(), color, durationMs: DUR.halo, delayMs: d });
      return;
    default:
      return; // agent: doğuş agent-spawn ile gelir; plan: görsel yok
  }
}

function toolEnd(call: ToolCall, ctx: PlanContext, d: number, out: EffectCommand[]): void {
  const pid = ctx.projectOfSession(call.sessionId);
  if (!pid) return;
  if (call.category === 'web') {
    const agent = agentAt(ctx, call.sessionId, call.agentId);
    if (agent)
      out.push({
        kind: 'particle',
        from: ctx.anchors.haloPos(),
        to: agent,
        color: CATEGORY_COLOR.web,
        durationMs: DUR.webBack,
        delayMs: d,
      });
  } else if (call.category === 'bash') {
    out.push({ kind: 'shellActive', projectId: pid, on: false, delayMs: d });
  }
}

/**
 * Olay → efekt komutları. Bir batch'teki olaylar 40 ms arayla sıralanır; aynı olaydan doğan
 * komutlar kendi göreli gecikmelerini korur. Konumu bulunamayan parçacık atlanır, hata fırlatılmaz.
 */
export function planEffects(events: readonly BoardEvent[], ctx: PlanContext): EffectCommand[] {
  const out: EffectCommand[] = [];
  events.forEach((e, i) => {
    const d = i * BATCH_GAP_MS;
    switch (e.type) {
      case 'tool-start':
        toolStart(e.call, ctx, d, out);
        break;
      case 'tool-end':
        toolEnd(e.call, ctx, d, out);
        break;
      case 'agent-spawn': {
        const from = ctx.anchors.agentPos(e.sessionId, null);
        const to = ctx.anchors.agentPos(e.sessionId, e.agent.id);
        if (from && to) out.push({ kind: 'particle', from, to, color: SPAWN_COLOR, durationMs: DUR.spawn, delayMs: d });
        out.push({ kind: 'growAgent', sessionId: e.sessionId, agentId: e.agent.id, delayMs: d });
        break;
      }
      case 'agent-done':
        out.push({ kind: 'dimAgent', sessionId: e.sessionId, agentId: e.agentId, delayMs: d });
        break;
      case 'status':
        if (e.to === 'waiting')
          out.push({ kind: 'shockRing', sessionId: e.sessionId, color: STATUS_COLOR.waiting, delayMs: d });
        else if (e.from === 'busy' && e.to === 'idle')
          out.push({ kind: 'tipBlink', sessionId: e.sessionId, color: STATUS_COLOR.idle, delayMs: d });
        break;
      case 'prompt':
        out.push({ kind: 'tipBlink', sessionId: e.sessionId, color: PROMPT_COLOR, delayMs: d });
        break;
      case 'file-touch':
        out.push({
          kind: 'heatFile',
          projectId: e.projectId,
          path: e.path,
          color: e.write ? CATEGORY_COLOR.edit : CATEGORY_COLOR.read,
          delayMs: d,
        });
        break;
      case 'conflict':
        out.push({ kind: 'conflictFlash', projectId: e.conflict.projectId, path: e.conflict.path, delayMs: d });
        break;
    }
  });
  if (!ctx.reducedMotion) return out;
  // Hareket yok: parçacıklar düşer, varış komutları parçacığın gecikmesiyle hemen çalışır.
  const calm: EffectCommand[] = [];
  for (const c of out) {
    if (c.kind === 'particle') {
      for (const a of c.onArrive ?? []) if (CALM.has(a.kind)) calm.push({ ...a, delayMs: c.delayMs });
    } else if (CALM.has(c.kind)) calm.push(c);
  }
  return calm;
}

// ---- Yardımcılar (saf) ----

/**
 * Bekleme halkası (lider pedinin çevresinde amber): 1.6 sn'lik döngüde genişler ve söner.
 * Reduced motion'da statik.
 */
export function waitRingAt(t: number, reduced: boolean): { scale: number; opacity: number } {
  if (reduced) return { scale: 1.1, opacity: 0.7 };
  const k = (t / 1600) % 1;
  return { scale: 1 + k * 0.8, opacity: 0.85 * (1 - k) };
}

/** Snapshot'tan sürekli efekt girdileri: projede süren bash'lerin en eskisi, web aracı çalışıyor mu. */
export function liveInputs(s: BoardSnapshot): { bashSince: Map<string, number>; webOn: boolean } {
  const bashSince = new Map<string, number>();
  let webOn = false;
  for (const sess of s.sessions) {
    if (sess.status === 'ended') continue;
    for (const a of sess.agents) {
      const c = a.current;
      if (a.done || !c || c.endedAt !== undefined) continue;
      if (c.category === 'bash') {
        const prev = bashSince.get(sess.projectId);
        if (prev === undefined || c.startedAt < prev) bashSince.set(sess.projectId, c.startedAt);
      } else if (c.category === 'web') webOn = true;
    }
  }
  return { bashSince, webOn };
}

// ---- Canlı katman ----

/** LiveEffects'in sahneden istedikleri. MapScene bunu yapısal olarak sağlar; testler sahte host kurar. */
export interface EffectsHost {
  readonly scene: THREE.Scene;
  readonly anchors: SceneAnchors;
  readonly reducedMotion: boolean;
  readonly glow: THREE.Texture | null;
  readonly lastSnapshot: BoardSnapshot | null;
  onFrame(cb: (t: number, dt: number) => void): () => void;
  onUpdate(cb: (s: BoardSnapshot) => void): () => void;
  onRestore(cb: () => void): () => void;
  projectNode(id: string): ProjectNode | undefined;
  projectNodes(): Iterable<ProjectNode>;
  sessionNodeById(sessionId: string): CrewNode | null;
  webGlobe(): WebGlobe | null;
  projectOfSession(sessionId: string): string | null;
  setDebugInfo(fn: (() => string) | null): void;
}

export interface LiveEffectsOptions {
  /** Kuyruk saati (performance.now ile aynı eksen; rAF `t`). */
  now?: () => number;
  /** Duvar saati — yavaş bash eşiği. */
  wallNow?: () => number;
  isHidden?: () => boolean;
  capacity?: number;
}

const QUEUE_MAX = 400;
const STALE_MS = 2000;
const SHOCKS = 6;
const BLINKS = 6;
const SHOCK_MS = 900;
const BLINK_MS = 500;
const PENDING_GROW_MS = 2500;
const BASH_HINT_MS = 1500;
const CONFLICT_BLINK_MS = 1200; // 3 yanıp sönme (≈2.5 Hz, ışık hassasiyeti sınırının altında)

interface Burst<T extends THREE.Object3D> {
  obj: T;
  start: number;
  live: boolean;
}

export class LiveEffects {
  readonly pool: ParticlePool;
  private queue: { due: number; cmd: EffectCommand }[] = [];
  private readonly now: () => number;
  private readonly wallNow: () => number;
  private readonly isHidden: () => boolean;
  private readonly fxGroup = new THREE.Group();
  private readonly shocks: Burst<THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>>[] = [];
  private readonly blinks: Burst<THREE.Sprite>[] = [];
  private readonly pendingGrow = new Map<string, number>();
  private readonly bashHint = new Map<string, number>();
  private readonly conflictBlink = new Map<string, number>();
  private bashSince = new Map<string, number>();
  private webOn = false;
  private haloHeat = 0;
  /** Son karede yavaş, sürekli bir animasyon (nabız, ısı sönümü, bekleme halkası) çalıştı mı? */
  private ambient = false;
  private readonly offs: (() => void)[] = [];
  private readonly ctx: PlanContext;

  constructor(
    private readonly host: EffectsHost,
    opts: LiveEffectsOptions = {},
  ) {
    this.now = opts.now ?? (() => performance.now());
    this.wallNow = opts.wallNow ?? (() => Date.now());
    this.isHidden = opts.isHidden ?? (() => typeof document !== 'undefined' && document.hidden);
    this.pool = new ParticlePool(host.scene, opts.capacity ?? 60, host.glow);
    this.fxGroup.name = 'fx';
    for (let i = 0; i < SHOCKS; i++) {
      const m = new THREE.Mesh(
        geo('waitRing'),
        new THREE.MeshBasicMaterial({
          color: STATUS_COLOR.waiting,
          transparent: true,
          opacity: 0,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      m.rotation.x = -Math.PI / 2;
      m.visible = false;
      this.fxGroup.add(m);
      this.shocks.push({ obj: m, start: 0, live: false });
    }
    for (let i = 0; i < BLINKS; i++) {
      const s = glowSprite(host.glow ?? new THREE.Texture(), 0xffffff, 1.4);
      s.visible = false;
      this.fxGroup.add(s);
      this.blinks.push({ obj: s, start: 0, live: false });
    }
    host.scene.add(this.fxGroup);
    this.ctx = {
      anchors: host.anchors,
      hotFiles: (pid) => this.host.lastSnapshot?.projects.find((p) => p.id === pid)?.hotFiles.map((f) => f.path) ?? [],
      projectOfSession: (sid) => this.host.projectOfSession(sid),
      mainAgentId: 'main',
      reducedMotion: host.reducedMotion,
    };
    if (host.lastSnapshot) this.onSnapshot(host.lastSnapshot);
    this.offs.push(
      host.onFrame((t, dt) => this.frame(t, dt)),
      host.onUpdate((s) => this.onSnapshot(s)),
      host.onRestore(() => this.reset()),
    );
    host.setDebugInfo(() => `particles: ${this.pool.liveCount}/${this.pool.capacity} · queue: ${this.queue.length}`);
  }

  get queueLength(): number {
    return this.queue.length;
  }

  /** Olay batch'i (03/01: 120 ms). Pencere gizliyken kuyruğa alınmaz. */
  handle(events: BoardEvent[]): void {
    if (events.length === 0 || this.isHidden()) return;
    const now = this.now();
    for (const cmd of planEffects(events, this.ctx)) this.queue.push({ due: now + cmd.delayMs, cmd });
    if (this.queue.length > QUEUE_MAX) this.queue.splice(0, this.queue.length - QUEUE_MAX);
  }

  private onSnapshot(s: BoardSnapshot): void {
    const li = liveInputs(s);
    this.bashSince = li.bashSince;
    this.webOn = li.webOn;
    // "bash bitti" bastırması yalnızca bir sonraki snapshot'a kadar.
    for (const [pid, until] of this.bashHint) if (until < 0) this.bashHint.delete(pid);
  }

  /** Her kare (`t` ms, `dt` sn): zamanı gelen komutlar, parçacıklar, sürekli efektler. */
  frame(t: number, dt: number): void {
    this.ambient = false;
    this.drain(this.now());
    this.pool.update(dt);
    this.resolvePendingGrows(t);
    this.stepProjects(t, dt);
    this.stepHalo(dt);
    this.stepBursts(t);
  }

  private drain(now: number): void {
    if (this.queue.length === 0) return;
    let w = 0;
    for (let i = 0; i < this.queue.length; i++) {
      const q = this.queue[i]!;
      if (q.due > now) {
        this.queue[w++] = q;
        continue;
      }
      if (now - q.due <= STALE_MS) this.exec(q.cmd, now);
    }
    this.queue.length = w;
  }

  exec(cmd: EffectCommand, t: number): void {
    switch (cmd.kind) {
      case 'particle': {
        const arrive = cmd.onArrive;
        this.pool.spawn({
          from: cmd.from,
          to: cmd.to,
          color: cmd.color,
          durationMs: cmd.durationMs,
          ...(arrive && arrive.length ? { onArrive: () => arrive.forEach((a) => this.exec(a, this.now())) } : {}),
        });
        return;
      }
      case 'heatFile': {
        const f = this.host.projectNode(cmd.projectId)?.files.nodes.get(cmd.path);
        if (!f) return;
        f.heat = 1;
        if (!f.conflict) f.mesh.material.emissive.copy(cachedColor(cmd.color));
        return;
      }
      case 'flashLabel':
        this.host.projectNode(cmd.projectId)?.files.nodes.get(cmd.path)?.flashLabel(cmd.ms);
        return;
      case 'shellActive':
        this.bashHint.set(cmd.projectId, cmd.on ? t + BASH_HINT_MS : -1);
        return;
      case 'haloHeat':
        this.haloHeat = 1;
        this.host.webGlobe()?.ping();
        return;
      case 'growAgent': {
        // Yürüyüşü CrewNode.sync başlatır (yeni robot liderin pedinden kendi pedine yürür). Olay
        // snapshot'tan önce geldiyse robot belirince liderden ona bir parçacık atılır.
        if (!this.robot(cmd.sessionId, cmd.agentId))
          this.pendingGrow.set(`${cmd.sessionId}\n${cmd.agentId}`, t + PENDING_GROW_MS);
        return;
      }
      case 'dimAgent':
        this.robot(cmd.sessionId, cmd.agentId)?.powerDown(this.wallNow());
        return;
      case 'shockRing': {
        const pos = this.host.anchors.sessionBase(cmd.sessionId);
        const b = pos && this.freeBurst(this.shocks);
        if (!pos || !b) return;
        b.obj.position.copy(pos);
        b.obj.material.color.copy(cachedColor(cmd.color));
        b.start = t;
        b.live = true;
        b.obj.visible = true;
        return;
      }
      case 'tipBlink': {
        const pos = this.host.anchors.sessionTop(cmd.sessionId);
        const b = pos && this.freeBurst(this.blinks);
        if (!pos || !b) return;
        b.obj.position.copy(pos);
        b.obj.material.color.copy(cachedColor(cmd.color));
        b.start = t;
        b.live = true;
        b.obj.visible = true;
        return;
      }
      case 'conflictFlash': {
        const f = this.host.projectNode(cmd.projectId)?.files.nodes.get(cmd.path);
        if (f) f.heat = 1;
        if (!this.host.reducedMotion) this.conflictBlink.set(cmd.projectId, t);
        return;
      }
    }
  }

  private robot(sessionId: string, agentId: string) {
    return this.host.sessionNodeById(sessionId)?.robots.get(agentId) ?? null;
  }

  /** Doğuş olayı snapshot'tan önce gelir: robot oluşunca liderden ona parçacık at. */
  private resolvePendingGrows(t: number): void {
    if (this.pendingGrow.size === 0) return;
    for (const [key, deadline] of this.pendingGrow) {
      if (t > deadline) {
        this.pendingGrow.delete(key);
        continue;
      }
      const [sid, aid] = key.split('\n') as [string, string];
      if (!this.robot(sid, aid)) continue;
      this.pendingGrow.delete(key);
      const from = this.host.anchors.agentPos(sid, null);
      const to = this.host.anchors.agentPos(sid, aid);
      if (from && to && !this.host.reducedMotion)
        this.pool.spawn({ from, to, color: SPAWN_COLOR, durationMs: DUR.spawn });
    }
  }

  private stepProjects(t: number, dt: number): void {
    const reduced = this.host.reducedMotion;
    const wall = this.wallNow();
    for (const p of this.host.projectNodes()) {
      // Dosya ısısı ve çakışma nabzı
      for (const f of p.files.nodes.values()) {
        const m = f.mesh.material;
        if (f.conflict) {
          m.emissiveIntensity = reduced ? 0.6 : 0.45 + 0.25 * Math.sin(t / 400);
          if (!reduced) this.ambient = true;
        } else {
          f.heat = Math.max(0, f.heat - dt * 0.6);
          m.emissiveIntensity = f.heat * 1.2;
          if (f.heat > 0) this.ambient = true;
        }
      }
      // Çakışma çizgileri: 3 kez yanıp söner
      const cb = this.conflictBlink.get(p.id);
      if (cb !== undefined) {
        const k = (t - cb) / CONFLICT_BLINK_MS;
        const on = k >= 1 || Math.floor(k * 6) % 2 === 0;
        for (const l of p.conflictLines.children) {
          const mat = (l as THREE.Line).material as THREE.LineDashedMaterial;
          mat.opacity = k >= 1 ? 0.7 : on ? 0.95 : 0.12;
        }
        if (k >= 1) this.conflictBlink.delete(p.id);
      }
      // Shell pad: projede süren bash
      const hint = this.bashHint.get(p.id);
      if (hint !== undefined && hint >= 0 && hint < t) this.bashHint.delete(p.id);
      const since = this.bashSince.get(p.id);
      const running = hint === undefined ? since !== undefined : hint >= 0;
      const slow = since !== undefined && wall - since > THRESHOLDS.slowToolMs;
      const sm = p.shell.material;
      sm.emissive.copy(cachedColor(slow ? SLOW_COLOR : CATEGORY_COLOR.bash));
      sm.emissiveIntensity = running ? (reduced ? 0.8 : 0.6 + 0.3 * Math.sin(t / 200)) : 0;
      if (running && !reduced) this.ambient = true;
      // Bash ipucu süresi dolunca pad sönmeli: o ana kadar döngü uykuya dalmasın.
      if (hint !== undefined && hint >= 0) this.ambient = true;

      for (const s of p.sessions.values()) this.stepSession(s, t, reduced);
    }
  }

  /** Bekleyen session: lider pedinin çevresindeki amber halka nabız atar. */
  private stepSession(s: CrewNode, t: number, reduced: boolean): void {
    if (s.session?.status !== 'waiting') return;
    const r = waitRingAt(t, reduced);
    s.waitRing.scale.setScalar(r.scale);
    s.waitRing.material.opacity = r.opacity;
    if (!reduced) this.ambient = true;
  }

  /** Web küresi ısısı: istek varınca 1, web aracı sürerken en az .6, sonra söner. */
  private stepHalo(dt: number): void {
    const floor = this.webOn ? 0.6 : 0;
    this.haloHeat = Math.max(floor, this.haloHeat - dt * 0.8);
    if (this.haloHeat > floor) this.ambient = true;
    this.host.webGlobe()?.setHeat(this.haloHeat);
  }

  private stepBursts(t: number): void {
    for (const b of this.shocks) {
      if (!b.live) continue;
      const k = (t - b.start) / SHOCK_MS;
      if (k >= 1) {
        b.live = false;
        b.obj.visible = false;
        continue;
      }
      b.obj.scale.setScalar(2.2 + 2.4 * k); // lider pedinin bekleme halkasından (≈1.4) dışa
      b.obj.material.opacity = 1 - k;
    }
    for (const b of this.blinks) {
      if (!b.live) continue;
      const k = (t - b.start) / BLINK_MS;
      if (k >= 1) {
        b.live = false;
        b.obj.visible = false;
        continue;
      }
      b.obj.scale.setScalar(1.2 + 1.8 * k);
      b.obj.material.opacity = 0.9 * (1 - k);
    }
  }

  /**
   * Çizim döngüsüne ihtiyaç (05/02): uçuşan parçacık, kuyruk, şok halkası, parlama, ve çakışma yanıp sönmesi tam hız ister; nabızlar ve ısı sönümü yavaş hız yeter; hiçbiri yoksa boşta.
   */
  demand(): Demand {
    if (this.queue.length > 0 || this.pool.liveCount > 0) return DEMAND_ACTIVE;
    if (this.conflictBlink.size > 0) return DEMAND_ACTIVE;
    for (const b of this.shocks) if (b.live) return DEMAND_ACTIVE;
    for (const b of this.blinks) if (b.live) return DEMAND_ACTIVE;
    if (this.ambient || this.pendingGrow.size > 0) return DEMAND_AMBIENT;
    return DEMAND_NONE;
  }

  /** En fazla N eşzamanlı; doluysa en eskisi yeniden kullanılır. */
  private freeBurst<T extends THREE.Object3D>(list: Burst<T>[]): Burst<T> {
    let oldest = list[0]!;
    for (const b of list) {
      if (!b.live) return b;
      if (b.start < oldest.start) oldest = b;
    }
    return oldest;
  }

  /** Bağlam yenilendi ya da sahne yeniden kuruldu: uçuştaki her şey bırakılır. */
  reset(): void {
    this.pool.clear();
    this.queue = [];
    this.pendingGrow.clear();
    this.conflictBlink.clear();
    for (const b of [...this.shocks, ...this.blinks]) {
      b.live = false;
      b.obj.visible = false;
    }
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off();
    this.host.setDebugInfo(null);
    this.reset();
    this.pool.dispose();
    disposeTree(this.fxGroup); // şok halkaları ve parlamalar (paylaşılan geometri/glow kalır)
    this.fxGroup.clear();
  }
}
