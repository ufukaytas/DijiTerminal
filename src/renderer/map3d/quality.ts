// Görüntü kalitesi (ayar: renderQuality) → WebGL piksel oranı. Kök elemandaki `data-quality` ile gelir.
// 'balanced': Retina'da 1.5 ile sınırlanır — GPU daha az piksel çizer (pil); plaka üzerindeki küçük yazılar biraz yumuşar.
// Not: konteynerde (SwiftShader) GPU belleği ≈90 MB düşüyordu; Mac'te (M3 Pro) GPU süreci RSS'i değişmedi (79–85 MB).

export type RenderQuality = 'high' | 'balanced';

const MAX_RATIO: Record<RenderQuality, number> = { high: 2, balanced: 1.5 };

export function pixelRatioFor(devicePixelRatio: number, quality: RenderQuality): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.min(MAX_RATIO[quality], dpr);
}

export function currentQuality(root: HTMLElement = document.documentElement): RenderQuality {
  return root.dataset['quality'] === 'balanced' ? 'balanced' : 'high';
}

/** `data-quality` değişince çağırır; dönen fonksiyon dinlemeyi bırakır. */
export function watchQuality(cb: (q: RenderQuality) => void, root: HTMLElement = document.documentElement): () => void {
  if (typeof MutationObserver === 'undefined') return () => undefined;
  let last = currentQuality(root);
  const mo = new MutationObserver(() => {
    const q = currentQuality(root);
    if (q !== last) {
      last = q;
      cb(q);
    }
  });
  mo.observe(root, { attributes: true, attributeFilter: ['data-quality'] });
  return () => mo.disconnect();
}
