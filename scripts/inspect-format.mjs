#!/usr/bin/env node
// @ts-check
// Gerçek Claude Code verisinin YALNIZCA şema özetini yazar (05/01) — değerler asla yazdırılmaz.
//   node scripts/inspect-format.mjs [--dir ~/.claude] [--days 1] [--json]
// Çıktı: registry anahtar adları/tipleri, bugünkü transcript kayıtlarında type/subtype sayıları,
// kayıt tipi başına anahtarlar, content blok tipleri, toolUseResult anahtar kümeleri, subagent meta anahtarları.
// Yalnızca enum benzeri birkaç alanın değeri sayılır (type, subtype, stop_reason, status, kind, entrypoint, agentType).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (/** @type {string} */ f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const dir = path.resolve((opt('--dir') ?? path.join(os.homedir(), '.claude')).replace(/^~(?=\/|$)/, os.homedir()));
const days = Number(opt('--days') ?? 1);
const asJson = args.includes('--json');
const since = Date.now() - days * 86_400_000;
/** Değeri sayılabilecek (serbest metin olmayan) alanlar; yalnızca kısa ve kimlik benzeri olmayan değerler. */
const ENUM_KEYS = new Set(['type', 'subtype', 'stop_reason', 'status', 'kind', 'entrypoint', 'agentType', 'requestShape', 'level', 'userType']);

/** @param {unknown} v */
function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** @param {unknown} v */
function enumValue(v) {
  return typeof v === 'string' && v.length <= 40 && /^[a-z_][a-z0-9_:-]*$/i.test(v) && !/[0-9a-f]{8}/i.test(v) ? v : '‹değer›';
}

/**
 * Kimlik taşıyan anahtarları tek satıra indirir: `wireToolInputs.toolu_01…` → `wireToolInputs.‹id›`.
 * Hem çıktıyı kısaltır hem de kimlikleri raporun dışında tutar.
 * @param {string} k
 */
function keyName(k) {
  if (/^(toolu_|srvtoolu_|call_|msg_|req_)/.test(k)) return '‹id›';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(k)) return '‹id›';
  if (/^[0-9a-f]{12,}$/i.test(k) || /^\d{4,}$/.test(k)) return '‹id›';
  return k;
}

/** Değerin biçimi (rakam → 9, harf → a), uzunluk sınırlı: '347' → '999'. @param {unknown} v */
function valueShape(v) {
  const s = String(v);
  return s.length > 24 ? `‹${s.length} karakter›` : s.replace(/[0-9]/g, '9').replace(/[A-Za-z]/g, 'a');
}

/** Anahtar → tip kümesi. @param {Map<string, Set<string>>} into @param {Record<string, unknown>} o @param {string} [prefix] @param {number} [depth] */
function shape(into, o, prefix = '', depth = 0) {
  for (const [k, v] of Object.entries(o)) {
    const key = prefix + keyName(k);
    if (!into.has(key)) into.set(key, new Set());
    /** @type {Set<string>} */ (into.get(key)).add(typeOf(v));
    if (depth < 1 && v && typeof v === 'object' && !Array.isArray(v) && k !== 'input') shape(into, /** @type {Record<string, unknown>} */ (v), key + '.', depth + 1);
  }
}

/** @param {Map<string, number>} m @param {string} k */
const inc = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);

/** @param {string} d @returns {string[]} */
function walk(d) {
  /** @type {string[]} */
  const out = [];
  if (!fs.existsSync(d)) return out;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

// Registry
/** @type {Map<string, Set<string>>} */ const regKeys = new Map();
/** @type {Map<string, number>} */ const regEnums = new Map();
let regFiles = 0;
const sessDir = path.join(dir, 'sessions');
for (const f of fs.existsSync(sessDir) ? fs.readdirSync(sessDir) : []) {
  if (!f.endsWith('.json')) continue;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(sessDir, f), 'utf8'));
    regFiles++;
    shape(regKeys, j);
    for (const k of ['status', 'kind', 'entrypoint']) if (k in j) inc(regEnums, `${k}=${enumValue(j[k])}`);
    // procStart'ın platforma göre biçimi (02/01 pid reuse): yalnızca şekil, değer değil.
    if ('procStart' in j) inc(regEnums, `procStart~${valueShape(j.procStart)}`);
    if ('waitingFor' in j) inc(regEnums, `waitingFor=${j.waitingFor === null ? 'null' : enumValue(String(j.waitingFor).split(':')[0]) + ':…'}`);
  } catch { /* yarım yazılmış */ }
}

// Transcript'ler
/** @type {Map<string, number>} */ const recTypes = new Map();
/** @type {Map<string, Map<string, Set<string>>>} */ const keysByType = new Map();
/** @type {Map<string, number>} */ const blockTypes = new Map();
/** @type {Map<string, number>} */ const turKeys = new Map();
/** @type {Map<string, number>} */ const enums = new Map();
/** @type {Map<string, Set<string>>} */ const metaKeys = new Map();
let files = 0;
let lines = 0;
let bad = 0;
for (const f of walk(path.join(dir, 'projects'))) {
  const st = fs.statSync(f);
  if (st.mtimeMs < since) continue;
  if (f.endsWith('.meta.json')) {
    try { shape(metaKeys, JSON.parse(fs.readFileSync(f, 'utf8'))); } catch { /* yok say */ }
    continue;
  }
  if (!f.endsWith('.jsonl')) continue;
  files++;
  for (const ln of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!ln.trim()) continue;
    lines++;
    let r;
    try { r = JSON.parse(ln); } catch { bad++; continue; }
    if (!r || typeof r !== 'object') continue;
    const t = `${enumValue(r.type)}${r.subtype ? '/' + enumValue(r.subtype) : ''}`;
    inc(recTypes, t);
    if (!keysByType.has(t)) keysByType.set(t, new Map());
    shape(/** @type {Map<string, Set<string>>} */ (keysByType.get(t)), r);
    for (const k of ENUM_KEYS) if (k !== 'type' && k !== 'subtype' && typeof r[k] === 'string') inc(enums, `${k}=${enumValue(r[k])}`);
    if (r.message && typeof r.message.stop_reason === 'string') inc(enums, `message.stop_reason=${enumValue(r.message.stop_reason)}`);
    if (r.message && typeof r.message.model === 'string') inc(enums, `message.model=${enumValue(r.message.model.replace(/[0-9]{8}$/, ''))}`);
    const content = r.message?.content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (!b || typeof b !== 'object') continue;
        inc(blockTypes, `${t}:${enumValue(b.type)}`);
        if (b.type === 'tool_result' && Array.isArray(b.content)) for (const c of b.content) inc(blockTypes, `${t}:tool_result>${enumValue(c?.type)}`);
      }
    } else if (typeof content === 'string') inc(blockTypes, `${t}:‹string›`);
    if (r.toolUseResult && typeof r.toolUseResult === 'object' && !Array.isArray(r.toolUseResult)) {
      inc(turKeys, Object.keys(r.toolUseResult).sort().join(','));
    } else if (r.toolUseResult !== undefined) inc(turKeys, `‹${typeOf(r.toolUseResult)}›`);
  }
}

/** @param {Map<string, Set<string>>} m */
const keysObj = (m) => Object.fromEntries([...m].sort(([a], [b]) => a.localeCompare(b)).map(([k, s]) => [k, [...s].sort().join('|')]));
/** @param {Map<string, number>} m */
const countObj = (m) => Object.fromEntries([...m].sort((a, b) => b[1] - a[1]));

const report = {
  dir: dir.replace(os.homedir(), '~'),
  registry: { files: regFiles, keys: keysObj(regKeys), values: countObj(regEnums) },
  transcripts: {
    filesModifiedWithinDays: files, days, lines, unparsable: bad,
    recordTypes: countObj(recTypes),
    keysByType: Object.fromEntries([...keysByType].map(([t, m]) => [t, keysObj(m)])),
    contentBlocks: countObj(blockTypes),
    toolUseResultKeySets: countObj(turKeys),
    enumValues: countObj(enums),
  },
  subagentMeta: keysObj(metaKeys),
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  /** @param {string} title @param {Record<string, unknown>} o */
  const sec = (title, o) => {
    console.log(`\n## ${title}`);
    for (const [k, v] of Object.entries(o)) console.log(`  ${k}: ${v}`);
  };
  console.log(`Kaynak: ${report.dir} — registry ${regFiles} dosya; transcript ${files} dosya / ${lines} satır (son ${days} gün, ${bad} bozuk)`);
  sec('registry anahtarları', report.registry.keys);
  sec('registry değer sayıları', report.registry.values);
  sec('kayıt tipleri', report.transcripts.recordTypes);
  for (const [t, ks] of Object.entries(report.transcripts.keysByType)) sec(`anahtarlar: ${t}`, ks);
  sec('content blokları', report.transcripts.contentBlocks);
  sec('toolUseResult anahtar kümeleri', report.transcripts.toolUseResultKeySets);
  sec('enum değerleri', report.transcripts.enumValues);
  sec('subagent meta anahtarları', report.subagentMeta);
}
