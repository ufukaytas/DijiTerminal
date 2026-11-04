import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

const alias = {
  '@shared': resolve(__dirname, 'src/shared'),
  '@main': resolve(__dirname, 'src/main'),
  '@renderer': resolve(__dirname, 'src/renderer'),
};

const version = (JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string }).version;

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias },
    plugins: [react()],
    define: { __APP_VERSION__: JSON.stringify(version) },
    build: {
      // 06/01: menü çubuğu açılır listesi ayrı giriş noktası (three.js yüklemez).
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          popover: resolve(__dirname, 'src/renderer/popover.html'),
        },
      },
    },
  },
});
