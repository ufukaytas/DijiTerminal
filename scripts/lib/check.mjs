// @ts-check
// Fixture sızıntı tarayıcısı (05/01). Değerleri asla yazdırmaz; yalnızca dosya:satır ve kural adı döner.
// Kurallar:
//   home-path    /Users/<ad> (yalnız /Users/demo serbest), C:\Users\<ad>
//   email        e-posta adresi (example.* / *.invalid / *.test / noreply@anthropic.com serbest)
//   username     bu makinedeki kullanıcı adı (os.userInfo().username, kısa/genel adlar hariç)
//   secret       sk-…, ghp_…, github_pat_…, AKIA…, xox?-… (değer 'FAKE' içeriyorsa serbest)
//   sentence     okunabilir cümle (40+ karakter, 6+ kelime) — yalnızca anonimleştirilmiş fixture'larda
//                (manifest source: 'anonymized') ya da strictSentences modunda; JSON(L) içinde yalnızca
//                metin taşıyan alanlarda bakılır. .md dosyaları bu kuraldan muaf.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** @typedef {{ file: string, line: number, rule: string }} Finding */

const SKIP_DIRS = new Set(['node_modules', '.git', 'big-transcript', 'big']);
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const GENERIC_USERS = new Set(['root', 'demo', 'user', 'node', 'claude', 'runner', 'admin', 'ubuntu', 'vscode', 'test', 'app', 'dev']);
const TEXT_KEYS = new Set([
  'text', 'content', 'prompt', 'thinking', 'lastPrompt', 'summary', 'description', 'aiTitle', 'title', 'stdout',
  'stderr', 'command', 'message', 'output', 'result', 'query', 'old_string', 'new_string', 'customTitle', 'name',
]);

const RE_HOME = /\/Users\/(?!demo(?:[/"'\s\\`]|$))[A-Za-z0-9._-]+|[A-Za-z]:\\\\?Users\\\\?(?!demo\b)[A-Za-z0-9._-]+/;
const RE_EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\.){1,8}[A-Za-z]{2,24}(?![A-Za-z])/g;
const EMAIL_OK = /@(example\.(com|org|net)|[a-z0-9.-]+\.(invalid|test|example|localhost))$|^noreply@anthropic\.com$|\.(png|jpe?g|gif|svg|webp|ico|js|mjs|cjs|ts|tsx|jsx|json|css|md|html?)$/i;
const RE_SECRET = /(?<![A-Za-z0-9])(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[abposr]-[A-Za-z0-9-]{10,})/g;

/** @param {string} s */
export function isReadableSentence(s) {
  if (s.length < 40) return false;
  const words = s.match(/\p{L}{2,}/gu) ?? [];
  if (words.length < 6) return false;
  const letters = (s.match(/\p{L}/gu) ?? []).length;
  const spaces = (s.match(/ /g) ?? []).length;
  return letters / s.length > 0.6 && spaces >= 5;
}

/** @returns {RegExp | null} */
function usernameRe() {
  let u;
  try {
    u = os.userInfo().username;
  } catch {
    return null;
  }
  if (!u || u.length < 4 || GENERIC_USERS.has(u.toLowerCase())) return null;
  return new RegExp(`(?<![A-Za-z0-9])${u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'i');
}

/**
 * Tek satır metin üzerinde regex kuralları.
 * @param {string} text @param {RegExp | null} userRe @returns {string[]}
 */
export function lineRules(text, userRe = usernameRe()) {
  /** @type {string[]} */
  const out = [];
  if (RE_HOME.test(text)) out.push('home-path');
  for (const m of text.matchAll(RE_EMAIL)) {
    if (!EMAIL_OK.test(m[0])) { out.push('email'); break; }
  }
  if (userRe && userRe.test(text)) out.push('username');
  for (const m of text.matchAll(RE_SECRET)) {
    if (!/FAKE/i.test(m[0])) { out.push('secret'); break; }
  }
  return out;
}

/**
 * JSON değerinde metin alanlarındaki okunabilir cümleleri bul.
 * @param {unknown} v @param {string} [key] @returns {boolean}
 */
export function hasSentence(v, key = '') {
  if (typeof v === 'string') return TEXT_KEYS.has(key) && isReadableSentence(v);
  if (Array.isArray(v)) return v.some((x) => hasSentence(x, key));
  if (v && typeof v === 'object') return Object.entries(v).some(([k, x]) => hasSentence(x, k === 'input' || k === 'toolUseResult' ? 'content' : k));
  return false;
}

/** Dosya/dizin adında kodlanmış ev dizini (-Users-<ad>-…) ya da kullanıcı adı. @param {string} base @param {RegExp | null} userRe */
function nameLeaks(base, userRe) {
  return /(^|-)Users-(?!demo(-|$))[A-Za-z0-9._]+/.test(base) || (!!userRe && userRe.test(base));
}

/** @param {string} dir @returns {boolean} */
function isAnonymizedFixture(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).source === 'anonymized';
  } catch {
    return false;
  }
}

/**
 * @param {string} file @param {{ sentences: boolean, userRe: RegExp | null }} o @returns {Finding[]}
 */
export function scanFile(file, o) {
  /** @type {Finding[]} */
  const out = [];
  const st = fs.statSync(file);
  if (st.size > MAX_FILE_BYTES) return out;
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 8000).includes(0)) return out; // ikili dosya
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  const ext = path.extname(file);
  const sentences = o.sentences && ext !== '.md';
  lines.forEach((ln, i) => {
    for (const rule of lineRules(ln, o.userRe)) out.push({ file, line: i + 1, rule });
    if (sentences && ext === '.jsonl' && ln.trim()) {
      try {
        if (hasSentence(JSON.parse(ln))) out.push({ file, line: i + 1, rule: 'sentence' });
      } catch { /* bozuk satır: başka fork'ların edge fixture'ları bilerek içerebilir */ }
    }
  });
  if (sentences && ext === '.json' && path.basename(file) !== 'manifest.json') {
    try {
      const j = JSON.parse(text);
      if (Array.isArray(j) && path.basename(file) === 'timeline.json') {
        j.forEach((op) => {
          if (hasSentence(op?.line) || hasSentence(op?.json)) out.push({ file, line: 1, rule: 'sentence' });
        });
      } else if (hasSentence(j)) out.push({ file, line: 1, rule: 'sentence' });
    } catch { /* geçersiz JSON fixture'ı (ör. hooks/invalid.json) */ }
  }
  return out;
}

/**
 * Dizinleri/dosyaları tara. Kök olarak verilen yollar hariç `.tmp-*` dizinleri ve büyük fixture'lar atlanır.
 * @param {string[]} roots @param {{ strictSentences?: boolean }} [opts] @returns {Finding[]}
 */
export function scanPaths(roots, opts = {}) {
  const userRe = usernameRe();
  /** @type {Finding[]} */
  const out = [];
  /** @param {string} p @param {boolean} sentences @param {boolean} isRoot */
  const walk = (p, sentences, isRoot) => {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      const base = path.basename(p);
      if (!isRoot && (SKIP_DIRS.has(base) || base.startsWith('.tmp-'))) return;
      if (!isRoot && nameLeaks(base, userRe)) out.push({ file: p, line: 0, rule: 'home-path' });
      const s = sentences || isAnonymizedFixture(p);
      for (const e of fs.readdirSync(p).sort()) walk(path.join(p, e), s, false);
    } else if (st.isFile()) {
      if (nameLeaks(path.basename(p), userRe)) out.push({ file: p, line: 0, rule: 'home-path' });
      out.push(...scanFile(p, { sentences, userRe }));
    }
  };
  for (const r of roots) if (fs.existsSync(r)) walk(path.resolve(r), !!opts.strictSentences, true);
  return out;
}

/** @param {string} dir @returns {number} bayt (atlanan dizinler hariç) */
export function dirSize(dir) {
  let n = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.tmp-')) n += dirSize(p);
    } else if (e.isFile()) n += fs.statSync(p).size;
  }
  return n;
}

/**
 * manifest.json taşıyan senaryo dizinlerinin yapısal doğrulaması.
 * @param {string} root fixtures/ @returns {{ dir: string, problem: string }[]}
 */
export function validateScenarios(root) {
  /** @type {{ dir: string, problem: string }[]} */
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const name of fs.readdirSync(root).sort()) {
    const dir = path.join(root, name);
    if (name.startsWith('.') || !fs.statSync(dir).isDirectory() || !fs.existsSync(path.join(dir, 'manifest.json'))) continue;
    /** @param {string} problem */
    const bad = (problem) => out.push({ dir: name, problem });
    let m;
    try {
      m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    } catch {
      bad('manifest.json okunamadı');
      continue;
    }
    if (m.name !== name) bad(`manifest.name (${m.name}) dizin adıyla uyuşmuyor`);
    if (!m.expect || typeof m.expect !== 'object') bad('manifest.expect yok');
    if (typeof m.now !== 'string' || !Number.isFinite(Date.parse(m.now))) bad('manifest.now geçerli ISO değil');
    if (!fs.existsSync(path.join(dir, 'claude'))) bad('claude/ dizini yok');
    try {
      const tl = JSON.parse(fs.readFileSync(path.join(dir, 'timeline.json'), 'utf8'));
      if (!Array.isArray(tl)) bad('timeline.json dizi değil');
      else {
        let prev = -Infinity;
        for (const op of tl) {
          if (typeof op.at !== 'number' || op.at < prev) { bad('timeline sıralı değil'); break; }
          prev = op.at;
          if (!['write', 'append', 'delete'].includes(op.op) || typeof op.path !== 'string' || op.path.includes('..') || path.isAbsolute(op.path)) {
            bad('timeline işlemi geçersiz');
            break;
          }
        }
      }
    } catch {
      bad('timeline.json okunamadı');
    }
  }
  return out;
}

const TYPE_UNION = /^(array|bigint|boolean|null|number|object|string|undefined)(\|(array|bigint|boolean|null|number|object|string|undefined))*$/;

/**
 * 09/01 şema golden'ları (fixtures/compat/schema-*.json): yalnızca şema içermeli.
 * Her string yaprak bir tip birleşimi ('string|null') olmalı (claudeVersion hariç); anahtarlar kısa ve cümle değil.
 * @param {string} root fixtures/ @returns {{ dir: string, problem: string }[]}
 */
export function validateCompatSchemas(root) {
  /** @type {{ dir: string, problem: string }[]} */
  const out = [];
  const dir = path.join(root, 'compat');
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    const where = `compat/${name}`;
    if (!/^schema-\d+\.\d+\.\d+\.json$/.test(name)) {
      out.push({ dir: where, problem: 'dosya adı schema-<sürüm>.json değil' });
      continue;
    }
    let j;
    try {
      j = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      out.push({ dir: where, problem: 'JSON okunamadı' });
      continue;
    }
    let bad = 0;
    /** @param {unknown} v @param {string} key @param {number} depth */
    const visit = (v, key, depth) => {
      if (bad) return;
      if (typeof v === 'string') {
        const okVersion = depth === 1 && key === 'claudeVersion' && /^\d+\.\d+\.\d+$/.test(v);
        if (!okVersion && !TYPE_UNION.test(v)) bad++;
      } else if (Array.isArray(v)) {
        bad++; // şema özetinde dizi yok
      } else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          if (k.length > 400 || isReadableSentence(k)) {
            bad++;
            return;
          }
          visit(x, k, depth + 1);
        }
      }
    };
    visit(j, '', 0);
    if (bad) out.push({ dir: where, problem: 'şema dışı değer içeriyor (yalnızca anahtar adları, tipler ve sayılar olmalı)' });
  }
  return out;
}
