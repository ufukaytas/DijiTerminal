// Düğümlerin paylaştığı ortam (03/05): canvas üretimi, pickable kaydı, etiket tıklamaları, zaman.
// MapScene gerçek tarayıcı değerleriyle kurar; testler sahte canvas ve saatle kurar.
import type * as THREE from 'three';

/** crew: lider pedinin çevresi (yay); agent: robot ve pedi. */
export type PickKind = 'crew' | 'agent' | 'emblem' | 'platform' | 'web';
export interface PickData {
  kind: PickKind;
  sessionId?: string;
  projectId?: string;
  agentId?: string;
}

/** Raycast edilebilir nesnelerin kaydı. Düğümler ekler/çıkarır; MapScene dizi olarak sunar. */
export class PickRegistry {
  private set = new Set<THREE.Object3D>();
  private arr: THREE.Object3D[] | null = null;

  add(o: THREE.Object3D, data: PickData): void {
    o.userData['pick'] = data;
    this.set.add(o);
    this.arr = null;
  }

  /** Bir alt ağaçtaki tüm kayıtlı nesneleri çıkarır. */
  removeTree(root: THREE.Object3D): void {
    root.traverse((o) => {
      if (this.set.delete(o)) this.arr = null;
    });
  }

  get list(): THREE.Object3D[] {
    this.arr ??= [...this.set];
    return this.arr;
  }

  get size(): number {
    return this.set.size;
  }
}

export interface SceneEnv {
  createCanvas(w: number, h: number): HTMLCanvasElement;
  maxAnisotropy: number;
  reducedMotion: boolean;
  glow: THREE.Texture;
  picks: PickRegistry;
  /** Duvar saati (ms) — bekleme süresi, yavaş araç hesapları. */
  now(): number;
  /** Fontlar yüklenince bir kez daha boyamak için (CanvasTexture). */
  fontsReady: Promise<unknown>;
  onSessionClick(sessionId: string): void;
  onSessionDblClick(sessionId: string): void;
}

/** Süreye bağlı doğrusal geçiş (ease-out). Reduced motion'da anında. */
export class Tween {
  private from = 0;
  private to = 0;
  private start = 0;
  private dur = 0;
  value: number;

  constructor(v: number) {
    this.value = v;
    this.to = v;
  }

  get target(): number {
    return this.to;
  }

  set(to: number, durMs: number, nowMs: number, instant = false): void {
    if (to === this.to) return; // zaten orada ya da oraya gidiyor
    if (instant || durMs <= 0) {
      this.value = this.to = to;
      this.dur = 0;
      return;
    }
    this.from = this.value;
    this.to = to;
    this.start = nowMs;
    this.dur = durMs;
  }

  /** Geçiş sürüyor mu (çizim döngüsü bu sürede aktif kalır). */
  get busy(): boolean {
    return this.dur !== 0;
  }

  /** true → değer değişti. */
  step(nowMs: number): boolean {
    if (this.dur === 0) return false;
    const k = Math.min(1, (nowMs - this.start) / this.dur);
    const e = 1 - (1 - k) * (1 - k);
    this.value = this.from + (this.to - this.from) * e;
    if (k >= 1) {
      this.value = this.to;
      this.dur = 0;
    }
    return true;
  }

  get active(): boolean {
    return this.dur !== 0;
  }
}
