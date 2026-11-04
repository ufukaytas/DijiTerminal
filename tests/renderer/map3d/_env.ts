// 3B harita testleri için sahte ortam: WebGL ve gerçek canvas olmadan düğümleri kurar.
import * as THREE from 'three';
import { PickRegistry, type SceneEnv } from '@renderer/map3d/env';

export interface FakeCtx {
  fillTextCalls: string[];
  clears: number;
  font: string;
}

/** Ölçüm: karakter sayısı × font px × 0.55 (fitName testleri için öngörülebilir). */
export function fakeCanvas(w: number, h: number): HTMLCanvasElement & { ctx: FakeCtx } {
  const ctx = {
    fillTextCalls: [] as string[],
    clears: 0,
    font: '10px x',
    fillStyle: '',
    globalAlpha: 1,
    textBaseline: 'alphabetic',
    clearRect() {
      ctx.clears++;
    },
    fillRect() {},
    fillText(t: string) {
      ctx.fillTextCalls.push(t);
    },
    measureText(t: string) {
      const px = Number(/(\d+)px/.exec(ctx.font)?.[1] ?? 10);
      return { width: t.length * px * 0.55 };
    },
    createRadialGradient() {
      return { addColorStop() {} };
    },
  };
  return { width: w, height: h, getContext: () => ctx, ctx } as unknown as HTMLCanvasElement & { ctx: FakeCtx };
}

export function fakeEnv(over: Partial<SceneEnv> = {}): SceneEnv & { clicks: string[]; activations: string[] } {
  const clicks: string[] = [];
  const activations: string[] = [];
  return {
    createCanvas: fakeCanvas,
    maxAnisotropy: 1,
    reducedMotion: true,
    glow: new THREE.Texture(),
    picks: new PickRegistry(),
    now: () => 1_800_000_000_000,
    fontsReady: new Promise(() => {}),
    onSessionClick: (id) => clicks.push(id),
    onSessionDblClick: (id) => activations.push(id),
    clicks,
    activations,
    ...over,
  };
}

/** Bir alt ağaçtaki malzemelerin dispose çağrılarını sayar. */
export function spyDisposals(root: THREE.Object3D): { count(): number } {
  let n = 0;
  root.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    for (const mat of Array.isArray(m) ? m : m ? [m] : []) {
      mat.addEventListener('dispose', () => n++);
    }
  });
  return { count: () => n };
}
