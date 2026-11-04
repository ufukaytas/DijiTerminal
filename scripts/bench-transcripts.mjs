#!/usr/bin/env node
// @ts-check
// TranscriptPool boot ölçümü (02/02).
//   node scripts/bench-transcripts.mjs --synthetic <MB>    geçici klasörde sentetik veri üretir (varsayılan 300)
//   node scripts/bench-transcripts.mjs --dir <claude-kökü>  var olan bir ~/.claude kopyasını okur (salt okunur)
// Sentetik veri: birkaç büyük dosya (çoğu dün, sonu bugün) + çok sayıda küçük bugünkü dosya,
// progress kayıtları ve base64 görsel satırları içerir. Gerçek veri kullanılmaz; iş bitince silinir.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { generate, startOfToday } from './lib/synthetic-transcripts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (/** @type {string} */ f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const MB = 1024 * 1024;

/** Havuzu tek dosyaya paketler (TypeScript → ESM), chokidar dışarıda kalır. */
async function loadPool(tmp) {
  const out = path.join(tmp, 'pool.bundle.mjs');
  await build({
    entryPoints: [path.join(root, 'src/main/engine/transcript/pool.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    external: ['chokidar'],
    outfile: out,
    logLevel: 'silent',
  });
  // chokidar'ı proje node_modules'ından çözebilmesi için paketi proje içine bağla
  const link = path.join(root, 'node_modules', `.bench-pool-${process.pid}.mjs`);
  fs.copyFileSync(out, link);
  try {
    return await import(pathToFileURL(link).href);
  } finally {
    fs.rmSync(link, { force: true });
  }
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diji-bench-'));
  try {
    const { TranscriptPool } = await loadPool(tmp);
    let claudeRoot = opt('--dir');
    let dayStart = startOfToday();
    if (!claudeRoot) {
      const mb = Number(opt('--synthetic') ?? 300);
      claudeRoot = path.join(tmp, 'claude');
      const t0 = Date.now();
      const g = generate(path.join(claudeRoot, 'projects'), mb);
      dayStart = g.dayStart;
      console.log(`sentetik veri: ${g.files} dosya, ${(g.written / MB).toFixed(1)} MB, üretim ${Date.now() - t0} ms`);
    }
    const paths = {
      root: claudeRoot,
      projects: path.join(claudeRoot, 'projects'),
      sessions: path.join(claudeRoot, 'sessions'),
      settingsFile: path.join(claudeRoot, 'settings.json'),
    };
    const pool = new TranscriptPool(paths);
    let records = 0;
    let batches = 0;
    pool.on('records', (/** @type {{records: unknown[]}} */ b) => {
      batches++;
      records += b.records.length;
    });
    const rss0 = process.memoryUsage().rss;
    const t0 = performance.now();
    await pool.boot(dayStart);
    const ms = performance.now() - t0;
    const s = pool.stats();
    const rss1 = process.memoryUsage().rss;
    await pool.stop();
    console.log(
      `boot: ${ms.toFixed(0)} ms | dosya ${s.files} | okunan ${(s.bytesRead / MB).toFixed(1)} MB | kayıt ${records} (${batches} paket) | parse hatası ${s.parseErrors} | RSS +${((rss1 - rss0) / MB).toFixed(0)} MB`,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

await main();
