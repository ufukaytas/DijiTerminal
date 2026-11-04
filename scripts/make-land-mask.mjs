// Web küresinin kara maskesini üretir (src/renderer/map3d/landMask.ts içindeki B64 dizgisi).
// Natural Earth 1:110m land (world-atlas, ISC; veri kamu malı) → 2° hücreler, 180×90 bit, base64.
// Bağımlılıklar projeye eklenmez; geçici bir klasörde çalıştırın:
//   npm i world-atlas topojson-client d3-geo && node make-land-mask.mjs > mask.txt
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { feature } from 'topojson-client';
import { geoContains } from 'd3-geo';

const require = createRequire(import.meta.url);
const topo = JSON.parse(fs.readFileSync(require.resolve('world-atlas/land-110m.json'), 'utf8'));
const land = feature(topo, topo.objects.land);
const W = 180;
const H = 90; // 2° hücre, eşdikdörtgen; satır 0 = 90°K
const bits = new Uint8Array(Math.ceil((W * H) / 8));
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const lon = -180 + (x + 0.5) * 2;
    const lat = 90 - (y + 0.5) * 2;
    if (geoContains(land, [lon, lat])) {
      const i = y * W + x;
      bits[i >> 3] |= 1 << (i & 7);
    }
  }
}
process.stdout.write(Buffer.from(bits).toString('base64'));
