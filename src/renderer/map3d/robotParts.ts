// Chibi robotun parçaları (03/08): büyük yuvarlatılmış kask kafa, koyu yüz ekranı, iri gözler, iki anten,
// kulak diskleri, küçük gövde, yay boncuklu kollar, kısa bacaklar. Ölçüler prototipin `BOT` tablosundan.
//
// Çizim çağrısı bütçesi: birlikte hareket eden (aynı gruba bağlı) parçalar malzeme türüne göre tek geometride
// birleşir. Beyaz kabuk ve aksan rengi aynı "boya" malzemesini köşe rengiyle paylaşır; bu yüzden boya
// geometrileri aksan rengi başına bir kez kurulur (`geoKeyed`). Çelik ve pirinç de köşe rengiyle tek "metal"
// geometride. Robot başına: yakında 18, uzakta 11 çizim çağrısı.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { geoKeyed, merged } from './geometries';

/** Kafa grubunun gövde yerelindeki yüksekliği. */
export const HEAD_CY = 0.99;
export const SHELL_WHITE = '#EEF1F5';
const STEEL = '#AAB2C0';
const BRASS = '#C9A46A';

type Part = THREE.BufferGeometry;
const tmpC = new THREE.Color();

/** Parçayı konum/dönüşle yerleştirir ve tek renkle boyar (köşe rengi, doğrusal renk uzayında). */
function place(
  g: Part,
  color: string,
  [x, y, z]: readonly [number, number, number],
  [rx, ry, rz]: readonly [number, number, number] = [0, 0, 0],
  scale?: readonly [number, number, number],
): Part {
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(...(scale ?? [1, 1, 1])),
  );
  const out = (g.index ? g.toNonIndexed() : g).applyMatrix4(m);
  if (out !== g) g.dispose();
  tmpC.set(color);
  const n = out.getAttribute('position').count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) c.set([tmpC.r, tmpC.g, tmpC.b], i * 3);
  out.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return out;
}

const rb = (w: number, h: number, d: number, seg: number, r: number) => new RoundedBoxGeometry(w, h, d, seg, r);
const H = HEAD_CY;

/** Gövde + kafa boyası: gövde, kafa (beyaz); göğüs paneli, yüz çerçevesi, kafa şeridi, kulak kapakları (aksan). */
export function bodyPaint(accent: string, lead: boolean): Part {
  return geoKeyed(`botBodyPaint:${accent}:${lead ? 1 : 0}`, () =>
    merged([
      place(rb(0.44, 0.34, 0.3, 4, 0.09), SHELL_WHITE, [0, 0.52, 0]),
      place(rb(0.8, 0.58, 0.62, 5, 0.2), SHELL_WHITE, [0, H, 0]),
      place(rb(0.22, 0.15, 0.03, 3, 0.03), accent, [0, 0.54, 0.15]),
      place(rb(0.64, 0.44, 0.04, 4, 0.13), accent, [0, H, 0.29]),
      place(rb(0.22, 0.05, 0.34, 2, 0.02), accent, [0, H + 0.28, 0]),
      ...[-1, 1].map((sd) =>
        place(new THREE.CylinderGeometry(0.075, 0.075, 0.03, 20), accent, [sd * 0.455, H, 0], [0, 0, Math.PI / 2]),
      ),
      // Lider: anten topları da aksan renginde (alt ajanda pirinç, metal geometride).
      ...(lead
        ? [-1, 1].map((sd) => place(new THREE.SphereGeometry(0.036, 12, 10), accent, [sd * 0.235, H + 0.47, -0.04]))
        : []),
    ]),
  );
}

/** Gövde metali: boyun, kulak diskleri, anten çubukları; alt ajanda pirinç anten topları. */
export function bodyMetal(lead: boolean): Part {
  return geoKeyed(`botBodyMetal:${lead ? 1 : 0}`, () =>
    merged([
      place(new THREE.CylinderGeometry(0.07, 0.085, 0.07, 14), STEEL, [0, 0.72, 0]),
      ...[-1, 1].flatMap((sd) => [
        place(new THREE.CylinderGeometry(0.12, 0.12, 0.08, 24), STEEL, [sd * 0.41, H, 0], [0, 0, Math.PI / 2]),
        place(
          new THREE.CylinderGeometry(0.011, 0.011, 0.22, 6),
          STEEL,
          [sd * 0.2, H + 0.36, -0.04],
          [0, 0, -sd * 0.32],
        ),
        ...(lead ? [] : [place(new THREE.SphereGeometry(0.036, 12, 10), BRASS, [sd * 0.235, H + 0.47, -0.04])]),
      ]),
    ]),
  );
}

/** Koyu cam: yüz ekranı ve göğüsteki sönük ışık. */
export function bodyGlass(): Part {
  return geoKeyed('botGlass', () =>
    merged([
      place(rb(0.58, 0.39, 0.05, 4, 0.11), '#FFFFFF', [0, H, 0.305]),
      place(new THREE.CylinderGeometry(0.032, 0.032, 0.02, 16), '#FFFFFF', [-0.055, 0.555, 0.168], [Math.PI / 2, 0, 0]),
    ]),
  );
}

/** Göğüsteki durum ışığı (kendi malzemesi: durum rengi). Mesh konumu (0.055, 0.555, 0.168). */
export function chestLight(): Part {
  return geoKeyed('botChest', () => new THREE.CylinderGeometry(0.032, 0.032, 0.02, 16).rotateX(Math.PI / 2));
}

/** İki göz, yüz ekranında yassı (z × .45). Mesh merkezi göz hizasında; göz kapağı = mesh.scale.y. */
export function eyes(): Part {
  return geoKeyed('botEyes', () =>
    merged(
      [-0.13, 0.13].map((x) =>
        place(new THREE.SphereGeometry(0.078, 20, 14), '#FFFFFF', [x, 0, 0], [0, 0, 0], [1, 1, 0.45]),
      ),
    ),
  );
}

/** Gözlerdeki parlama noktaları (gözlerin çocuğu; göz kapağıyla birlikte ezilir). */
export function shines(): Part {
  return geoKeyed('botShines', () =>
    merged(
      [-0.13, 0.13].map((x) =>
        place(new THREE.SphereGeometry(0.022, 8, 6), '#FFFFFF', [x + 0.03, 0.035, 0.0315], [0, 0, 0], [1, 1, 0.45]),
      ),
    ),
  );
}

export type MouthKind = 'smile' | 'oh' | 'flat';
/** Ağız şekilleri (mesh konumu (0, -0.085…-0.09, 0.335) kafa yerelinde). */
export function mouth(kind: MouthKind): Part {
  return geoKeyed(`botMouth:${kind}`, () => {
    if (kind === 'smile') return new THREE.TorusGeometry(0.055, 0.013, 6, 16, Math.PI).rotateZ(Math.PI);
    if (kind === 'oh') return new THREE.TorusGeometry(0.03, 0.012, 6, 16);
    return new THREE.BoxGeometry(0.09, 0.016, 0.01);
  });
}

/** Kol boyası (omuz pivotu yerelinde): aksan önkol, beyaz el ve başparmak. `sd`: -1 sol, 1 sağ. */
export function armPaint(accent: string, sd: -1 | 1): Part {
  return geoKeyed(`botArmPaint:${accent}:${sd}`, () => {
    const hand: [number, number, number] = [sd * 0.025, -0.36, 0.01];
    // Başparmak elin yerelinde (−sd·.045, .03, .035): el dönmediği için konumu toplamak yeter.
    return merged([
      place(new THREE.CylinderGeometry(0.06, 0.05, 0.15, 14), accent, [sd * 0.025, -0.25, 0]),
      place(new THREE.SphereGeometry(0.062, 14, 10), SHELL_WHITE, hand),
      place(
        new THREE.CapsuleGeometry(0.018, 0.05, 4, 8),
        SHELL_WHITE,
        [hand[0] - sd * 0.045, hand[1] + 0.03, hand[2] + 0.035],
        [0.4, 0, sd * 0.6],
      ),
    ]);
  });
}

/** Kol yayı: omuzdan sarkan üç çelik boncuk. */
export function armSprings(sd: -1 | 1): Part {
  return geoKeyed(`botArmSprings:${sd}`, () =>
    merged(
      [0, 1, 2].map((i) => place(new THREE.SphereGeometry(0.036, 10, 8), STEEL, [sd * 0.02, -0.03 - i * 0.055, 0])),
    ),
  );
}

/** Bacak boyası (kalça yerelinde): beyaz incik ve bot, aksan diz diski ve taban. */
export function legPaint(accent: string): Part {
  return geoKeyed(`botLegPaint:${accent}`, () =>
    merged([
      place(new THREE.CylinderGeometry(0.055, 0.06, 0.14, 12), SHELL_WHITE, [0, -0.12, 0]),
      place(new THREE.CylinderGeometry(0.068, 0.068, 0.03, 18), accent, [0, -0.1, 0.055], [Math.PI / 2, 0, 0]),
      place(rb(0.17, 0.1, 0.23, 3, 0.04), SHELL_WHITE, [0, -0.245, 0.025]),
      place(rb(0.175, 0.03, 0.24, 2, 0.012), accent, [0, -0.3, 0.025]),
    ]),
  );
}

/** Kalça yayı: tek çelik boncuk. */
export function legSpring(): Part {
  return geoKeyed('botLegSpring', () => place(new THREE.SphereGeometry(0.036, 10, 8), STEEL, [0, -0.01, 0]));
}

export function botPad(): Part {
  return geoKeyed('botPad', () => new THREE.BoxGeometry(1, 0.05, 1));
}

/** Görünmez tıklama kutusu (gövde + kafa). Mesh y .72. */
export function botHit(): Part {
  return geoKeyed('botHit', () => new THREE.BoxGeometry(0.85, 1.45, 0.75));
}
