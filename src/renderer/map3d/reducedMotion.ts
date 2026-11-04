// Hareketi azalt tercihi (03/05, 03/06). Karar sırası:
//   1. `<html data-motion>` — ayarlar (00/04) yazar: 'reduce' → azalt, 'full' → azaltma
//   2. yoksa sistemin `prefers-reduced-motion` tercihi
// MapScene kurulurken bir kez okunur; değişince MapView sahneyi yeniden kurar (havuzlar temizlenir).
import type { AppSettings } from '@shared/types';

const QUERY = '(prefers-reduced-motion: reduce)';
export const MOTION_ATTR = 'data-motion';

function systemPrefers(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(QUERY).matches;
}

/** `<html data-motion>` değeri: true/false kesin karar, null → sisteme bak. */
export function documentMotion(): boolean | null {
  if (typeof document === 'undefined') return null;
  const v = document.documentElement.getAttribute(MOTION_ATTR);
  if (v === 'reduce') return true;
  if (v === 'full') return false;
  return null;
}

/** Uygulamanın o anki kararı (ayar → sistem). */
export function currentReducedMotion(): boolean {
  return documentMotion() ?? systemPrefers();
}

/** Açık ayar ('on'/'off') her şeyi ezer; 'system' → `<html data-motion>` → media query. */
export function resolveReducedMotion(setting: AppSettings['reducedMotion'] = 'system'): boolean {
  if (setting === 'on') return true;
  if (setting === 'off') return false;
  return currentReducedMotion();
}

/** Sistem tercihi ya da `<html data-motion>` değişince çağrılır. Dönen fonksiyon dinleyicileri kaldırır. */
export function onReducedMotionChange(cb: (reduced: boolean) => void): () => void {
  const offs: (() => void)[] = [];
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    const mq = window.matchMedia(QUERY);
    const h = () => cb(currentReducedMotion());
    mq.addEventListener('change', h);
    offs.push(() => mq.removeEventListener('change', h));
  }
  if (typeof document !== 'undefined' && typeof MutationObserver !== 'undefined') {
    const mo = new MutationObserver(() => cb(currentReducedMotion()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: [MOTION_ATTR] });
    offs.push(() => mo.disconnect());
  }
  return () => {
    for (const off of offs) off();
  };
}
