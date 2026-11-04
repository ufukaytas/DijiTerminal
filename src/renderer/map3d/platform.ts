// Proje platformu (03/05 Prompt 5): zemin, kenar, basılı ad, amblem, shell pad, dosyalar,
// çakışma çizgileri ve session başına robot ekipleri (03/08). Snapshot'tan keyed diff ile güncellenir.
import * as THREE from 'three';
import { SLOW_COLOR } from '@shared/constants';
import type { ProjectView, SessionView } from '@shared/types';
import { CrewNode } from './crew';
import { buildEmblem, emblemMeshes, setEmblemColor, tickEmblem } from './emblems';
import { Tween, type SceneEnv } from './env';
import { FileRow } from './files';
import { disposeTree, geo } from './geometries';
import { CSS2DObject, el, labelObject } from './labels';
import { sessionOverflow, sessionSlots, MAX_SESSIONS_SHOWN } from './layout';
import { PlatePainter } from './plate';
import { DEMAND_ACTIVE, DEMAND_NONE, type Demand } from './renderLoop';
import { pickShownSessions, plateSummary } from './style';

const MOVE_MS = 600;
const EMBLEM_POS = new THREE.Vector3(-5.45, 0.95, 2.75);
const SHELL_POS = new THREE.Vector3(5.2, 0.34, 3.1);

export class ProjectNode {
  readonly group = new THREE.Group();
  readonly platform: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  readonly edges: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  readonly plate: PlatePainter;
  readonly namePlane: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  readonly pedestal: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  emblem: THREE.Group;
  readonly shell: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  readonly files = new FileRow();
  readonly sessions = new Map<string, CrewNode>();
  /** Çakışan dosyadan session kaidelerine kesikli çizgiler (06 yanıp söndürür). */
  readonly conflictLines = new THREE.Group();
  private readonly overflow: CSS2DObject;
  private readonly overflowEl: HTMLDivElement;
  private readonly x = new Tween(0);
  private readonly z = new Tween(0);
  private readonly color = new THREE.Color();
  private colorHex = '';
  private emblemKind = '';
  private linesKey = '';
  private placed = false;
  /** Gösterim sırası: ilk görülme sırası (ekipler snapshot'tan snapshot'a yer değiştirmez). */
  private order: string[] = [];
  private bobPhase: number;
  project: ProjectView | null = null;

  constructor(
    readonly id: string,
    private readonly env: SceneEnv,
  ) {
    this.platform = new THREE.Mesh(
      geo('platform'),
      new THREE.MeshStandardMaterial({ color: 0x131822, roughness: 0.9 }),
    );
    this.platform.position.y = 0.15;
    this.edges = new THREE.LineSegments(geo('platformEdges'), new THREE.LineBasicMaterial({ color: 0x2a3240 }));
    this.edges.position.y = 0.15;
    this.plate = new PlatePainter(env.createCanvas, env.maxAnisotropy, env.fontsReady);
    this.namePlane = new THREE.Mesh(
      geo('namePlane'),
      new THREE.MeshBasicMaterial({ map: this.plate.texture, transparent: true, depthWrite: false }),
    );
    this.namePlane.rotation.x = -Math.PI / 2;
    this.namePlane.position.set(-0.25, 0.305, 2.95);
    this.pedestal = new THREE.Mesh(
      geo('pedestal'),
      new THREE.MeshStandardMaterial({ color: 0x0f131a, emissive: 0x000000, emissiveIntensity: 0.25 }),
    );
    this.pedestal.position.set(EMBLEM_POS.x, 0.33, EMBLEM_POS.z);
    this.emblem = new THREE.Group();
    this.shell = new THREE.Mesh(
      geo('pad'),
      new THREE.MeshStandardMaterial({ color: 0x1d2330, emissive: 0xff9f5a, emissiveIntensity: 0 }),
    );
    this.shell.position.copy(SHELL_POS);
    const shellLabel = labelObject(el('div', 'mini', '›_ shell'), 0.5, 0);
    shellLabel.position.set(SHELL_POS.x, SHELL_POS.y + 0.2, SHELL_POS.z + 0.55);
    this.overflowEl = el('div', 'mini more');
    this.overflow = labelObject(this.overflowEl, 0.5, 0.5);
    this.overflow.position.set(5.6, 0.9, -0.2);
    this.overflow.visible = false;
    this.group.add(
      this.platform,
      this.edges,
      this.namePlane,
      this.pedestal,
      this.emblem,
      this.shell,
      shellLabel,
      this.files.group,
      this.conflictLines,
      this.overflow,
    );
    env.picks.add(this.platform, { kind: 'platform', projectId: id });
    this.bobPhase = (id.charCodeAt(0) || 0) % 7;
  }

  /** Grid konumu. İlk yerleşim anında, sonra 600 ms kayar. */
  place(x: number, z: number, nowMs: number): void {
    const instant = !this.placed || this.env.reducedMotion;
    this.placed = true;
    this.x.set(x, MOVE_MS, nowMs, instant);
    this.z.set(z, MOVE_MS, nowMs, instant);
    this.group.position.set(this.x.value, 0, this.z.value);
  }

  get targetX(): number {
    return this.x.target;
  }
  get targetZ(): number {
    return this.z.target;
  }

  sync(p: ProjectView, byId: ReadonlyMap<string, SessionView>, nowMs: number, now: number): void {
    this.project = p;
    if (p.color !== this.colorHex) {
      this.colorHex = p.color;
      this.color.set(p.color);
      this.pedestal.material.emissive.copy(this.color);
      setEmblemColor(this.emblem, this.color);
    }
    if (p.emblem !== this.emblemKind) this.rebuildEmblem(p);

    const all = p.sessionIds.map((id) => byId.get(id)).filter((s): s is SessionView => Boolean(s));
    // Kararlı sıra: önce bilinenler eski sıralarında, yeniler sona.
    const ids = new Set(all.map((s) => s.id));
    this.order = this.order.filter((id) => ids.has(id));
    for (const s of all) if (!this.order.includes(s.id)) this.order.push(s.id);
    const ordered = this.order.map((id) => byId.get(id)!);
    const shown = pickShownSessions(ordered, MAX_SESSIONS_SHOWN);
    const shownIds = new Set(shown.map((s) => s.id));

    for (const [id, n] of this.sessions) {
      if (!shownIds.has(id)) {
        n.dispose();
        this.sessions.delete(id);
      }
    }
    const slots = sessionSlots(shown.length);
    shown.forEach((s, i) => {
      let n = this.sessions.get(s.id);
      const created = !n;
      if (!n) {
        n = new CrewNode(s.id, this.env);
        this.sessions.set(s.id, n);
        this.group.add(n.group);
      }
      const slot = slots[i]!;
      n.place(slot.x, slot.z, nowMs, created || this.env.reducedMotion);
      n.sync(s, nowMs, now, created || this.env.reducedMotion, p.color);
    });

    const more = sessionOverflow(all.length);
    this.overflow.visible = more > 0;
    if (more > 0) this.overflowEl.textContent = `+${more}`;

    const waiting = all.some((s) => s.status === 'waiting');
    this.edges.material.color.set(waiting ? 0x6a5420 : 0x2a3240);

    this.plate.paint({
      name: p.name,
      tag: p.tag,
      path: p.displayPath,
      color: p.color,
      summary: plateSummary(p, all, now),
    });
    this.files.sync(p.hotFiles, p.conflicts);
    this.syncConflictLines(p);
  }

  private rebuildEmblem(p: ProjectView): void {
    this.env.picks.removeTree(this.emblem);
    disposeTree(this.emblem);
    this.emblem = buildEmblem(p.emblem, this.color);
    this.emblem.position.copy(EMBLEM_POS);
    this.group.add(this.emblem);
    for (const m of emblemMeshes(this.emblem)) this.env.picks.add(m, { kind: 'emblem', projectId: this.id });
    this.emblemKind = p.emblem;
  }

  /** Çakışan dosyadan ona yazan her session'ın kaidesine kesikli çizgi. */
  private syncConflictLines(p: ProjectView): void {
    const pairs: [string, string][] = [];
    for (const c of p.conflicts) {
      if (!this.files.nodes.has(c.path)) continue;
      for (const sid of c.sessionIds) if (this.sessions.has(sid)) pairs.push([c.path, sid]);
    }
    const key = JSON.stringify(pairs.map(([f, s]) => [f, s, this.sessions.get(s)!.baseLocal().toArray()]));
    if (key === this.linesKey) return;
    this.linesKey = key;
    for (const l of [...this.conflictLines.children]) disposeTree(l);
    for (const [path, sid] of pairs) {
      const from = this.files.localPos(path)!;
      const to = this.sessions.get(sid)!.baseLocal();
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([from, to]),
        new THREE.LineDashedMaterial({
          color: SLOW_COLOR,
          dashSize: 0.25,
          gapSize: 0.18,
          transparent: true,
          opacity: 0.7,
        }),
      );
      line.computeLineDistances();
      this.conflictLines.add(line);
    }
  }

  /**
   * Her kare. `t` ms (performance), `dt` sn. `decor`: amblemin dönmesi/salınımı (yalnızca bir şey çalışırken;
   * döngü boştayken sahne durur — 05/02). `view`: robotların bakacağı kamera ve web halkası (dünya).
   * Dönüş: döngüden istenen hız — kayma/yürüme/el sallama aktif, nefes/tarama ortam.
   */
  step(
    t: number,
    dt: number,
    decor = true,
    view?: { camera: THREE.Vector3 | null; halo: THREE.Vector3 | null },
  ): Demand {
    const mx = this.x.step(t);
    const mz = this.z.step(t);
    if (mx || mz) this.group.position.set(this.x.value, 0, this.z.value);
    if (decor && !this.env.reducedMotion) {
      tickEmblem(this.emblem, t, dt);
      this.emblem.position.y = EMBLEM_POS.y + Math.sin(t / 900 + this.bobPhase) * 0.05;
    }
    let d: Demand = mx || mz ? DEMAND_ACTIVE : DEMAND_NONE;
    const crewView = {
      camera: view?.camera ?? null,
      face: (k: { kind: 'file'; path: string } | { kind: 'shell' } | { kind: 'web' }) =>
        k.kind === 'shell' ? this.shellWorld() : k.kind === 'web' ? (view?.halo ?? null) : this.fileWorld(k.path),
    };
    for (const s of this.sessions.values()) d = Math.max(d, s.step(t, dt, crewView)) as Demand;
    return d;
  }

  /** Hover'daki robot (yalnızca bir session'da). */
  setHover(sessionId: string | null, agentId: string | null): void {
    for (const [id, s] of this.sessions) s.setHover(id === sessionId ? agentId : null);
  }

  tickLabels(now: number): void {
    for (const s of this.sessions.values()) s.tickLabel(now);
    if (this.project) {
      const all = this.project.sessionIds
        .map((id) => this.sessions.get(id)?.session)
        .filter((s): s is SessionView => Boolean(s));
      // Yavaş araç süre aşımı snapshot gelmeden de özetlensin.
      this.plate.paint({
        name: this.project.name,
        tag: this.project.tag,
        path: this.project.displayPath,
        color: this.project.color,
        summary: plateSummary(this.project, all, now),
      });
    }
  }

  centerWorld(): THREE.Vector3 {
    return this.group.getWorldPosition(new THREE.Vector3());
  }

  shellWorld(): THREE.Vector3 {
    return this.shell.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.1, 0));
  }

  fileWorld(path: string): THREE.Vector3 | null {
    const local = this.files.localPos(path);
    const p = local ?? new THREE.Vector3(0, 0.58, -3.1); // gösterilmiyorsa platformun arka merkezi
    this.group.updateWorldMatrix(true, false);
    return p.applyMatrix4(this.group.matrixWorld);
  }

  dispose(): void {
    for (const s of this.sessions.values()) s.dispose();
    this.sessions.clear();
    this.files.dispose();
    this.env.picks.removeTree(this.group);
    this.plate.dispose();
    disposeTree(this.group);
  }
}
