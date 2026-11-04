#!/usr/bin/env node
// @ts-check
// Menü çubuğu ikonları (06/01): SVG → resources/tray/tray{Idle,Busy,Waiting}Template.png (+@2x).
//   npm run icon:tray            ikonları üret
//   npm run icon:tray -- --preview <dosya.png>   açık/koyu menü çubuğu üstünde büyütülmüş önizleme
// macOS template image: yalnızca siyah + alfa; sistem menü çubuğunun temasına göre boyar. Renk taşıyamadığı için
// durum şekille anlatılır — uygulama ikonundaki "platform üstünde anten" motifi:
//   boşta     : içi boş anten başı
//   çalışıyor : dolu anten başı
//   bekliyor  : dolu baş + iki yanında yayın dalgaları ("seni çağırıyor")
// Rasterleştirme Playwright Chromium ile (make-icon.mjs ile aynı yol). Üretilen PNG'ler repoya girer;
// electron-builder bunları extraResources ile Resources/tray altına koyar.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'resources/tray');
const args = process.argv.slice(2);
const previewAt = args.includes('--preview') ? args[args.indexOf('--preview') + 1] : undefined;

/** Menü çubuğu ikonu 18 pt (macOS önerisi 16–18 pt yükseklik). */
const PT = 18;

const platform = `<path d="M2.6 13.4 9 10.4l6.4 3L9 16.4Z" fill="none" stroke="#000" stroke-width="1.3" stroke-linejoin="round"/>`;
const mast = `<path d="M9 13V7.2" stroke="#000" stroke-width="1.5" stroke-linecap="round"/>`;
const headHollow = `<circle cx="9" cy="4.6" r="2.25" fill="none" stroke="#000" stroke-width="1.4"/>`;
const headFull = `<circle cx="9" cy="4.6" r="2.6" fill="#000"/>`;
const waves =
  `<path d="M5.1 2.2a4.6 4.6 0 0 0 0 4.8" fill="none" stroke="#000" stroke-width="1.35" stroke-linecap="round"/>` +
  `<path d="M12.9 2.2a4.6 4.6 0 0 1 0 4.8" fill="none" stroke="#000" stroke-width="1.35" stroke-linecap="round"/>`;

/** @type {Record<'Idle'|'Busy'|'Waiting', string>} */
export const TRAY_SVGS = {
  Idle: platform + mast + headHollow,
  Busy: platform + mast + headFull,
  Waiting: platform + mast + headFull + waves,
};

const svg = (/** @type {string} */ body, /** @type {number} */ px) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${PT} ${PT}">${body}</svg>`;

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    return createRequire(import.meta.url)('playwright');
  }
}

async function main() {
  const pw = await loadPlaywright();
  const browser = await pw.chromium.launch();
  try {
    fs.mkdirSync(outDir, { recursive: true });
    for (const [name, body] of Object.entries(TRAY_SVGS)) {
      for (const scale of [1, 2]) {
        const px = PT * scale;
        const page = await browser.newPage({ viewport: { width: px, height: px }, deviceScaleFactor: 1 });
        await page.setContent(
          `<!doctype html><html><body style="margin:0;background:transparent">${svg(body, px)}</body></html>`,
        );
        const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: px, height: px } });
        await page.close();
        const file = path.join(outDir, `tray${name}Template${scale === 2 ? '@2x' : ''}.png`);
        fs.writeFileSync(file, png);
        console.log(`  ✓ ${path.relative(root, file)} (${px}×${px})`);
      }
    }
    if (previewAt) await preview(browser, previewAt);
  } finally {
    await browser.close();
  }
}

/** Açık ve koyu menü çubuğu zemininde, 6× büyütülmüş + gerçek boyutta önizleme (gerçek PNG'lerden). */
async function preview(/** @type {any} */ browser, /** @type {string} */ file) {
  const b64 = (/** @type {string} */ n) =>
    fs.readFileSync(path.join(outDir, `tray${n}Template@2x.png`)).toString('base64');
  const names = /** @type {const} */ (['Idle', 'Busy', 'Waiting']);
  const labels = { Idle: 'boşta', Busy: 'çalışıyor', Waiting: 'bekliyor  2' };
  const cell = (/** @type {'Idle'|'Busy'|'Waiting'} */ n, /** @type {boolean} */ dark) => `
    <div class="cell">
      <img class="big" style="${dark ? 'filter:invert(1)' : ''}" src="data:image/png;base64,${b64(n)}">
      <div class="bar ${dark ? 'dark' : 'light'}"><img class="real" style="${dark ? 'filter:invert(1)' : ''}" src="data:image/png;base64,${b64(n)}"><span>${n === 'Waiting' ? '2' : ''}</span></div>
      <div class="lbl">${labels[n]}</div>
    </div>`;
  const html = `<!doctype html><html><head><style>
    body{margin:0;font:13px -apple-system,system-ui,sans-serif}
    .row{display:flex;gap:28px;padding:22px 28px}
    .row.light{background:#ececec;color:#222}.row.dark{background:#1e1e1e;color:#ddd}
    .cell{display:flex;flex-direction:column;align-items:center;gap:10px}
    .big{width:108px;height:108px;image-rendering:pixelated}
    .bar{height:24px;padding:0 10px;display:flex;align-items:center;gap:3px;border-radius:5px;font-weight:600}
    .bar.light{background:#f6f6f6;color:#000}.bar.dark{background:#2b2b2b;color:#fff}
    .real{width:18px;height:18px}
  </style></head><body>
    <div class="row light">${names.map((n) => cell(n, false)).join('')}</div>
    <div class="row dark">${names.map((n) => cell(n, true)).join('')}</div>
  </body></html>`;
  const page = await browser.newPage({ viewport: { width: 520, height: 420 }, deviceScaleFactor: 2 });
  await page.setContent(html);
  const h = await page.evaluate('document.body.scrollHeight');
  await page.screenshot({ path: file, clip: { x: 0, y: 0, width: 520, height: h } });
  await page.close();
  console.log(`  ✓ önizleme: ${file}`);
}

await main();
