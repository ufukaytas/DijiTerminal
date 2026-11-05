#!/usr/bin/env node
// @ts-check
// Claude Code şema golden'ı (09/01): gerçek ~/.claude verisinin YALNIZCA şema özetini
// fixtures/compat/schema-<claudeSürümü>.json olarak yazar. Değer, yol, prompt ya da kimlik yazılmaz.
//   npm run compat:snapshot [-- --dir ~/.claude] [--days 30] [--version 2.1.318]
// COMPAT.testedMax (src/shared/compat.ts) ile farkı ve önceki golden'a göre yeni kayıt tiplerini yazdırır;
// kaynak dosyaları düzenlemez. Ardından `npx vitest run tests/engine/compat-coverage.test.ts`.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize } from './lib/schema-summary.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (/** @type {string} */ f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const dir = path.resolve((opt('--dir') ?? process.env['CLAUDE_CONFIG_DIR'] ?? path.join(os.homedir(), '.claude')).replace(/^~(?=\/|$)/, os.homedir()));
const days = Number(opt('--days') ?? 30);
const outDir = path.join(root, 'fixtures', 'compat');

/** @returns {string | null} */
function claudeVersion() {
  const given = opt('--version');
  if (given) return given;
  try {
    const out = execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 8000 });
    return /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** @param {string} a @param {string} b */
function cmp(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** @returns {{ file: string, version: string } | null} */
function latestGolden(d = outDir) {
  if (!fs.existsSync(d)) return null;
  const all = fs
    .readdirSync(d)
    .map((f) => /^schema-(\d+\.\d+\.\d+)\.json$/.exec(f))
    .filter((m) => m !== null)
    .map((m) => ({ file: path.join(d, /** @type {RegExpExecArray} */ (m)[0]), version: /** @type {string} */ (/** @type {RegExpExecArray} */ (m)[1]) }));
  all.sort((a, b) => cmp(a.version, b.version));
  return all.at(-1) ?? null;
}

const version = claudeVersion();
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('compat-snapshot: Claude Code sürümü okunamadı (`claude --version`). --version ile verin.');
  process.exit(1);
}

const prev = latestGolden();
const summary = summarize({ dir, days });
const { dir: _omit, ...schema } = summary;
const out = { claudeVersion: version, days, ...schema };
// Satır/dosya sayıları makineye özgü ve her çalıştırmada değişir: golden'da tutulmaz.
out.registry = { ...out.registry, files: 0 };
out.transcripts = { ...out.transcripts, filesModifiedWithinDays: 0, lines: 0, unparsable: 0 };

fs.mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `schema-${version}.json`);
fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
console.log(`compat-snapshot: ${path.relative(root, file)} yazıldı (son ${days} gün, ${Object.keys(out.transcripts.recordTypes).length} kayıt tipi).`);

if (prev && prev.version !== version) {
  const old = JSON.parse(fs.readFileSync(prev.file, 'utf8'));
  const added = Object.keys(out.transcripts.recordTypes).filter((t) => !(t in old.transcripts.recordTypes));
  const regAdded = Object.keys(out.registry.keys).filter((k) => !(k in old.registry.keys));
  if (added.length) console.log(`  yeni kayıt tipleri (${prev.version} → ${version}): ${added.join(', ')}`);
  if (regAdded.length) console.log(`  yeni registry anahtarları: ${regAdded.join(', ')}`);
}

const compatSrc = fs.readFileSync(path.join(root, 'src', 'shared', 'compat.ts'), 'utf8');
const testedMax = /testedMax:\s*'([^']+)'/.exec(compatSrc)?.[1];
if (testedMax && cmp(version, testedMax) > 0) {
  console.log(`  COMPAT.testedMax ${testedMax} → ${version} olarak güncellenebilir (src/shared/compat.ts, README).`);
  console.log('  Önce: npx vitest run tests/engine/compat-coverage.test.ts');
} else if (testedMax) {
  console.log(`  COMPAT.testedMax (${testedMax}) güncel.`);
}
