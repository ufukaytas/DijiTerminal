// Paylaşılan geometri önbelleği ve kaynak temizliği (03/05).
// Geometriler şekil başına bir kez oluşturulur; renk düğüm başına malzemede tutulur.
// Böylece GPU geometri sayısı proje/session sayısıyla değil şekil türü sayısıyla büyür.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

type Key =
  | 'platform'
  | 'platformEdges'
  | 'namePlane'
  | 'pedestal'
  | 'waitRing'
  | 'fileCube'
  | 'pad'
  | 'crewArcBg'
  | 'crewWait'
  | 'crewSel'
  // Web küresi (03/06 web halkasının yerini aldı).
  | 'webCore'
  | 'webRim'
  | 'webSat'
  | 'webPing';

/** Anahtarlı paylaşılan geometriler (`geo` ve `geoKeyed` aynı önbelleği kullanır). */
const cache = new Map<string, THREE.BufferGeometry>();

function build(key: Key): THREE.BufferGeometry {
  switch (key) {
    case 'platform':
      return new THREE.BoxGeometry(12.6, 0.3, 8.4);
    case 'platformEdges':
      return new THREE.EdgesGeometry(geo('platform'));
    case 'namePlane':
      return new THREE.PlaneGeometry(9, 2);
    case 'pedestal':
      return new THREE.CylinderGeometry(0.62, 0.62, 0.05, 32);
    case 'waitRing':
      return new THREE.RingGeometry(0.55, 0.64, 48);
    case 'fileCube':
      return new THREE.BoxGeometry(0.5, 0.5, 0.5);
    case 'pad':
      return new THREE.BoxGeometry(1.4, 0.08, 0.9);
    case 'crewArcBg':
      return new THREE.RingGeometry(1.22, 1.3, 64);
    case 'crewWait':
      return new THREE.RingGeometry(1.36, 1.44, 48);
    case 'crewSel':
      return new THREE.RingGeometry(1.5, 1.55, 64);
    case 'webCore':
      return new THREE.SphereGeometry(WEB_R * 0.99, 48, 32);
    case 'webRim':
      return new THREE.SphereGeometry(WEB_R * 1.06, 48, 32);
    case 'webSat':
      return new THREE.OctahedronGeometry(0.11);
    case 'webPing':
      return new THREE.RingGeometry(0.05, 0.1, 24);
  }
}

/** Web küresinin yarıçapı ve iki eğik yörüngesi (uydular bunlarda döner; halkalar çizilmez). */
export const WEB_R = 1.75;
export const WEB_ORBITS = [
  { r: WEB_R + 0.7, tilt: [1.15, 0, 0.35] as const },
  { r: WEB_R + 1.15, tilt: [1.75, 0.4, -0.5] as const },
] as const;

/**
 * Parametreli paylaşılan geometri (ör. robot parçaları renk başına, web noktaları kaliteye göre). Aynı anahtar
 * hep aynı geometriyi verir; sahne kapanırken `disposeShared` bırakır.
 */
export function geoKeyed(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = cache.get(key);
  if (!g) {
    g = make();
    g.userData['shared'] = true;
    cache.set(key, g);
  }
  return g;
}

/** Paylaşılan geometri. Düğümler bunu dispose etmez (`userData.shared`). */
export function geo(key: Key): THREE.BufferGeometry {
  let g = cache.get(key);
  if (!g) {
    g = build(key);
    g.userData['shared'] = true;
    cache.set(key, g);
  }
  return g;
}

let glow: THREE.Texture | null = null;

/** 64×64 radyal gradyan; tüm glow sprite'ları aynı texture'ı kullanır. */
export function glowTexture(createCanvas: (w: number, h: number) => HTMLCanvasElement): THREE.Texture {
  if (glow) return glow;
  const c = createCanvas(64, 64);
  const g = c.getContext('2d');
  if (g) {
    const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    r.addColorStop(0, 'rgba(255,255,255,1)');
    r.addColorStop(0.25, 'rgba(255,255,255,.55)');
    r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r;
    g.fillRect(0, 0, 64, 64);
  }
  glow = new THREE.CanvasTexture(c);
  glow.userData['shared'] = true;
  return glow;
}

/** Paylaşılan malzeme ve texture'ların sahibi olan modüller (robots.ts) temizliklerini buraya kaydeder. */
const sharedDisposers = new Set<() => void>();
/** Parçaları tek geometride birleştirir; ara geometriler hemen bırakılır. */
export function merged(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  // mergeGeometries aynı öznitelik kümesini ister: index'li/index'siz karışımı olmasın.
  const norm = parts.map((g) => (g.index ? g.toNonIndexed() : g));
  const out = mergeGeometries(norm, false);
  for (const g of new Set([...parts, ...norm])) g.dispose();
  if (!out) throw new Error('geometri birleştirilemedi');
  return out;
}

export function onDisposeShared(fn: () => void): void {
  sharedDisposers.add(fn);
}

/** Paylaşılan malzeme: disposeTree bırakmaz (`userData.shared`). */
export function markShared<T extends THREE.Material | THREE.Texture>(x: T): T {
  x.userData['shared'] = true;
  return x;
}

/** Sahne tamamen kapanırken (MapScene.dispose) paylaşılan kaynakları bırakır. */
export function disposeShared(): void {
  for (const g of cache.values()) g.dispose();
  cache.clear();
  glow?.dispose();
  glow = null;
  for (const fn of sharedDisposers) fn();
}

/**
 * Sahipsiz geometri sayısı (05/02 sızıntı ölçüsü): GPU'da yüklü olup ne sahnedeki bir nesneye ne de paylaşılan
 * önbelleğe ait olanlar. Kaldırılıp dispose edilmeyen nesne bu sayıyı kalıcı olarak artırır. Sahneye yeni eklenip
 * henüz çizilmemiş geometri yüklü sayılmadığından değer 0'ın altına düşmez.
 */
export function orphanGeometries(root: THREE.Object3D, allocated: number): number {
  const known = new Set<number>();
  for (const g of cache.values()) known.add(g.id);
  root.traverse((o) => {
    const g = (o as THREE.Object3D & { geometry?: THREE.BufferGeometry }).geometry;
    if (g) known.add(g.id);
  });
  return Math.max(0, allocated - known.size);
}

/** Testler için: önbellekteki geometri sayısı. */
export function sharedCount(): number {
  return cache.size;
}

function disposeMaterial(m: THREE.Material): void {
  if (m.userData['shared']) return; // robot gövdeleri gibi paylaşılan malzemeler (markShared)
  for (const v of Object.values(m)) {
    if (v instanceof THREE.Texture && !v.userData['shared']) v.dispose();
  }
  m.dispose();
}

/**
 * Sahneden kalkan her nesnenin tek dispose yolu (05/02): malzemeler ve paylaşılmayan geometri/texture'lar.
 * Paylaşılanlar (`userData.shared`: geo() önbelleği, glow texture) ve three'nin bütün sprite'lar için ortak
 * tuttuğu sprite geometrisi bırakılmaz. CSS2D etiketleri three'nin `removed` olayıyla DOM'dan kalkar; burada
 * ayrıca parent'tan çıkarılır.
 */
export function disposeTree(root: THREE.Object3D): void {
  // CSS2DObject yalnızca kendisi parent'tan çıkarılınca DOM öğesini kaldırır; alt ağaçtakileri tek tek çıkar.
  const labels: THREE.Object3D[] = [];
  root.traverse((o) => {
    if ((o as THREE.Object3D & { isCSS2DObject?: boolean }).isCSS2DObject) labels.push(o);
  });
  for (const l of labels) l.removeFromParent();
  root.traverse((o) => {
    const anyO = o as THREE.Object3D & {
      geometry?: THREE.BufferGeometry;
      material?: THREE.Material | THREE.Material[];
    };
    if (anyO.geometry && !anyO.geometry.userData['shared'] && !(o as THREE.Sprite).isSprite) anyO.geometry.dispose();
    const mat = anyO.material;
    if (Array.isArray(mat)) mat.forEach(disposeMaterial);
    else if (mat) disposeMaterial(mat);
  });
  root.removeFromParent();
}

export function glowSprite(tex: THREE.Texture, color: THREE.ColorRepresentation, size: number): THREE.Sprite {
  const s = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: tex,
      color,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    }),
  );
  s.scale.setScalar(size);
  return s;
}
