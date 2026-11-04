// Platform zeminine basılı ad, yol ve canlı özet (03/05 Prompt 5). 1800×400 CanvasTexture.
// Aynı içerik bir daha çizilmez; fontlar yüklenince bir kez yeniden çizilir.
import * as THREE from 'three';
import type { SummaryPart } from './style';

export const PLATE_W = 1800;
export const PLATE_H = 400;
const NAME_MAX = 1700;
const NAME_PX = 168;
const NAME_MIN_PX = 120;

export interface PlateContent {
  name: string;
  tag: string | null;
  path: string;
  color: string;
  summary: SummaryPart[];
}

const nameFont = (px: number) => `600 ${px}px 'IBM Plex Sans', system-ui, sans-serif`;
const TAG_FONT = "600 46px 'IBM Plex Mono', ui-monospace, monospace";
const PATH_FONT = "400 50px 'IBM Plex Mono', ui-monospace, monospace";
const SUM_FONT = "500 54px 'IBM Plex Mono', ui-monospace, monospace";

/** Adı sığdır: 168px'ten 120px'e kadar küçült, yine sığmıyorsa `…` ile kes. */
export function fitName(
  measure: (text: string, px: number) => number,
  name: string,
  maxWidth: number,
): { text: string; px: number } {
  for (let px = NAME_PX; px >= NAME_MIN_PX; px -= 8) {
    if (measure(name, px) <= maxWidth) return { text: name, px };
  }
  let text = name;
  while (text.length > 1 && measure(text + '…', NAME_MIN_PX) > maxWidth) text = text.slice(0, -1);
  return { text: text + '…', px: NAME_MIN_PX };
}

export class PlatePainter {
  readonly texture: THREE.CanvasTexture;
  private readonly canvas: HTMLCanvasElement;
  private key = '';
  private content: PlateContent | null = null;
  /** Kaç kez gerçekten çizildi (test ve dev overlay için). */
  draws = 0;

  constructor(createCanvas: (w: number, h: number) => HTMLCanvasElement, anisotropy: number, fontsReady: Promise<unknown>) {
    this.canvas = createCanvas(PLATE_W, PLATE_H);
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.anisotropy = anisotropy;
    this.texture.colorSpace = THREE.SRGBColorSpace;
    void fontsReady.then(
      () => {
        if (this.content) this.draw();
      },
      () => {},
    );
  }

  /** true → yeniden çizildi. */
  paint(c: PlateContent): boolean {
    const key = JSON.stringify(c);
    if (key === this.key) return false;
    this.key = key;
    this.content = c;
    this.draw();
    return true;
  }

  private draw(): void {
    const c = this.content;
    const g = this.canvas.getContext('2d');
    if (!c || !g) return;
    this.draws++;
    g.clearRect(0, 0, PLATE_W, PLATE_H);
    g.textBaseline = 'alphabetic';

    let tagW = 0;
    if (c.tag) {
      g.font = TAG_FONT;
      tagW = g.measureText(c.tag).width + 36 + 30;
    }
    const fit = fitName(
      (t, px) => {
        g.font = nameFont(px);
        return g.measureText(t).width;
      },
      c.name,
      NAME_MAX - tagW,
    );
    g.fillStyle = c.color;
    g.font = nameFont(fit.px);
    g.fillText(fit.text, 6, 168);

    if (c.tag) {
      const x = 14 + g.measureText(fit.text).width + 30;
      g.font = TAG_FONT;
      const w = g.measureText(c.tag).width + 36;
      g.globalAlpha = 0.22;
      g.fillRect(x, 92, w, 66);
      g.globalAlpha = 1;
      g.fillText(c.tag, x + 18, 140);
    }

    g.font = PATH_FONT;
    g.fillStyle = '#808A9C';
    g.fillText(c.path, 10, 252);

    g.font = SUM_FONT;
    let x = 10;
    for (const [txt, col] of c.summary) {
      g.fillStyle = col;
      g.fillText(txt, x, 342);
      x += g.measureText(txt).width;
    }
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
  }
}
