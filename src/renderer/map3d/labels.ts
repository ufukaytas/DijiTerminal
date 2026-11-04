// CSS2D etiketleri (03/05 Prompt 10). Metin yalnızca textContent ile yazılır; innerHTML yok.
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { SessionView } from '@shared/types';
import type { SceneEnv } from './env';
import { sessionLabel } from './style';

export { CSS2DObject };

/** Etiket katmanı: kapsayıcı tıklamaları geçirir, etiketler kendi pointer-events'ini açar. */
export function createLabelRenderer(host: HTMLElement): CSS2DRenderer {
  const r = new CSS2DRenderer();
  r.domElement.className = 'map-labels';
  r.domElement.style.position = 'absolute';
  r.domElement.style.inset = '0';
  r.domElement.style.pointerEvents = 'none';
  host.appendChild(r.domElement);
  return r;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** Etiketi CSS2DObject'e sarar; `center` etiketin hangi noktasının konuma oturacağı. */
export function labelObject(node: HTMLElement, cx = 0.5, cy = 0.5): CSS2DObject {
  const o = new CSS2DObject(node);
  o.center.set(cx, cy);
  return o;
}

const setText = (e: Element, t: string) => {
  if (e.textContent !== t) e.textContent = t;
};

/** Session etiketi: `<button class="slabel">` — üst satır renkli nokta + ad, alt satır durum. */
export class SessionLabel {
  readonly object: CSS2DObject;
  readonly button: HTMLButtonElement;
  private dot: HTMLElement;
  private name: HTMLElement;
  private sub: HTMLElement;
  private tone = '';

  constructor(env: SceneEnv, sessionId: string) {
    const b = el('button', 'slabel');
    b.type = 'button';
    const top = el('b', '');
    this.dot = el('i', '');
    this.dot.setAttribute('aria-hidden', 'true');
    this.name = el('span', 'sl-name');
    top.append(this.dot, this.name);
    this.sub = el('small', '');
    b.append(top, this.sub);
    b.addEventListener('click', () => env.onSessionClick(sessionId));
    b.addEventListener('dblclick', () => env.onSessionDblClick(sessionId));
    this.button = b;
    this.object = labelObject(b, 0.5, 1);
  }

  update(s: SessionView, now: number): void {
    const t = sessionLabel(s, now);
    setText(this.name, t.name);
    setText(this.sub, t.sub);
    if (this.dot.style.background !== t.dot) this.dot.style.background = t.dot;
    if (this.tone !== t.tone) {
      this.sub.className = `tone-${t.tone}`;
      this.tone = t.tone;
    }
    if (this.button.getAttribute('aria-label') !== t.aria) this.button.setAttribute('aria-label', t.aria);
    this.button.classList.toggle('ended', s.status === 'ended');
  }

  setSelected(on: boolean): void {
    this.button.classList.toggle('sel', on);
    this.button.setAttribute('aria-pressed', String(on));
  }
}
