// Kamera pozları (03/07). Saf fonksiyonlar (WebGL'siz), birim testli.
import * as THREE from 'three';
import { WEB_R } from './geometries';
import { gridLayout, type GridExtent } from './layout';
import { WEB_CENTER } from './web';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}
export interface Pose {
  pos: Vec3;
  target: Vec3;
}

export const HOME_BASE: Readonly<Pose> = { pos: { x: 1.5, y: 23, z: 28 }, target: { x: 0, y: 0.4, z: 1.6 } };
/** Ev konumunun bakış yönü (hedeften kameraya) sabit; yalnızca hedef ve mesafe sahneye göre değişir. */
export const HOME_DIR: Readonly<Vec3> = (() => {
  const d = new THREE.Vector3(
    HOME_BASE.pos.x - HOME_BASE.target.x,
    HOME_BASE.pos.y - HOME_BASE.target.y,
    HOME_BASE.pos.z - HOME_BASE.target.z,
  ).normalize();
  return { x: d.x, y: d.y, z: d.z };
})();
export const CAMERA_FOV = 38;
/** Sahne bu NDC kutusuna sığar: üstte ipucu satırı, altta lejant için pay. */
export const HOME_BOX = { minX: -0.94, maxX: 0.94, minY: -0.9, maxY: 0.86 } as const;
/** Kamera en fazla bu kadar yaklaşır / uzaklaşır (tek projede aşırı yakınlaşma olmasın). */
const DIST_MIN = 15;
export const DIST_MAX = 160;
/** Platform yarı boyutları (BoxGeometry 12.6 × 8.4). */
const PLAT_HW = 6.3;
const PLAT_HD = 4.2;

/** Ev konumunda kadraja girmesi gereken noktalar: web küresinin tepesi ve iki yanı (ağ dahil), platform köşeleri. */
export function sceneBounds(n: number): Vec3[] {
  const r = WEB_R * 1.45;
  const c = WEB_CENTER;
  const pts: Vec3[] = [
    { x: c.x, y: c.y + r, z: c.z },
    { x: c.x - r, y: c.y, z: c.z },
    { x: c.x + r, y: c.y, z: c.z },
  ];
  for (const p of gridLayout(Math.max(1, n)))
    for (const dx of [-PLAT_HW, PLAT_HW])
      for (const dz of [-PLAT_HD, PLAT_HD]) pts.push({ x: p.x + dx, y: 0.3, z: p.z + dz });
  return pts;
}

/** Noktaların verilen pozdaki NDC kutusu. */
export function projectedBox(
  pose: Pose,
  aspect: number,
  pts: readonly Vec3[],
): { minX: number; maxX: number; minY: number; maxY: number } {
  const cam = new THREE.PerspectiveCamera(CAMERA_FOV, aspect, 0.1, 400);
  cam.position.set(pose.pos.x, pose.pos.y, pose.pos.z);
  cam.lookAt(pose.target.x, pose.target.y, pose.target.z);
  cam.updateMatrixWorld();
  const v = new THREE.Vector3();
  const box = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  for (const p of pts) {
    v.set(p.x, p.y, p.z).project(cam);
    box.minX = Math.min(box.minX, v.x);
    box.maxX = Math.max(box.maxX, v.x);
    box.minY = Math.min(box.minY, v.y);
    box.maxY = Math.max(box.maxY, v.y);
  }
  return box;
}

const poseAt = (t: THREE.Vector3, dist: number): Pose => ({
  pos: { x: t.x + HOME_DIR.x * dist, y: t.y + HOME_DIR.y * dist, z: t.z + HOME_DIR.z * dist },
  target: { x: t.x, y: t.y, z: t.z },
});

/**
 * "Tümü" ev konumu: bütün sahne (üstte ağıyla web küresi, altta her platform) her en-boy oranında küçük bir
 * payla kadraja sığar ve dikeyde ortalanır. Bakış yönü sabit (HOME_DIR); hedef noktaların ortalamasından başlar,
 * ikili aramayla kutuya sığan en yakın mesafe bulunur, sonra hedef yansıtılmış kutunun ortasına kaydırılır (3 tur).
 * Geniş ekranda küre üstten kesilmez, platformlar üst yarıda kalmaz.
 */
export function homePose(aspect: number, grid: Pick<GridExtent, 'n'>): Pose {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1.5;
  const pts = sceneBounds(grid.n);
  const target = new THREE.Vector3();
  for (const p of pts) target.add(new THREE.Vector3(p.x, p.y, p.z));
  target.divideScalar(pts.length);
  const fits = (b: ReturnType<typeof projectedBox>) =>
    b.minX > HOME_BOX.minX && b.maxX < HOME_BOX.maxX && b.minY > HOME_BOX.minY && b.maxY < HOME_BOX.maxY;
  // Kameranın sağ ve yukarı eksenleri (bakış yönü sabit olduğu için hedeften bağımsız).
  const cam = new THREE.PerspectiveCamera(CAMERA_FOV, a, 0.1, 400);
  cam.position.set(HOME_DIR.x, HOME_DIR.y, HOME_DIR.z);
  cam.lookAt(0, 0, 0);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
  const midY = (HOME_BOX.maxY + HOME_BOX.minY) / 2;
  const midX = (HOME_BOX.maxX + HOME_BOX.minX) / 2;
  let dist = DIST_MAX;
  for (let pass = 0; pass < 3; pass++) {
    let lo = DIST_MIN;
    let hi = DIST_MAX;
    if (fits(projectedBox(poseAt(target, lo), a, pts))) hi = lo;
    else
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        if (fits(projectedBox(poseAt(target, mid), a, pts))) hi = mid;
        else lo = mid;
      }
    dist = hi;
    const b = projectedBox(poseAt(target, dist), a, pts);
    const halfH = Math.tan((CAMERA_FOV * Math.PI) / 360) * dist;
    target
      .addScaledVector(up, ((b.maxY + b.minY) / 2 - midY) * halfH)
      .addScaledVector(right, ((b.maxX + b.minX) / 2 - midX) * halfH * a);
  }
  // Son kaydırmadan sonra hâlâ sığdığından emin ol (kaydırma kutuyu büyütmez ama yuvarlama payı).
  while (dist < DIST_MAX && !fits(projectedBox(poseAt(target, dist), a, pts))) dist *= 1.01;
  return poseAt(target, dist);
}

/** Bir noktaya bakış: hedef + (0.18d, 0.78d, 0.82d). */
export function focusPose(target: Vec3, dist: number): Pose {
  return {
    pos: { x: target.x + dist * 0.18, y: target.y + dist * 0.78, z: target.z + dist * 0.82 },
    target: { ...target },
  };
}

/** Kare hızından bağımsız lerp katsayısı: 60 Hz'de `base`, 120 Hz'de iki karede aynı yol. */
export function lerpAlpha(dt: number, base = 0.07): number {
  if (!(dt > 0)) return 0;
  return 1 - Math.pow(1 - base, dt * 60);
}

/** Robot ekibi (03/08) eski antenden geniş: lider + alt ajan pedleri ve üstteki etiket kadrajda kalsın. */
export const SESSION_FOCUS_DIST = 19;
export const PROJECT_FOCUS_DIST = 19;
