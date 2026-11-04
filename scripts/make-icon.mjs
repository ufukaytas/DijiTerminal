#!/usr/bin/env node
// @ts-check
// Uygulama ikonu (05/03): build/icon.svg → build/icon.png (1024) + build/icon.icns.
//   npm run icon
// SVG, Playwright Chromium ile rasterleştirilir (projede bağımlılık değil; yoksa `npx playwright` ile ya da
// elle 1024 px PNG verip `--png <dosya>` kullanın). ICNS bu script içinde yazılır (PNG gömülü ikon tipleri,
// macOS 10.7+); macOS'ta `iconutil` varsa onunla da üretilebilir: `--iconutil`.
// Üretilen dosyalar repoya girer; paketleme (electron-builder) yalnızca build/icon.icns'i okur.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIcns, ICNS_TYPES } from './lib/icns.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (/** @type {string} */ f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const svgPath = path.join(root, 'build/icon.svg');
const pngPath = path.join(root, 'build/icon.png');
const icnsPath = path.join(root, 'build/icon.icns');
const SIZES = [...new Set(ICNS_TYPES.map((t) => t.size))].sort((a, b) => a - b);

/** SVG → { boyut: PNG buffer } (Playwright). @returns {Promise<Map<number, Buffer>>} */
async function rasterize() {
  /** @type {any} */
  let pw;
  try {
    pw = await import('playwright');
  } catch {
    // Global kurulum (ör. CI imajı): ESM import NODE_PATH'e bakmaz, require bakar.
    try {
      pw = createRequire(import.meta.url)('playwright');
    } catch {
      pw = null;
    }
  }
  if (!pw) {
    throw new Error(
      "Playwright bulunamadı. `npx -y playwright@1 install chromium` sonrası yeniden deneyin ya da 1024 px PNG'yi `--png <dosya>` ile verin.",
    );
  }
  const svg = fs.readFileSync(svgPath, 'utf8');
  const browser = await pw.chromium.launch();
  try {
    /** @type {Map<number, Buffer>} */
    const out = new Map();
    for (const size of SIZES) {
      const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
      const html = `<!doctype html><html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg style="display:block;width:${size}px;height:${size}px" `)}</body></html>`;
      await page.setContent(html);
      out.set(size, await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }));
      await page.close();
    }
    return out;
  } finally {
    await browser.close();
  }
}

/** Tek bir 1024 px PNG'den diğer boyutlar (macOS `sips`). @param {string} file */
function fromPng(file) {
  /** @type {Map<number, Buffer>} */
  const out = new Map();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diji-icon-'));
  try {
    for (const size of SIZES) {
      const f = path.join(tmp, `${size}.png`);
      if (size === 1024) fs.copyFileSync(file, f);
      else execFileSync('sips', ['-z', String(size), String(size), file, '--out', f], { stdio: 'ignore' });
      out.set(size, fs.readFileSync(f));
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return out;
}

/** macOS iconutil ile (isteğe bağlı). @param {Map<number, Buffer>} pngs */
function withIconutil(pngs) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diji-iconset-'));
  const set = path.join(tmp, 'icon.iconset');
  fs.mkdirSync(set);
  for (const base of [16, 32, 128, 256, 512]) {
    fs.writeFileSync(path.join(set, `icon_${base}x${base}.png`), /** @type {Buffer} */ (pngs.get(base)));
    fs.writeFileSync(path.join(set, `icon_${base}x${base}@2x.png`), /** @type {Buffer} */ (pngs.get(base * 2)));
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', icnsPath]);
  fs.rmSync(tmp, { recursive: true, force: true });
}

const pngArg = opt('--png');
const pngs = pngArg ? fromPng(path.resolve(pngArg)) : await rasterize();
fs.writeFileSync(pngPath, /** @type {Buffer} */ (pngs.get(1024)));
if (args.includes('--iconutil')) withIconutil(pngs);
else fs.writeFileSync(icnsPath, buildIcns(pngs));
console.log(
  `✓ ${path.relative(root, pngPath)} (1024 px), ${path.relative(root, icnsPath)} (${(fs.statSync(icnsPath).size / 1024).toFixed(0)} KB, ${SIZES.join('/')} px)`,
);
