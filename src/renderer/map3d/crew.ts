// Session = robot ekibi (03/08). Lider robot (ana ajan) ortada kendi pedinde; alt ajanlar devre
// izleriyle ona bağlı pedlerde. Lider pedinin çevresinde context yayı, bekleyen session'da amber
// nabız halkası, seçili session'da beyaz halka; session etiketi liderin üstünde.
// Eski anten + ajan küreleri (03/05 Prompt 7–8) bunun yerini aldı.
import * as THREE from 'three';
import { SLOW_COLOR } from '@shared/constants';
import type { AgentView, SessionView } from '@shared/types';
import { shellColor } from '../lib/robotColor';
import { Tween, type SceneEnv } from './env';
import { disposeTree, geo } from './geometries';
import { SessionLabel } from './labels';
import { ctxArc, crewSlots, type FaceKind, faceTarget } from './robotLogic';
import { DEMAND_ACTIVE, DEMAND_NONE, type Demand } from './renderLoop';
import { PAD_TOP, RobotNode } from './robots';

const MOVE_MS = 600;
const ARC_Y = 0.32;

/** Robotların yöneleceği noktaların dünya konumu (ProjectNode + MapScene sağlar). */
export interface CrewView {
  face(kind: Exclude<FaceKind, null>): THREE.Vector3 | null;
  camera: THREE.Vector3 | null;
}

export class CrewNode {
  readonly group = new THREE.Group();
  readonly robots = new Map<string, RobotNode>();
  readonly label: SessionLabel;
  /** Yalnızca bekleyen session'da görünür; nabzı 06 (effects) sürer. */
  readonly waitRing: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  readonly selRing: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  readonly arcBg: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  arc: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | null = null;
  private arcSteps = -1;
  private arcWarn = false;
  private readonly x = new Tween(0);
  private readonly z = new Tween(0);
  /** Alt ajanların ilk görülme sırası: yerleri snapshot'tan snapshot'a değişmez. */
  private order: string[] = [];
  private selected = false;
  private hoverAgent: string | null = null;
  private projectColor = '#5EA0FF';
  session: SessionView | null = null;

  constructor(
    readonly id: string,
    private readonly env: SceneEnv,
  ) {
    const basic = (color: number, opacity: number) =>
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false });
    this.arcBg = new THREE.Mesh(
      geo('crewArcBg'),
      new THREE.MeshBasicMaterial({ color: 0x1c2230, side: THREE.DoubleSide }),
    );
    this.arcBg.rotation.x = -Math.PI / 2;
    this.arcBg.position.y = ARC_Y - 0.005;
    this.waitRing = new THREE.Mesh(geo('crewWait'), basic(0xf2b134, 0.7));
    this.waitRing.rotation.x = -Math.PI / 2;
    this.waitRing.position.y = ARC_Y + 0.01;
    this.waitRing.visible = false;
    this.selRing = new THREE.Mesh(geo('crewSel'), basic(0xe4e8ef, 0.55));
    this.selRing.rotation.x = -Math.PI / 2;
    this.selRing.position.y = ARC_Y + 0.01;
    this.selRing.visible = false;
    this.label = new SessionLabel(env, id);
    this.label.object.position.set(0, 4.2, 0); // liderin anten uçlarının (≈3.0) üstünde: yakın planda yüzü örtmesin
    this.group.add(this.arcBg, this.waitRing, this.selRing, this.label.object);
    env.picks.add(this.arcBg, { kind: 'crew', sessionId: id });
  }

  /** Slot konumu (platform yereli). İlk yerleşim anında, sonra 600 ms kayar. */
  place(x: number, z: number, nowMs: number, instant: boolean): void {
    this.x.set(x, MOVE_MS, nowMs, instant);
    this.z.set(z, MOVE_MS, nowMs, instant);
    this.group.position.set(this.x.value, 0, this.z.value);
  }

  /** `projectColor`: lider robotun devre çizgileri bu renkte yanar (ayarlardaki proje rengi). */
  sync(s: SessionView, nowMs: number, now: number, instant: boolean, projectColor = '#5EA0FF'): void {
    this.session = s;
    this.projectColor = projectColor;
    const main = s.agents.find((a) => a.isMain) ?? s.agents[0];
    const subs = s.agents.filter((a) => a !== main);
    const keep = new Set(s.agents.map((a) => a.id));
    for (const [id, r] of this.robots) {
      if (!keep.has(id)) {
        r.dispose();
        this.robots.delete(id);
      }
    }
    this.order = this.order.filter((id) => keep.has(id) && id !== main?.id);
    for (const a of subs) if (!this.order.includes(a.id)) this.order.push(a.id);

    if (main) this.ensure(main, { x: 0, z: 0 }, nowMs, instant, s, now);
    const slots = crewSlots(this.order.length);
    const byId = new Map(subs.map((a) => [a.id, a]));
    this.order.forEach((id, i) => this.ensure(byId.get(id)!, slots[i]!, nowMs, instant, s, now));

    this.waitRing.visible = s.status === 'waiting';
    this.setArc(s.ctxMax > 0 ? s.ctxRatio : 0);
    this.label.update(s, now);
  }

  private ensure(
    a: AgentView,
    slot: { x: number; z: number },
    nowMs: number,
    instant: boolean,
    s: SessionView,
    now: number,
  ): void {
    let r = this.robots.get(a.id);
    const hex = shellColor(a, this.projectColor);
    if (!r) {
      r = new RobotNode(a, this.id, this.env, hex);
      this.robots.set(a.id, r);
      this.group.add(r.group);
      // Yeni alt ajan liderin pedinden yürüyerek gelir (açılışta ve hareketi azalt'ta anında).
      r.setHome(slot.x, slot.z, nowMs, !instant && !a.isMain ? { x: 0, z: 0 } : null);
      r.setSelected(this.selected);
      r.setHovered(this.hoverAgent === a.id);
    } else {
      r.setShell(hex);
      const h = r.homeLocal;
      if (h.x !== slot.x || h.z !== slot.z) r.setHome(slot.x, slot.z, nowMs, null);
    }
    r.apply(a, s, now, Date.now());
  }

  /** Context yayı: lider pedinin çevresinde, saat 12'den saat yönünde; ≥%80 kırmızı. */
  private setArc(ratio: number): void {
    const { steps, theta, warn } = ctxArc(ratio);
    if (steps === this.arcSteps && warn === this.arcWarn) return;
    this.arcSteps = steps;
    this.arcWarn = warn;
    if (this.arc) {
      disposeTree(this.arc);
      this.arc = null;
    }
    if (steps === 0) return;
    this.arc = new THREE.Mesh(
      new THREE.RingGeometry(1.22, 1.3, Math.max(8, steps), 1, Math.PI / 2, -theta),
      new THREE.MeshBasicMaterial({
        color: warn ? SLOW_COLOR : '#6B7590',
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.9,
      }),
    );
    this.arc.rotation.x = -Math.PI / 2;
    this.arc.position.y = ARC_Y;
    this.group.add(this.arc);
  }

  /** Saniyelik tik: bekleme süresi, yavaş araç eşiği, baloncuk süreleri. */
  tickLabel(now: number): void {
    const s = this.session;
    if (!s) return;
    this.label.update(s, now);
    for (const a of s.agents) this.robots.get(a.id)?.apply(a, s, now, Date.now());
  }

  setSelected(on: boolean): void {
    this.selected = on;
    this.selRing.visible = on;
    this.label.setSelected(on);
    for (const r of this.robots.values()) r.setSelected(on);
  }

  setHover(agentId: string | null): void {
    if (agentId === this.hoverAgent) return;
    this.robots.get(this.hoverAgent ?? '')?.setHovered(false);
    this.hoverAgent = agentId;
    this.robots.get(agentId ?? '')?.setHovered(true);
  }

  /** Her kare: kayma, yürüme ve robot animasyonları. Dönüş: döngüden istenen hız. */
  step(t: number, dt: number, view?: CrewView): Demand {
    let d: Demand = DEMAND_NONE;
    const mx = this.x.step(t);
    const mz = this.z.step(t);
    if (mx || mz) {
      this.group.position.set(this.x.value, 0, this.z.value);
      d = DEMAND_ACTIVE;
    }
    if (this.robots.size === 0) return d;
    this.group.updateWorldMatrix(true, false);
    const cam = view?.camera ? this.group.worldToLocal(view.camera.clone()) : null;
    for (const r of this.robots.values()) {
      let face: THREE.Vector3 | null = null;
      const fk = view && (r.state === 'work' || r.state === 'slow') ? faceTarget(r.agent) : null;
      if (fk) {
        const w = view!.face(fk);
        if (w) face = this.group.worldToLocal(w.clone());
      }
      d = Math.max(d, r.step(t, dt, face, cam)) as Demand;
    }
    return d;
  }

  robot(agentId: string | null): RobotNode | null {
    if (agentId) return this.robots.get(agentId) ?? null;
    for (const r of this.robots.values()) if (r.isLead) return r;
    return null;
  }

  /** Ajanın kafa konumu (06 parçacıkları). null → lider. */
  worldPos(agentId: string | null): THREE.Vector3 | null {
    return this.robot(agentId)?.headWorld() ?? null;
  }

  /** Liderin kafasının üstü (session etiketi, parlama, kamera odağı). */
  topWorld(): THREE.Vector3 {
    const lead = this.robot(null);
    if (lead) return lead.topWorld();
    return this.group.localToWorld(new THREE.Vector3(0, 2.2, 0));
  }

  baseWorld(): THREE.Vector3 {
    return this.group.localToWorld(new THREE.Vector3(0, PAD_TOP, 0));
  }

  /** Platform yerelinde lider pedi (çakışma çizgileri için). */
  baseLocal(): THREE.Vector3 {
    return new THREE.Vector3(this.x.target, PAD_TOP, this.z.target);
  }

  dispose(): void {
    for (const r of this.robots.values()) r.dispose();
    this.robots.clear();
    this.env.picks.removeTree(this.group);
    disposeTree(this.group); // etiket, halkalar, yay; paylaşılan geometri kalır; parent'tan çıkarır
  }
}
