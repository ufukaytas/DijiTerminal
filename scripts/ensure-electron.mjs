// npm install sonrası Electron ikili dosyasını indirir.
// Electron 45'ten itibaren paket bunu kendi postinstall'ında yapmıyor; `install-electron` ayrıca çağrılmalı.
// ELECTRON_SKIP_BINARY_DOWNLOAD=1 ile atlanır (CI/konteyner: yalnızca test ve typecheck çalışır).
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) {
  console.log('[ensure-electron] ELECTRON_SKIP_BINARY_DOWNLOAD ayarlı, indirme atlandı.');
  process.exit(0);
}

const require = createRequire(import.meta.url);
let installer;
try {
  installer = require.resolve('electron/install.js');
} catch {
  console.warn('[ensure-electron] electron paketi bulunamadı, atlandı.');
  process.exit(0);
}

const r = spawnSync(process.execPath, [installer], { stdio: 'inherit' });
if (r.status !== 0) {
  console.error('[ensure-electron] Electron indirilemedi. Elle deneyin: npx install-electron');
  process.exit(r.status ?? 1);
}
