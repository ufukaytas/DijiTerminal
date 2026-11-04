#!/usr/bin/env node
// @ts-check
// Fixture sızıntı denetimi (05/01) — `npm test` öncesi (pretest) çalışır.
//   node scripts/check-fixtures.mjs [yol…] [--strict]
// Varsayılan: fixtures/ altındaki her şey. Bulgu varsa çıkış kodu 1; değerler yazdırılmaz.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirSize, scanPaths, validateScenarios } from './lib/check.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const strict = args.includes('--strict');
const targets = args.filter((a) => !a.startsWith('--'));
const fixturesDir = path.join(root, 'fixtures');
const roots = targets.length ? targets.map((t) => path.resolve(t)) : [fixturesDir];

const t0 = Date.now();
const findings = scanPaths(roots, { strictSentences: strict });
const structural = targets.length ? [] : validateScenarios(fixturesDir);
const size = targets.length ? 0 : dirSize(fixturesDir);
const LIMIT = 3 * 1024 * 1024;

for (const f of findings) console.error(`  ✗ ${path.relative(root, f.file)}${f.line ? ':' + f.line : ''}  ${f.rule}`);
for (const s of structural) console.error(`  ✗ fixtures/${s.dir}: ${s.problem}`);
if (size > LIMIT) console.warn(`  ! fixtures/ ${(size / 1048576).toFixed(2)} MB — 3 MB sınırının üstünde (büyük fixture'ları gitignore'a alın)`);

if (findings.length || structural.length) {
  console.error(`check-fixtures: ${findings.length} sızıntı bulgusu, ${structural.length} yapı hatası.`);
  process.exit(1);
}
console.log(`check-fixtures: temiz (${Date.now() - t0} ms${size ? `, ${(size / 1048576).toFixed(2)} MB` : ''}).`);
