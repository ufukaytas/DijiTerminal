#!/usr/bin/env node
// @ts-check
// Gerçek Claude Code verisinin YALNIZCA şema özetini yazar (05/01) — değerler asla yazdırılmaz.
//   node scripts/inspect-format.mjs [--dir ~/.claude] [--days 1] [--json]
// Çıktı: registry anahtar adları/tipleri, bugünkü transcript kayıtlarında type/subtype sayıları,
// kayıt tipi başına anahtarlar, content blok tipleri, toolUseResult anahtar kümeleri, subagent meta anahtarları.
// Yalnızca enum benzeri birkaç alanın değeri sayılır (type, subtype, stop_reason, status, kind, entrypoint, agentType).
// Toplama mantığı: scripts/lib/schema-summary.mjs (09/01 compat-snapshot ile ortak).

import os from 'node:os';
import path from 'node:path';
import { summarize } from './lib/schema-summary.mjs';

const args = process.argv.slice(2);
const opt = (/** @type {string} */ f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const dir = path.resolve((opt('--dir') ?? path.join(os.homedir(), '.claude')).replace(/^~(?=\/|$)/, os.homedir()));
const days = Number(opt('--days') ?? 1);
const asJson = args.includes('--json');

const report = summarize({ dir, days });

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  /** @param {string} title @param {Record<string, unknown>} o */
  const sec = (title, o) => {
    console.log(`\n## ${title}`);
    for (const [k, v] of Object.entries(o)) console.log(`  ${k}: ${v}`);
  };
  const t = report.transcripts;
  console.log(`Kaynak: ${report.dir} — registry ${report.registry.files} dosya; transcript ${t.filesModifiedWithinDays} dosya / ${t.lines} satır (son ${days} gün, ${t.unparsable} bozuk)`);
  sec('registry anahtarları', report.registry.keys);
  sec('registry değer sayıları', report.registry.values);
  sec('kayıt tipleri', t.recordTypes);
  for (const [k, ks] of Object.entries(t.keysByType)) sec(`anahtarlar: ${k}`, ks);
  sec('content blokları', t.contentBlocks);
  sec('toolUseResult anahtar kümeleri', t.toolUseResultKeySets);
  sec('enum değerleri', t.enumValues);
  sec('subagent meta anahtarları', report.subagentMeta);
}
