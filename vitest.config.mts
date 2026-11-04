import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Motor ve ortak kod node ortamında, renderer jsdom'da test edilir.
// Faz 1 hook testleri (tests/hooks) shell + node:test ile ayrı çalışır: npm run test:hooks
const version = (JSON.parse(readFileSync(resolve(import.meta.dirname, 'package.json'), 'utf8')) as { version: string }).version;

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'src/shared'),
      '@main': resolve(import.meta.dirname, 'src/main'),
      '@renderer': resolve(import.meta.dirname, 'src/renderer'),
    },
  },
  test: {
    include: ['tests/{main,shared,engine,renderer,scripts}/**/*.test.{ts,tsx}'],
    environment: 'node',
    environmentMatchGlobs: [['tests/renderer/**', 'jsdom']],
    testTimeout: 15_000,
  },
});
