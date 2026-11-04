// Parçacık havuzu (03/06 Prompt 3). Sabit kapasite × 3 sprite (baş + 2 kuyruk) başta kurulur;
// çalışma anında nesne üretilmez. Yol ikinci dereceden Bezier; kontrol noktası orta nokta + yukarı yay.
import * as THREE from 'three';
import { disposeTree } from './geometries';

export interface ParticleSpec {
  from: THREE.Vector3;
  to: THREE.Vector3;
  color: string;
  durationMs: number;
  onArrive?: () => void;
}

export const HEADS = 3;
const HEAD_SCALE = [0.75, 0.55, 0.35] as const;
const HEAD_OPACITY = [1, 0.7, 0.4] as const;
const TAIL_LAG = 0.07;
/** t bu değeri geçince slot serbest kalır (kuyruk da hedefe varsın). */
const END_T = 1 + (HEADS - 1) * TAIL_LAG + 0.01;

export function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/** Bezier kontrol noktası: orta nokta, y'de `1.4 + mesafe × 0.18` yukarı (prototiple aynı yay). */
export function arcControl(from: THREE.Vector3, to: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  out.copy(from).lerp(to, 0.5);
  out.y += 1.4 + from.distanceTo(to) * 0.18;
  return out;
}

const colorCache = new Map<string, THREE.Color>();
/** Renk dizgesi başına tek THREE.Color (spawn'da ayrıştırma ve allocation olmasın). */
export function cachedColor(c: string): THREE.Color {
  let v = colorCache.get(c);
  if (!v) {
    v = new THREE.Color(c);
    colorCache.set(c, v);
  }
  return v;
}

interface Slot {
  live: boolean;
  t: number;
  dur: number;
  seq: number;
  arrived: boolean;
  onArrive: (() => void) | null;
  readonly curve: THREE.QuadraticBezierCurve3;
  readonly heads: THREE.Sprite[];
}

export class ParticlePool {
  private readonly slots: Slot[] = [];
  private readonly group = new THREE.Group();
  private seq = 0;
  private live = 0;

  constructor(
    scene: THREE.Object3D,
    readonly capacity = 60,
    map: THREE.Texture | null = null,
  ) {
    this.group.name = 'particles';
    for (let i = 0; i < capacity; i++) {
      const heads: THREE.Sprite[] = [];
      for (let k = 0; k < HEADS; k++) {
        const s = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            transparent: true,
            opacity: HEAD_OPACITY[k],
          }),
        );
        s.scale.setScalar(HEAD_SCALE[k]!);
        s.visible = false;
        s.frustumCulled = false;
        heads.push(s);
        this.group.add(s);
      }
      this.slots.push({
        live: false,
        t: 0,
        dur: 1,
        seq: 0,
        arrived: false,
        onArrive: null,
        curve: new THREE.QuadraticBezierCurve3(new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()),
        heads,
      });
    }
    scene.add(this.group);
  }

  get liveCount(): number {
    return this.live;
  }

  /** Boş slot yoksa en eski parçacık iptal edilip yeniden kullanılır (onArrive çağrılmaz). */
  spawn(p: ParticleSpec): void {
    let slot: Slot | undefined;
    let oldest: Slot | undefined;
    for (const s of this.slots) {
      if (!s.live) {
        slot = s;
        break;
      }
      if (!oldest || s.seq < oldest.seq) oldest = s;
    }
    if (!slot) {
      slot = oldest!;
      this.release(slot);
    }
    slot.curve.v0.copy(p.from);
    slot.curve.v2.copy(p.to);
    arcControl(p.from, p.to, slot.curve.v1);
    slot.t = 0;
    slot.dur = Math.max(1, p.durationMs);
    slot.seq = ++this.seq;
    slot.arrived = false;
    slot.onArrive = p.onArrive ?? null;
    const c = cachedColor(p.color);
    for (const h of slot.heads) {
      h.material.color.copy(c);
      h.visible = false;
    }
    slot.live = true;
    this.live++;
  }

  /** `dt` saniye. */
  update(dt: number): void {
    if (this.live === 0) return;
    for (const s of this.slots) {
      if (!s.live) continue;
      s.t += (dt * 1000) / s.dur;
      for (let k = 0; k < HEADS; k++) {
        const raw = s.t - k * TAIL_LAG;
        const h = s.heads[k]!;
        h.visible = raw > 0;
        if (raw > 0) s.curve.getPoint(easeInOutQuad(Math.min(1, raw)), h.position);
      }
      if (s.t >= 1 && !s.arrived) {
        s.arrived = true;
        const cb = s.onArrive;
        s.onArrive = null;
        cb?.();
      }
      if (s.t >= END_T) this.release(s);
    }
  }

  private release(s: Slot): void {
    if (!s.live) return;
    s.live = false;
    s.onArrive = null;
    for (const h of s.heads) h.visible = false;
    this.live--;
  }

  /** Uçuştaki tüm parçacıkları onArrive çağırmadan bırakır (reduced motion, bağlam yenileme). */
  clear(): void {
    for (const s of this.slots) this.release(s);
  }

  /** Testler için: canlı parçacıkların başlarındaki ilk sprite. */
  sprites(): readonly THREE.Sprite[] {
    return this.group.children as THREE.Sprite[];
  }

  dispose(): void {
    this.clear();
    disposeTree(this.group);
    this.group.clear();
  }
}
