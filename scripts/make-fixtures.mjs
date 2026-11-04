#!/usr/bin/env node
// @ts-check
// Fixture üreteci (05/01).
//   node scripts/make-fixtures.mjs [--synthetic] [--only <ad>] [--force] [--include-big] [--out <dir>]
//   node scripts/make-fixtures.mjs --from ~/.claude --session <sessionId> --name <ad> [--force]
// Sentetik senaryolar fixtures/<ad>/ altına yazılır. big-transcript yalnızca --include-big ile ve gitignore'da.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENARIOS, ALL_SCENARIO_NAMES, bigTranscriptSpec } from './lib/scenarios.mjs';
import { encodeCwd } from './lib/fixture-builder.mjs';
import { anonymizeSession } from './lib/anonymize.mjs';
import { scanPaths } from './lib/check.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (/** @type {string} */ f) => args.includes(f);
const opt = (/** @type {string} */ f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const outRoot = path.resolve(opt('--out') ?? path.join(root, 'fixtures'));
const force = flag('--force');

/** @param {string} name */
function writeBig(name) {
  const spec = bigTranscriptSpec();
  const dir = path.join(outRoot, name);
  if (fs.existsSync(dir)) {
    if (!force) throw new Error(`Fixture zaten var: ${dir} (üzerine yazmak için --force)`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const cwd = '/Users/demo/Projects/demo-big';
  const sid = '0b16b16b-0000-4000-8000-000000000001';
  const pdir = path.join(dir, 'claude', 'projects', encodeCwd(cwd));
  fs.mkdirSync(pdir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'claude', 'sessions'), { recursive: true });
  const nowMs = Date.parse(spec.now);
  const fd = fs.openSync(path.join(pdir, `${sid}.jsonl`), 'w');
  let bytes = 0;
  let n = 0;
  let todayLines = 0;
  const pad = '▒'.repeat(300);
  const chunks = [];
  while (bytes < spec.targetBytes) {
    const today = bytes >= spec.yesterdayBytes;
    const ts = today ? nowMs - 3_600_000 + (n % 3_000_000) : nowMs - 30 * 3_600_000 + n * 10;
    n++;
    if (today) todayLines++;
    const uuid = `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
    const line = n % 2
      ? `{"parentUuid":null,"isSidechain":false,"type":"user","cwd":"${cwd}","sessionId":"${sid}","uuid":"${uuid}","timestamp":"${new Date(ts).toISOString()}","message":{"role":"user","content":"${pad}"}}\n`
      : `{"parentUuid":null,"isSidechain":false,"type":"assistant","cwd":"${cwd}","sessionId":"${sid}","uuid":"${uuid}","timestamp":"${new Date(ts).toISOString()}","message":{"id":"msg_big${n}","role":"assistant","model":"claude-opus-5-5","content":[{"type":"text","text":"${pad}"}],"stop_reason":"end_turn","usage":{"input_tokens":4,"output_tokens":10,"cache_read_input_tokens":100,"cache_creation_input_tokens":0}}}\n`;
    chunks.push(line);
    bytes += Buffer.byteLength(line);
    if (chunks.length >= 2000) fs.writeSync(fd, chunks.splice(0).join(''));
  }
  if (chunks.length) fs.writeSync(fd, chunks.join(''));
  fs.closeSync(fd);
  fs.writeFileSync(path.join(dir, 'claude', 'sessions', '41091.json'), JSON.stringify({
    pid: 41091, sessionId: sid, cwd, name: 'demo-big', kind: 'interactive', entrypoint: 'cli', status: 'idle',
    waitingFor: null, startedAt: nowMs - 3_600_000, updatedAt: nowMs - 60_000, statusUpdatedAt: nowMs - 60_000,
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'timeline.json'), '[]\n');
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    name: spec.name, description: spec.description, source: 'synthetic', generated: true, now: spec.now, pidAliveOverride: true,
    expect: { sessions: 1, maxFirstSnapshotMs: 1500, todayRecords: todayLines },
  }, null, 2) + '\n');
  return { bytes, lines: n, todayLines };
}

async function synthetic() {
  const only = opt('--only');
  const names = only ? [only] : Object.keys(SCENARIOS);
  if (only && !ALL_SCENARIO_NAMES.includes(only)) {
    console.error(`Fixture bulunamadı: ${only}. Mevcut: ${ALL_SCENARIO_NAMES.join(', ')}`);
    return 1;
  }
  const t0 = Date.now();
  for (const name of names) {
    if (name === 'big-transcript') continue;
    const make = SCENARIOS[/** @type {keyof typeof SCENARIOS} */ (name)];
    const r = make().build(path.join(outRoot, name), { force });
    console.log(`  ✓ ${name.padEnd(20)} ${String(r.files).padStart(2)} dosya, ${r.ops} işlem`);
  }
  if (flag('--include-big') || only === 'big-transcript') {
    const r = writeBig('big-transcript');
    console.log(`  ✓ big-transcript       ${(r.bytes / 1048576).toFixed(1)} MB, ${r.lines} satır (${r.todayLines} bugün) — gitignore'da`);
  }
  console.log(`${names.length} senaryo ${Date.now() - t0} ms'de üretildi → ${path.relative(process.cwd(), outRoot) || '.'}`);
  return 0;
}

async function fromReal() {
  const from = opt('--from');
  const sid = opt('--session');
  const name = opt('--name');
  if (!from || !sid || !name) {
    console.error('Kullanım: make-fixtures.mjs --from <claudeDir> --session <sessionId> --name <ad> [--force]');
    return 2;
  }
  if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(name) || ALL_SCENARIO_NAMES.includes(name) || ['registry', 'transcripts', 'projects', 'git', 'hooks', 'claude-settings'].includes(name)) {
    console.error(`Geçersiz ya da ayrılmış fixture adı: ${name}`);
    return 2;
  }
  const out = path.join(outRoot, name);
  if (fs.existsSync(out) && !force) {
    console.error(`Fixture zaten var: ${out} (üzerine yazmak için --force)`);
    return 2;
  }
  const tmp = fs.mkdtempSync(path.join(outRoot, `.tmp-${name}-`));
  try {
    const r = await anonymizeSession({ claudeDir: path.resolve(from.replace(/^~(?=\/|$)/, process.env.HOME ?? '~')), sessionId: sid, outDir: tmp, name });
    const findings = scanPaths([tmp], { strictSentences: true });
    if (findings.length) {
      console.error('Gerçek veri izi bulundu, fixture kaydedilmedi:');
      for (const f of findings.slice(0, 20)) console.error(`  ${path.relative(tmp, f.file)}:${f.line} ${f.rule}`);
      return 1;
    }
    if (fs.existsSync(out)) fs.rmSync(out, { recursive: true, force: true });
    fs.renameSync(tmp, out);
    console.log(`✓ ${name}: ${r.records} kayıt, ${r.files} dosya anonimleştirildi → ${path.relative(process.cwd(), out)}`);
    return 0;
  } finally {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const run = opt('--from') ? fromReal : synthetic;
run().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(2);
  },
);
