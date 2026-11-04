// Proje amblemleri (03/05 Prompt 6): her projeye platformun köşesinde dönen mini 3B şekil.
// Amblem geometrileri küçük ve proje başına tek; paylaşılmaz, düğümle birlikte dispose edilir.
import * as THREE from 'three';
import type { EmblemKind } from '@shared/types';

function mat(color: THREE.Color, intensity = 0.35): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: intensity, roughness: 0.4 });
}

/** Amblemin renk değişince güncellenecek malzemeleri. */
function colorables(g: THREE.Group): (THREE.MeshStandardMaterial | THREE.LineBasicMaterial)[] {
  return (g.userData['colorables'] ??= []) as (THREE.MeshStandardMaterial | THREE.LineBasicMaterial)[];
}

function addMesh(g: THREE.Group, geometry: THREE.BufferGeometry, m: THREE.MeshStandardMaterial): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, m);
  colorables(g).push(m);
  g.add(mesh);
  return mesh;
}

export function buildEmblem(kind: EmblemKind, color: THREE.Color): THREE.Group {
  const g = new THREE.Group();
  g.userData['kind'] = kind;
  g.userData['colorables'] = [];
  switch (kind) {
    case 'team': {
      const pts = [0, 1, 2].map((i) => {
        const a = (i / 3) * Math.PI * 2;
        return new THREE.Vector3(Math.cos(a) * 0.38, 0, Math.sin(a) * 0.38);
      });
      const sphere = new THREE.SphereGeometry(0.15, 18, 12);
      pts.forEach((v, i) => {
        const m = addMesh(g, i === 0 ? sphere : sphere.clone(), mat(color));
        m.position.copy(v);
      });
      const top = addMesh(g, new THREE.SphereGeometry(0.17, 18, 12), mat(color));
      top.position.set(0, 0.42, 0);
      const segs: THREE.Vector3[] = [];
      for (const [a, b] of [
        [0, 1],
        [1, 2],
        [2, 0],
      ] as const)
        segs.push(pts[a]!, pts[b]!);
      for (const v of pts) segs.push(v, top.position);
      const lm = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.7 });
      colorables(g).push(lm);
      g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(segs), lm));
      break;
    }
    case 'ring': {
      const page = addMesh(g, new THREE.BoxGeometry(0.42, 0.56, 0.04), mat(color));
      page.position.y = 0.15;
      for (const dy of [0.08, 0, -0.08]) {
        const l = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.03, 0.05), new THREE.MeshBasicMaterial({ color: 0x0f131a }));
        l.position.set(0, 0.2 + dy, 0);
        g.add(l);
      }
      const ring = addMesh(g, new THREE.TorusGeometry(0.52, 0.03, 8, 64), mat(color));
      ring.position.y = 0.15;
      ring.rotation.x = 1.2;
      g.userData['ring'] = ring;
      break;
    }
    case 'stack': {
      for (let i = 0; i < 3; i++) {
        const m = addMesh(g, new THREE.BoxGeometry(0.72, 0.06, 0.52), mat(color, 0.2 + i * 0.12));
        m.position.set(i * 0.06 - 0.06, i * 0.17, i * -0.05 + 0.05);
      }
      break;
    }
    case 'wave': {
      const bars = [0.35, 0.7, 1, 0.55, 0.85, 0.4].map((h, i) => {
        const m = addMesh(g, new THREE.BoxGeometry(0.1, 0.6, 0.1), mat(color));
        m.position.set((i - 2.5) * 0.15, 0, 0);
        m.scale.y = h;
        m.userData['h'] = h;
        return m;
      });
      g.userData['bars'] = bars;
      break;
    }
    case 'prism': {
      const geom = new THREE.CylinderGeometry(0.35, 0.35, 0.55, 3);
      const m = addMesh(g, geom, mat(color));
      m.position.y = 0.2;
      const lm = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.8 });
      colorables(g).push(lm);
      const wire = new THREE.LineSegments(new THREE.EdgesGeometry(geom), lm);
      wire.position.copy(m.position);
      wire.scale.setScalar(1.06);
      g.add(wire);
      break;
    }
    case 'cube': {
      const geom = new THREE.BoxGeometry(0.5, 0.5, 0.5);
      const m = addMesh(g, geom, mat(color));
      m.position.y = 0.2;
      const lm = new THREE.LineBasicMaterial({ color: 0xe4e8ef, transparent: true, opacity: 0.5 });
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geom), lm);
      edges.position.copy(m.position);
      edges.scale.setScalar(1.02);
      g.add(edges);
      break;
    }
  }
  return g;
}

export function setEmblemColor(g: THREE.Group, color: THREE.Color): void {
  for (const m of colorables(g)) {
    m.color.copy(color);
    if (m instanceof THREE.MeshStandardMaterial) m.emissive.copy(color);
  }
}

/** Her kare: y ekseninde dönüş ve türe özgü hareket. `t` ms, `dt` sn. */
export function tickEmblem(g: THREE.Group, t: number, dt: number): void {
  g.rotation.y += dt * 0.45;
  const ring = g.userData['ring'] as THREE.Mesh | undefined;
  if (ring) ring.rotation.z += dt * 0.9;
  const bars = g.userData['bars'] as THREE.Mesh[] | undefined;
  if (bars) {
    bars.forEach((b, i) => {
      b.scale.y = (b.userData['h'] as number) * (0.55 + 0.45 * Math.abs(Math.sin(t / 260 + i * 0.9)));
    });
  }
}

/** Amblemin raycast'e girecek parçaları (meshler). */
export function emblemMeshes(g: THREE.Group): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh);
  });
  return out;
}
