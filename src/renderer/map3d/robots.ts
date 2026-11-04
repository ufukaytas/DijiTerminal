// Robot (03/08): iki tonlu "chibi" robot ve altındaki devre pedi. Beyaz kabuk ortak; aksan rengi (yüz çerçevesi,
// göğüs paneli, önkol, diz, taban, kulak kapağı, kafa şeridi) alt ajanda takım/tip, liderde proje rengi.
// Durum gözlerde, göğüs ışığında, ağızda ve pedde; iş hareketle anlatılır (robotLogic). Parçalar paylaşılan
// geometriden (robotParts); robot başına yalnızca göz, göğüs ışığı, göz parıltısı, ped ve iz malzemesi yeni.
import * as THREE from 'three';
import type { AgentView, SessionView } from '@shared/types';
import { agentChip, hashString } from '../lib/agentChip';
import type { SceneEnv } from './env';
import { disposeTree, glowSprite, markShared, onDisposeShared } from './geometries';
import { CSS2DObject, el, labelObject } from './labels';
import {
  botDemand,
  botLook,
  botName,
  botState,
  bubbleFor,
  LEAD_SCALE,
  mouthFor,
  SUB_SCALE,
  tracePoints,
  walkProgress,
  type BotLook,
  type BotState,
  sitPose,
  sitsDown,
} from './robotLogic';
import { DEMAND_ACTIVE, type Demand } from './renderLoop';
import * as P from './robotParts';

export const PAD_TOP = 0.33;
/** Robot kökü (ayaklar) ped yüzeyinde. */
const FOOT_Y = PAD_TOP + 0.005;
/** Kafanın robot yerelindeki merkezi (parçacıklar buradan çıkar). */
export const HEAD_Y = P.HEAD_CY;
/** Konuşma baloncuğunun robot yerelindeki yüksekliği (anten uçlarının üstü). */
const BUBBLE_Y = 1.62;
/** Bu mesafenin (× ölçek kökü) ötesinde küçük parçalar gizlenir. */
const DETAIL_DIST = 26;
/** Seçili ekibin isim etiketleri bu mesafeden yakında görünür (ev konumunda etiketler üst üste binmesin). */
const TAG_DIST = 20;
const POWER_HOLD_MS = 3000;

// ---- Paylaşılan malzeme ve texture'lar ----

interface Shared {
  /** Beyaz kabuk + aksan rengi: köşe rengiyle (robotParts). */
  paint: THREE.MeshStandardMaterial;
  /** Çelik + pirinç: köşe rengiyle. */
  metal: THREE.MeshStandardMaterial;
  glass: THREE.MeshStandardMaterial;
  shine: THREE.MeshBasicMaterial;
  hit: THREE.MeshBasicMaterial;
  padTex: THREE.Texture;
}
let shared: Shared | null = null;
onDisposeShared(() => {
  if (!shared) return;
  for (const v of Object.values(shared) as (THREE.Material | THREE.Texture)[]) v.dispose();
  shared = null;
});

type Ctx2D = CanvasRenderingContext2D;
const drawable = (g: Ctx2D | null): g is Ctx2D =>
  Boolean(g && typeof g.beginPath === 'function' && typeof g.strokeRect === 'function');

/** Ped deseni: iç içe kareler ve dört kenardan giren izler (emissiveMap, beyaz = parlayan). */
function padTexture(createCanvas: SceneEnv['createCanvas']): THREE.Texture {
  const c = createCanvas(256, 256);
  const g = c.getContext('2d') as Ctx2D | null;
  if (drawable(g)) {
    g.fillStyle = '#000';
    g.fillRect(0, 0, 256, 256);
    g.strokeStyle = '#fff';
    g.lineWidth = 3;
    for (let k = 0; k < 5; k++) {
      const m = 22 + k * 20;
      g.strokeRect(m, m, 256 - 2 * m, 256 - 2 * m);
    }
    g.lineWidth = 2;
    for (const [x, y] of [
      [10, 128],
      [246, 128],
      [128, 10],
      [128, 246],
    ] as const) {
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(128 + (x - 128) * 0.45, 128 + (y - 128) * 0.45);
      g.stroke();
    }
  }
  return markShared(new THREE.CanvasTexture(c));
}

function sharedParts(env: SceneEnv): Shared {
  if (shared) return shared;
  const std = (o: THREE.MeshStandardMaterialParameters) => markShared(new THREE.MeshStandardMaterial(o));
  shared = {
    paint: std({ vertexColors: true, roughness: 0.34, metalness: 0.1 }),
    metal: std({ vertexColors: true, roughness: 0.3, metalness: 0.88 }),
    glass: std({ color: 0x141820, roughness: 0.12, metalness: 0.5 }),
    shine: markShared(new THREE.MeshBasicMaterial({ color: 0xffffff })),
    hit: markShared(new THREE.MeshBasicMaterial({ visible: false })),
    padTex: padTexture(env.createCanvas),
  };
  return shared;
}

const tmpColor = new THREE.Color();
const tmpV = new THREE.Vector3();

// ---- Robot ----

export class RobotNode {
  /** Ped + robot + iz: crew grubunun çocuğu. */
  readonly group = new THREE.Group();
  /** Robot gövdesi; konumu yürürken pedler arasında kayar, ayakları zeminde. */
  readonly root = new THREE.Group();
  readonly body = new THREE.Group();
  /** Gövde + kafa boyası (beyaz kabuk ve aksan). */
  readonly head: THREE.Mesh;
  readonly eyes: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>[];
  readonly eyeMat: THREE.MeshBasicMaterial;
  /** Göğüsteki durum ışığı: gözlerle aynı renk, aynı malzeme (ayrı malzeme ve renk ataması gerekmez). */
  readonly chestMat: THREE.MeshBasicMaterial;
  readonly mouths: Record<P.MouthKind, THREE.Mesh>;
  private readonly mouthGroup = new THREE.Group();
  private readonly armPaints: THREE.Mesh[] = [];
  private readonly legPaints: THREE.Mesh[] = [];
  readonly eyeGlow: THREE.Sprite;
  readonly arms: THREE.Group[];
  readonly legs: THREE.Group[];
  readonly pad: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  trace: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial> | null = null;
  readonly tag: CSS2DObject;
  private readonly tagChip: HTMLElement;
  private readonly tagDot: HTMLElement;
  /** Kabuk rengi (alt ajan: takım/tip; lider: proje rengi). */
  shellHex: string;
  private readonly tagName: HTMLElement;
  private bubble: CSS2DObject | null = null;
  private bubbleText = '';
  private bubbleTone = '';
  readonly scale: number;
  /** Uzaktan görünmeyen küçük parçalar (göz parlaması, ağız, göğüs ışığı, yay boncukları): uzak kamerada gizlenir. */
  private readonly details: THREE.Object3D[] = [];
  private detailed = true;
  private close = false;
  private home = { x: 0, z: 0 };
  private from = { x: 0, z: 0 };
  private walkStart: number | null = null;
  private yaw = 0;
  /** Oturma ilerlemesi: 0 ayakta, 1 oturuyor. */
  private sit = 0;
  private gone = 0;
  private readonly seed: number;
  private poweredDownAt: number | null = null;
  state: BotState = 'think';
  private look: BotLook | null = null;
  private lookKey = '';
  agent: AgentView;
  private selected = false;
  private hovered = false;

  constructor(
    agent: AgentView,
    private readonly sessionId: string,
    private readonly env: SceneEnv,
    shellHex: string,
  ) {
    this.agent = agent;
    this.shellHex = shellHex;
    const lead = agent.isMain;
    const sp = sharedParts(env);
    this.scale = lead ? LEAD_SCALE : SUB_SCALE;
    this.seed = (hashString(sessionId + agent.id) % 1000) / 100;

    // Gövde + kafa (kafa grubu ayrı canlandırılmadığı için gövdeyle tek parça).
    this.head = new THREE.Mesh(P.bodyPaint(shellHex, lead), sp.paint);
    const metal = new THREE.Mesh(P.bodyMetal(lead), sp.metal);
    const glass = new THREE.Mesh(P.bodyGlass(), sp.glass);
    this.eyeMat = new THREE.MeshBasicMaterial({ color: 0x9ed0ff });
    this.chestMat = this.eyeMat;
    const chest = new THREE.Mesh(P.chestLight(), this.chestMat);
    chest.position.set(0.055, 0.555, 0.168);
    const eyes = new THREE.Mesh(P.eyes(), this.eyeMat);
    eyes.position.set(0, HEAD_Y + 0.035, 0.31);
    const shine = new THREE.Mesh(P.shines(), sp.shine);
    eyes.add(shine);
    this.eyes = [eyes];
    this.mouths = {
      smile: new THREE.Mesh(P.mouth('smile'), this.eyeMat),
      oh: new THREE.Mesh(P.mouth('oh'), this.eyeMat),
      flat: new THREE.Mesh(P.mouth('flat'), this.eyeMat),
    };
    this.mouths.smile.position.set(0, HEAD_Y - 0.085, 0.335);
    this.mouths.oh.position.set(0, HEAD_Y - 0.09, 0.335);
    this.mouths.flat.position.set(0, HEAD_Y - 0.09, 0.335);
    this.mouthGroup.add(this.mouths.smile, this.mouths.oh, this.mouths.flat);
    this.eyeGlow = glowSprite(env.glow, 0x9ed0ff, 1.1);
    this.eyeGlow.position.set(0, HEAD_Y + 0.03, 0.42);
    this.body.add(this.head, metal, glass, chest, eyes, this.mouthGroup, this.eyeGlow);
    this.details.push(shine, this.mouthGroup, chest);
    // Kollar: omuz pivotu; üç yay boncuğu, aksan önkol, yuvarlak el ve başparmak.
    this.arms = ([-1, 1] as const).map((sd) => {
      const pivot = new THREE.Group();
      pivot.position.set(sd * 0.27, 0.63, 0);
      const paint = new THREE.Mesh(P.armPaint(shellHex, sd), sp.paint);
      const springs = new THREE.Mesh(P.armSprings(sd), sp.metal);
      pivot.add(paint, springs);
      this.armPaints.push(paint);
      this.details.push(springs);
      this.body.add(pivot);
      return pivot;
    });
    // Bacaklar: kalça pivotu; yay boncuğu, incik, aksan diz diski, bot ve aksan taban.
    this.legs = ([-1, 1] as const).map((sd) => {
      const hip = new THREE.Group();
      hip.position.set(sd * 0.12, 0.35, 0);
      const paint = new THREE.Mesh(P.legPaint(shellHex), sp.paint);
      const spring = new THREE.Mesh(P.legSpring(), sp.metal);
      hip.add(paint, spring);
      this.legPaints.push(paint);
      this.details.push(spring);
      this.root.add(hip);
      return hip;
    });
    const hit = new THREE.Mesh(P.botHit(), sp.hit);
    hit.position.y = 0.72;
    this.root.add(this.body, hit);
    this.root.scale.setScalar(this.scale);
    this.root.position.y = FOOT_Y;

    this.pad = new THREE.Mesh(
      P.botPad(),
      new THREE.MeshStandardMaterial({
        color: 0x10151d,
        roughness: 0.6,
        metalness: 0.3,
        emissive: 0x5eb3ff,
        emissiveMap: sp.padTex,
        emissiveIntensity: 0.4,
      }),
    );
    const ps = lead ? 2.1 : 1.2;
    this.pad.scale.set(ps, 1, ps);
    this.pad.position.y = PAD_TOP;

    // İsim etiketi (çip + ad): pedin önünde; yalnızca seçili session'da ya da hover'da.
    const tagEl = el('div', 'alabel bot-tag');
    this.tagDot = el('i', 'swatch');
    this.tagDot.setAttribute('aria-hidden', 'true');
    this.tagDot.style.background = shellHex;
    this.tagChip = el('span', 'tchip');
    this.tagName = el('span', '');
    tagEl.append(this.tagDot, this.tagChip, this.tagName);
    this.tag = labelObject(tagEl, 0.5, 0);
    this.tag.position.set(0, PAD_TOP, ps * 0.5 + 0.05);
    this.tag.visible = false;

    this.group.add(this.pad, this.root, this.tag);
    for (const m of [this.head, glass, hit, this.pad])
      env.picks.add(m, { kind: 'agent', sessionId, agentId: agent.id });
  }

  /** Takım değişti ya da projenin rengi ayarlardan değişti. */
  setShell(hex: string): void {
    if (hex === this.shellHex) return;
    this.shellHex = hex;
    // Boya geometrileri renk başına paylaşılır: renk değişince yalnızca geometri değişir.
    this.head.geometry = P.bodyPaint(hex, this.isLead);
    this.armPaints.forEach((m, i) => (m.geometry = P.armPaint(hex, i === 0 ? -1 : 1)));
    for (const m of this.legPaints) m.geometry = P.legPaint(hex);
    this.tagDot.style.background = hex;
  }

  get isLead(): boolean {
    return this.agent.isMain;
  }

  /**
   * Pedin crew yerelindeki yeri. `walkFrom`: yeni alt ajan liderin pedinden yürüyerek gelir (ped yerinde
   * belirir, robot yolu yürür). Hareketi azalt açıkken ya da ilk kurulumda anında.
   */
  setHome(x: number, z: number, nowMs: number, walkFrom: { x: number; z: number } | null): void {
    const changed = x !== this.home.x || z !== this.home.z;
    this.home = { x, z };
    this.pad.position.set(x, PAD_TOP, z);
    this.tag.position.x = x;
    this.tag.position.z = z + this.pad.scale.z * 0.5 + 0.05;
    if (walkFrom && !this.env.reducedMotion) {
      this.from = { ...walkFrom };
      this.walkStart = nowMs;
      this.root.position.set(walkFrom.x, FOOT_Y, walkFrom.z);
    } else if (changed || this.walkStart === null) {
      if (this.walkStart !== null && !this.env.reducedMotion) {
        // Yürürken yeri değişti: bulunduğu yerden yeni pedine yürür.
        this.from = { x: this.root.position.x, z: this.root.position.z };
        this.walkStart = nowMs;
      } else {
        this.walkStart = null;
        this.root.position.set(x, FOOT_Y, z);
      }
    }
    if (!this.isLead) this.setTrace(x, z);
  }

  /** Lider pedinden bu pede devre izi (lider crew yerelinde (0,0)). */
  private setTrace(x: number, z: number): void {
    const pts = tracePoints({ x, z }).map((p) => new THREE.Vector3(p.x, p.y, p.z));
    if (!this.trace) {
      this.trace = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0x2c3646, transparent: true, opacity: 0.95 }),
      );
      this.group.add(this.trace);
      return;
    }
    this.trace.geometry.setFromPoints(pts);
    this.trace.geometry.computeBoundingSphere();
  }

  get walking(): boolean {
    return this.walkStart !== null;
  }

  /** Snapshot ya da saniyelik etiket tiki: durum, renkler, baloncuk, etiket metni. */
  apply(agent: AgentView, session: SessionView, now: number, wallMs: number): void {
    this.agent = agent;
    let st = botState(agent, session, now);
    // "Ajan bitti" olayı snapshot'tan önce gelir: kısa süre bitmiş gibi göster.
    if (this.poweredDownAt !== null) {
      if (st === 'off' || wallMs - this.poweredDownAt > POWER_HOLD_MS) this.poweredDownAt = null;
      else st = 'off';
    }
    this.state = st;
    const look = botLook(st, agent);
    const key = `${look.eye}|${look.pad}|${look.padIntensity}|${look.eyeGlow}|${look.trace}`;
    if (key !== this.lookKey) {
      this.eyeMat.color.set(look.eye);
      this.eyeGlow.material.color.set(look.eye);
      this.eyeGlow.material.opacity = look.eyeGlow * 0.85;
      this.pad.material.emissive.set(look.pad);
      this.pad.material.emissiveIntensity = look.padIntensity;
      this.trace?.material.color.set(look.trace);
      this.lookKey = key;
    }
    this.look = look;
    for (const e of this.eyes) e.scale.set(1, look.lid, 1);
    const mk = mouthFor(st);
    for (const [k, m] of Object.entries(this.mouths)) m.visible = k === mk;
    if (this.env.reducedMotion) this.applyStillPose();
    this.updateBubble(session, now);
    const chip = agentChip(agent);
    setText(this.tagChip, chip.label);
    if (this.tagChip.style.background !== chip.bg) this.tagChip.style.background = chip.bg;
    if (this.tagChip.style.color !== chip.fg) this.tagChip.style.color = chip.fg;
    setText(this.tagName, botName(agent));
    this.syncTag();
  }

  private session: SessionView | null = null;
  private now = 0;
  private updateBubble(session: SessionView, now: number): void {
    this.session = session;
    this.now = now;
    const b = bubbleFor(this.state, this.agent, session, now, this.selected || this.hovered);
    if (!b) {
      if (this.bubble) {
        this.bubble.removeFromParent();
        this.bubble = null;
        this.bubbleText = '';
        this.bubbleTone = '';
      }
      return;
    }
    if (!this.bubble) {
      this.bubble = labelObject(el('div', 'bubble'), 0.5, 1);
      this.bubble.position.set(0, BUBBLE_Y, 0);
      this.root.add(this.bubble);
    }
    const node = this.bubble.element;
    if (b.text !== this.bubbleText) {
      node.textContent = b.text;
      this.bubbleText = b.text;
    }
    if (b.tone !== this.bubbleTone) {
      node.className = `bubble ${b.tone}`;
      this.bubbleTone = b.tone;
    }
  }

  /** İsim etiketi: hover'da her zaman; seçili ekipte yalnızca kamera yakınken (uzakta etiketler üst üste biner). */
  private syncTag(): void {
    this.tag.visible = this.hovered || (this.selected && this.close);
  }

  setSelected(on: boolean): void {
    if (on === this.selected) return;
    this.selected = on;
    this.syncTag();
    if (this.session) this.updateBubble(this.session, this.now);
  }

  setHovered(on: boolean): void {
    if (on === this.hovered) return;
    this.hovered = on;
    this.syncTag();
    if (this.session) this.updateBubble(this.session, this.now);
  }

  /** "Ajan bitti" olayı (06): gözler hemen söner; snapshot doğrulayana kadar en fazla 3 sn. */
  powerDown(wallMs: number): void {
    this.poweredDownAt = wallMs;
    if (this.session) this.apply(this.agent, this.session, this.now, wallMs);
  }

  /** Yeni ajan olayı (06): ajan zaten görünüyorsa liderin pedinden tekrar yürüyerek gelmez; yalnızca belirir. */
  spawnFrom(origin: { x: number; z: number }, nowMs: number): void {
    if (this.isLead || this.env.reducedMotion || this.walkStart !== null) return;
    this.setHome(this.home.x, this.home.z, nowMs, origin);
  }

  /** Hareketi azalt: yalnızca renk ve şekil; poz sabit, durum şekille anlatılır (kalkık kol, eğik baş). */
  private applyStillPose(): void {
    const st = this.state;
    const [L, R] = this.arms as [THREE.Group, THREE.Group];
    L.rotation.set(st === 'work' || st === 'slow' ? -0.9 : 0, 0, 0);
    // Onay: sağ kol yana-yukarı kalkık.
    R.rotation.set(st === 'work' || st === 'slow' ? -0.9 : st === 'ask' ? -0.35 : 0, 0, st === 'ask' ? 2.55 : 0);
    this.body.rotation.set(st === 'sleep' ? 0.12 : st === 'off' ? 0.22 : 0, 0, 0);
    // Boşta ve bitince oturur (hareketsiz de olsa poz durumu anlatır).
    this.sit = sitsDown(st) ? 1 : 0;
    const sp = sitPose(this.sit);
    this.root.position.y = FOOT_Y - sp.drop * this.scale;
    this.legs.forEach((l, i) => l.rotation.set(sp.legX, 0, (i === 0 ? 1 : -1) * sp.legZ));
    if (this.sit > 0) {
      L.rotation.set(sp.armX, 0, -sp.armZ);
      R.rotation.set(sp.armX, 0, sp.armZ);
    }
  }

  /**
   * Her kare (`t` ms, `dt` sn). `face`: çalışırken döneceği nokta, `camera`: onay isterken bakacağı nokta
   * (ikisi de crew yerelinde). Dönüş: döngüden istenen hız.
   */
  step(t: number, dt: number, face: THREE.Vector3 | null, camera: THREE.Vector3 | null): Demand {
    const reduced = this.env.reducedMotion;
    let walking = false;
    if (this.walkStart !== null) {
      const k = walkProgress(this.walkStart, t);
      this.root.position.x = this.from.x + (this.home.x - this.from.x) * k;
      this.root.position.z = this.from.z + (this.home.z - this.from.z) * k;
      if (k >= 1) this.walkStart = null;
      else walking = true;
    }
    const st = this.state;
    // Uzaklık ayrıntısı: kamera uzaktayken küçük parçalar çizilmez (10×6'da robot başına 5 çizim çağrısı).
    if (camera) {
      const near = camera.distanceToSquared(this.root.position) < DETAIL_DIST * DETAIL_DIST * this.scale;
      if (near !== this.detailed) {
        this.detailed = near;
        for (const o of this.details) o.visible = near;
      }
      const close = camera.distanceToSquared(this.root.position) < TAG_DIST * TAG_DIST;
      if (close !== this.close) {
        this.close = close;
        this.syncTag();
      }
    }
    if (reduced) return botDemand(st, walking, true);

    const tt = t / 1000 + this.seed;
    this.gone = st === 'off' ? Math.min(1, this.gone + dt * 0.5) : Math.max(0, this.gone - dt * 2);
    const work = st === 'work' || st === 'slow';
    const bob = work
      ? Math.abs(Math.sin(tt * 7)) * 0.035
      : walking
        ? Math.abs(Math.sin(tt * 10)) * 0.06
        : st === 'off'
          ? 0
          : Math.sin(tt * 1.6) * 0.012;
    // Oturma: boştayken pede oturur, iş gelince kalkar (yürürken hep ayakta).
    const sitTarget = sitsDown(st) && !walking ? 1 : 0;
    this.sit += (sitTarget - this.sit) * Math.min(1, dt * 3.5);
    if (Math.abs(sitTarget - this.sit) < 0.002) this.sit = sitTarget;
    const sp = sitPose(this.sit);
    this.root.position.y = FOOT_Y + (bob * (1 - this.sit) - this.gone * 0.1 - sp.drop) * this.scale;

    // Yön: yürürken gittiği yere, çalışırken hedefine, onay isterken kameraya; koordinatör tarar.
    let yawT = 0;
    const p = this.root.position;
    if (walking) yawT = Math.atan2(this.home.x - this.from.x, this.home.z - this.from.z);
    else if (work && face) yawT = Math.atan2(face.x - p.x, face.z - p.z);
    else if (st === 'ask' && camera) yawT = Math.atan2(camera.x - p.x, camera.z - p.z);
    else if (st === 'watch') yawT = Math.sin(tt * 0.7) * 0.7;
    else if (st === 'think') yawT = Math.sin(tt * 0.4) * 0.25;
    let d = yawT - this.yaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.yaw += d * Math.min(1, dt * 4);
    this.root.rotation.y = this.yaw;
    const turning = Math.abs(d) > 0.02;

    this.body.rotation.x = st === 'sleep' ? 0.12 : st === 'off' ? 0.22 * this.gone : work ? 0.08 : 0;
    const [L, R] = this.arms as [THREE.Group, THREE.Group];
    if (work) {
      L.rotation.set(-0.9 + Math.sin(tt * 14) * 0.25, 0, 0);
      R.rotation.set(-0.9 + Math.sin(tt * 14 + 1.7) * 0.25, 0, 0);
    } else if (st === 'ask') {
      // Sağ kol yana-yukarı kalkık, el sallar.
      L.rotation.set(0.05, 0, 0);
      R.rotation.set(-0.35, 0, 2.55 + Math.sin(tt * 6) * 0.18);
    } else {
      // Ayakta kollar sarkar; oturunca eller kucakta.
      const sway = Math.sin(tt * 1.6) * 0.06 * (1 - this.sit);
      L.rotation.set(sway + sp.armX, 0, -sp.armZ);
      R.rotation.set(Math.sin(tt * 1.6 + 1) * 0.06 * (1 - this.sit) + sp.armX, 0, sp.armZ);
    }
    const step = walking ? Math.sin(tt * 12) * 0.5 : 0;
    this.legs[0]!.rotation.set(step + sp.legX, 0, sp.legZ);
    this.legs[1]!.rotation.set(-step + sp.legX, 0, -sp.legZ);

    // Göz kırpma ve onay isterken yanıp sönen gözler.
    const look = this.look;
    if (look) {
      const blink = tt % 4.2 < 0.12 ? 0.15 : 1;
      for (const e of this.eyes) e.scale.y = Math.max(0.08, look.lid * blink);
      if (st === 'ask') {
        const on = Math.sin(t / 180) > 0 ? 1 : 0.35;
        this.eyeGlow.material.opacity = 0.85 * on;
        this.eyeMat.color.copy(tmpColor.set(look.eye).multiplyScalar(0.55 + 0.45 * on));
        this.pad.material.emissiveIntensity = 0.55 + 0.3 * Math.sin(t / 260);
      } else if (st === 'slow') {
        this.pad.material.emissiveIntensity = 0.6 + 0.25 * Math.sin(t / 200);
      }
    }
    const demand = botDemand(st, walking, false);
    const sitting = this.sit > 0 && this.sit < 1;
    return turning || sitting || (this.gone > 0 && this.gone < 1) ? DEMAND_ACTIVE : demand;
  }

  /** Kafanın dünya konumu (parçacıklar, kamera odağı). */
  headWorld(): THREE.Vector3 {
    return this.root.localToWorld(new THREE.Vector3(0, HEAD_Y, 0.15));
  }

  /** Kafanın üstü — session etiketi ve parlama efekti. */
  topWorld(): THREE.Vector3 {
    return this.root.localToWorld(tmpV.set(0, HEAD_Y + 0.52, 0)).clone();
  }

  padWorld(): THREE.Vector3 {
    return this.pad.getWorldPosition(new THREE.Vector3());
  }

  get homeLocal(): { x: number; z: number } {
    return { ...this.home };
  }

  dispose(): void {
    this.env.picks.removeTree(this.group);
    this.bubble?.removeFromParent();
    this.bubble = null;
    disposeTree(this.group); // göz, göğüs ışığı, parıltı, ped, iz malzemeleri; paylaşılan geometri/malzeme kalır
  }
}

function setText(e: HTMLElement, t: string): void {
  if (e.textContent !== t) e.textContent = t;
}
