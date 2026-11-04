// Kamera, seçim ve etkileşim (03/07). OrbitControls ile gezinme, tıklama/sürükleme ayrımlı raycast,
// seçimde ve proje odağında yumuşak kamera uçuşu, en-boy oranına duyarlı "Tümü" ev konumu.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { DIST_MAX, focusPose, homePose, lerpAlpha, PROJECT_FOCUS_DIST, SESSION_FOCUS_DIST, type Pose } from './camera';
import type { PickData } from './env';
import type { GridExtent } from './layout';
import { DEMAND_ACTIVE, DEMAND_NONE, type Demand } from './renderLoop';
import type { SceneAnchors, SceneInteraction } from './scene';

export type SelectSource = 'map' | 'store';

/** Etkileşimin sahneden beklediği yüzey (MapScene bunu sağlar; testler sahte verir). */
export interface InteractionHost {
  readonly camera: THREE.PerspectiveCamera;
  readonly domElement: HTMLElement;
  readonly pickables: THREE.Object3D[];
  readonly anchors: SceneAnchors;
  readonly reducedMotion: boolean;
  readonly extent: GridExtent;
  onFrame(cb: (t: number, dt: number) => void): () => void;
  /** Çizim döngüsünü uyandır (seyrek moddaysa beklemeden bir kare). */
  requestFrame?(): void;
}

/** OrbitControls'ün kullandığımız kısmı (testlerde sahte kontrol verilir). */
export interface ControlsLike {
  target: THREE.Vector3;
  enableDamping: boolean;
  dampingFactor: number;
  maxPolarAngle: number;
  minDistance: number;
  maxDistance: number;
  enablePan: boolean;
  update(): boolean;
  addEventListener(type: 'start' | 'end' | 'change', cb: () => void): void;
  removeEventListener(type: 'start' | 'end' | 'change', cb: () => void): void;
  dispose(): void;
}

export interface MapInteractionOptions {
  /** `agentId`: robota tıklandıysa o ajan (Seçili Session panelinde satırı vurgulanır). */
  onSelect(sessionId: string, source: SelectSource, agentId?: string): void;
  firstSessionOfProject(projectId: string): string | null;
  /** Robota/ekibe çift tıklama: terminali öne getir (04/01). */
  onActivate?(sessionId: string): void;
  /** İmlecin altındaki nesne (null → hiçbiri); ipucu kartı ve isim etiketi için. */
  onHover?(pick: PickData | null, clientX: number, clientY: number): void;
  createControls?(camera: THREE.PerspectiveCamera, el: HTMLElement): ControlsLike;
  /** Sayfa gizliyken (bildirimden seçim) uçuş yerine anında yerleş. */
  isHidden?(): boolean;
}

export const CLICK_SLOP_PX = 5;
const HOVER_THROTTLE_MS = 60;
const ARRIVE_EPS = 0.05;

interface Flight {
  pos: THREE.Vector3;
  target: THREE.Vector3;
  home: boolean;
}

const v = (p: { x: number; y: number; z: number }) => new THREE.Vector3(p.x, p.y, p.z);

export class MapInteraction implements SceneInteraction {
  readonly controls: ControlsLike;
  private fly: Flight | null = null;
  private _userMoved = false;
  private aspect = 1.5;
  private extent: GridExtent;
  private down: { x: number; y: number; button: number; moved: boolean } | null = null;
  private dragging = false;
  /** Son karede kontroller kamerayı oynattı mı (sönümleme sürüyor). */
  private moved = false;
  private hoverAt = 0;
  private readonly ray = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly offs: (() => void)[] = [];

  constructor(
    private readonly host: InteractionHost,
    private readonly opts: MapInteractionOptions,
  ) {
    this.extent = host.extent;
    const c = (opts.createControls ?? ((cam, el) => new OrbitControls(cam, el) as unknown as ControlsLike))(
      host.camera,
      host.domElement,
    );
    c.enableDamping = true;
    c.dampingFactor = 0.08;
    c.maxPolarAngle = 1.32;
    c.minDistance = 7;
    c.maxDistance = DIST_MAX; // sahneye sığdırılmış ev konumu (çok projede uzak) sınırda kalmasın
    c.enablePan = true;
    const home = this.homePose();
    host.camera.position.copy(v(home.pos));
    c.target.copy(v(home.target));
    host.camera.lookAt(c.target);
    // 'start' tıklamada da gelir; kullanıcı hareketi yalnızca gerçek sürükleme/tekerlekle sayılır.
    const onStart = () => {
      this.dragging = true;
      host.domElement.style.cursor = 'grabbing';
    };
    const onEnd = () => {
      this.dragging = false;
      host.domElement.style.cursor = 'grab';
    };
    // Sürükleme/tekerlek kamerayı kontrolün kendi olay işleyicisinde oynatır: döngü uyanmalı.
    const onChange = () => this.wake();
    c.addEventListener('start', onStart);
    c.addEventListener('end', onEnd);
    c.addEventListener('change', onChange);
    this.offs.push(() => {
      c.removeEventListener('start', onStart);
      c.removeEventListener('end', onEnd);
      c.removeEventListener('change', onChange);
    });
    this.controls = c;

    const el = host.domElement;
    el.style.cursor = 'grab';
    const pd = (e: PointerEvent) => {
      this.down = { x: e.clientX, y: e.clientY, button: e.button, moved: false };
      this.wake();
    };
    const pu = (e: PointerEvent) => {
      const d = this.down;
      this.down = null;
      if (!d || d.button !== 0 || e.button !== 0) return;
      if (d.moved || Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_SLOP_PX) return;
      this.click(e.clientX, e.clientY);
    };
    const pm = (e: PointerEvent) => {
      const d = this.down;
      if (d) {
        // Sürükleme başladı: uçuş iptal, kamera artık kullanıcıda.
        if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_SLOP_PX) {
          d.moved = true;
          this.setHover(null, 0, 0);
          this.userTookOver();
        }
        return;
      }
      if (this.dragging) return;
      const t = performance.now();
      if (t - this.hoverAt < HOVER_THROTTLE_MS) return;
      this.hoverAt = t;
      const p = this.hit(e.clientX, e.clientY);
      el.style.cursor = p ? 'pointer' : 'grab';
      this.setHover(p, e.clientX, e.clientY);
    };
    const leave = () => this.setHover(null, 0, 0);
    const wheel = () => this.userTookOver();
    const dbl = (e: MouseEvent) => {
      const p = this.hit(e.clientX, e.clientY);
      if (p?.sessionId && (p.kind === 'crew' || p.kind === 'agent')) this.opts.onActivate?.(p.sessionId);
    };
    el.addEventListener('dblclick', dbl);
    this.offs.push(() => el.removeEventListener('dblclick', dbl));
    const cancel = () => {
      this.down = null;
    };
    el.addEventListener('pointerdown', pd);
    el.addEventListener('pointerup', pu);
    el.addEventListener('pointermove', pm);
    el.addEventListener('pointercancel', cancel);
    el.addEventListener('pointerleave', leave);
    el.addEventListener('wheel', wheel, { passive: true });
    this.offs.push(() => {
      el.removeEventListener('pointerleave', leave);
      el.removeEventListener('pointerdown', pd);
      el.removeEventListener('pointerup', pu);
      el.removeEventListener('pointermove', pm);
      el.removeEventListener('pointercancel', cancel);
      el.removeEventListener('wheel', wheel);
    });
    this.offs.push(host.onFrame((_t, dt) => this.frame(dt)));
  }

  private hoverKey = '';
  private setHover(p: PickData | null, x: number, y: number): void {
    const key = p ? `${p.kind}|${p.sessionId ?? ''}|${p.agentId ?? ''}|${p.projectId ?? ''}` : '';
    // Aynı nesne üzerinde imleç hareketi de bildirilir (ipucu kartı imleci izler).
    if (!p && key === this.hoverKey) return;
    this.hoverKey = key;
    this.opts.onHover?.(p, x, y);
  }

  private userTookOver(): void {
    this.fly = null;
    this._userMoved = true;
    this.wake();
  }

  private wake(): void {
    this.host.requestFrame?.();
  }

  /** Çizim döngüsüne ihtiyaç: uçuş, sürükleme ya da sönümleme sürüyorsa tam hız. */
  demand(): Demand {
    return this.fly || this.dragging || this.moved ? DEMAND_ACTIVE : DEMAND_NONE;
  }

  get userMoved(): boolean {
    return this._userMoved;
  }

  get flying(): boolean {
    return this.fly !== null;
  }

  /** CSS piksel koordinatından ilk isabet (DPR'den bağımsız). */
  hit(clientX: number, clientY: number): PickData | null {
    const r = this.host.domElement.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    this.ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.host.camera.updateMatrixWorld();
    this.ray.setFromCamera(this.ndc, this.host.camera);
    const h = this.ray.intersectObjects(this.host.pickables, false)[0];
    return (h?.object.userData['pick'] as PickData | undefined) ?? null;
  }

  private click(x: number, y: number): void {
    const p = this.hit(x, y);
    if (!p) return; // boşluğa tık seçimi temizlemez
    if ((p.kind === 'crew' || p.kind === 'agent') && p.sessionId) {
      if (p.agentId) this.opts.onSelect(p.sessionId, 'map', p.agentId);
      else this.opts.onSelect(p.sessionId, 'map');
      this.focusSession(p.sessionId);
      return;
    }
    if (p.kind === 'web') this.focusWeb();
    if ((p.kind === 'emblem' || p.kind === 'platform') && p.projectId) {
      const sid = this.opts.firstSessionOfProject(p.projectId);
      if (sid) this.opts.onSelect(sid, 'map');
      this.focusProject(p.projectId);
    }
  }

  private homePose(): Pose {
    return homePose(this.aspect, this.extent);
  }

  private goTo(pose: Pose, home: boolean): void {
    const pos = v(pose.pos);
    const target = v(pose.target);
    if (this.host.reducedMotion || this.opts.isHidden?.()) {
      this.host.camera.position.copy(pos);
      this.controls.target.copy(target);
      this.fly = null;
      this.controls.update();
      this.wake();
      return;
    }
    this.fly = { pos, target, home };
    this.wake();
  }

  focusSession(sessionId: string): void {
    const top = this.host.anchors.sessionTop(sessionId);
    if (!top) return; // session görünmüyor / bitti: kamera yerinde kalır
    top.y = 1.6;
    this._userMoved = true;
    this.goTo(focusPose(top, SESSION_FOCUS_DIST), false);
  }

  /** Web küresine yakın plan (rozet ya da küreye tıklama). */
  focusWeb(): void {
    const c = this.host.anchors.webCenter();
    this._userMoved = true;
    this.goTo({ pos: { x: c.x, y: c.y - 1.5, z: c.z + 11 }, target: { x: c.x, y: c.y - 0.6, z: c.z } }, false);
  }

  focusProject(projectId: string | 'all'): void {
    if (projectId === 'all') {
      this._userMoved = false;
      this.goTo(this.homePose(), true);
      return;
    }
    const c = this.host.anchors.projectCenter(projectId);
    if (!c) return;
    c.y = 1.5;
    this._userMoved = true;
    this.goTo(focusPose(c, PROJECT_FOCUS_DIST), false);
  }

  onResize(aspect: number): void {
    if (!(aspect > 0)) return;
    this.aspect = aspect;
    this.rehome();
  }

  onGridChanged(extent: GridExtent): void {
    this.extent = extent;
    this.rehome();
  }

  /** Kullanıcı kamerayı oynatmadıysa ev konumunu yeni ölçüye uydur. */
  private rehome(): void {
    const home = this.homePose();
    if (this.fly?.home) {
      this.fly.pos.copy(v(home.pos));
      this.fly.target.copy(v(home.target));
      return;
    }
    if (this._userMoved || this.fly) return;
    this.host.camera.position.copy(v(home.pos));
    this.controls.target.copy(v(home.target));
    this.wake();
  }

  /** Klavye: Esc ev, +/- yakınlaş/uzaklaş, oklar hedef etrafında 10° döndür. true → işlendi. */
  handleKey(key: string): boolean {
    switch (key) {
      case 'Escape':
        this.focusProject('all');
        return true;
      case '+':
      case '=':
        this.dolly(0.85);
        return true;
      case '-':
      case '_':
        this.dolly(1 / 0.85);
        return true;
      case 'ArrowLeft':
        this.orbit(10);
        return true;
      case 'ArrowRight':
        this.orbit(-10);
        return true;
      case 'ArrowUp':
        this.tilt(-10);
        return true;
      case 'ArrowDown':
        this.tilt(10);
        return true;
      default:
        return false;
    }
  }

  private dolly(k: number): void {
    const cam = this.host.camera.position;
    const off = cam.clone().sub(this.controls.target);
    const d = THREE.MathUtils.clamp(off.length() * k, this.controls.minDistance, this.controls.maxDistance);
    off.setLength(d);
    this.fly = null;
    this._userMoved = true;
    cam.copy(this.controls.target).add(off);
    this.wake();
  }

  private orbit(deg: number): void {
    const cam = this.host.camera.position;
    const off = cam.clone().sub(this.controls.target);
    off.applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(deg));
    this.fly = null;
    this._userMoved = true;
    cam.copy(this.controls.target).add(off);
    this.wake();
  }

  private tilt(deg: number): void {
    const cam = this.host.camera.position;
    const s = new THREE.Spherical().setFromVector3(cam.clone().sub(this.controls.target));
    s.phi = THREE.MathUtils.clamp(s.phi + THREE.MathUtils.degToRad(deg), 0.15, this.controls.maxPolarAngle);
    this.fly = null;
    this._userMoved = true;
    cam.copy(this.controls.target).add(new THREE.Vector3().setFromSpherical(s));
    this.wake();
  }

  private frame(dt: number): void {
    const f = this.fly;
    if (f) {
      const a = lerpAlpha(dt);
      this.host.camera.position.lerp(f.pos, a);
      this.controls.target.lerp(f.target, a);
      if (
        this.host.camera.position.distanceTo(f.pos) < ARRIVE_EPS &&
        this.controls.target.distanceTo(f.target) < ARRIVE_EPS
      ) {
        this.host.camera.position.copy(f.pos);
        this.controls.target.copy(f.target);
        this.fly = null;
      }
    }
    this.moved = this.controls.update();
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off();
    this.controls.dispose();
    this.fly = null;
  }
}
