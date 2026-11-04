// node-pty 1.1.0 paketinde prebuild `spawn-helper` dosyaları çalıştırma izni olmadan geliyor (tar modu 644).
// İzin yoksa macOS'te pty açılırken "posix_spawnp failed" hatası alınır (07/01). npm install sonrası düzeltir;
// electron-builder dosya modunu node_modules'tan kopyaladığı için paketli uygulama da düzelir.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let root;
try {
  root = path.dirname(require.resolve('node-pty/package.json'));
} catch {
  process.exit(0); // node-pty kurulu değil
}

const candidates = [path.join(root, 'build', 'Release', 'spawn-helper')];
const pre = path.join(root, 'prebuilds');
if (fs.existsSync(pre)) for (const d of fs.readdirSync(pre)) candidates.push(path.join(pre, d, 'spawn-helper'));

let fixed = 0;
for (const f of candidates) {
  try {
    const st = fs.statSync(f);
    if ((st.mode & 0o111) !== 0o111) {
      fs.chmodSync(f, 0o755);
      fixed++;
    }
  } catch {
    // yok
  }
}
if (fixed) console.log(`[fix-node-pty] ${fixed} spawn-helper dosyasına çalıştırma izni verildi.`);
