#!/usr/bin/env node
// @ts-check
// Bir fixture'ı canlı gibi oynatır (05/01).
//   node scripts/replay.mjs <fixture> [--speed 5] [--dir <hedef>] [--loop] [--launch] [--once]
// --once: oynatma bitince çık (geçici dizin silinir).
// Hedef verilmezse 0700 izinli geçici dizin açılır ve çıkışta silinir.
// Registry pid'leri canlı pid'lere eşlenir: ilki bu sürecin pid'i, diğerleri uyuyan yardımcı süreçler.
// --launch: uygulamayı CLAUDE_CONFIG_DIR=<hedef> ile `npm run dev` olarak başlatır (shell yok, argüman dizisi).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listFixtures, replay } from './lib/replay-core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturesRoot = path.join(root, 'fixtures');
const args = process.argv.slice(2);
const opt = (/** @type {string} */ f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const valueFlags = new Set(['--speed', '--dir']);
const name = args.find((a, i) => !a.startsWith('--') && !valueFlags.has(args[i - 1] ?? ''));
const names = listFixtures(fixturesRoot);

if (!name || !names.includes(name)) {
  console.error(name ? `Fixture bulunamadı: ${name}` : 'Kullanım: replay.mjs <fixture> [--speed 5] [--dir <hedef>] [--loop] [--launch]');
  console.error(`Mevcut: ${names.join(', ') || '(yok — önce npm run fixtures:make)'}`);
  process.exit(1);
}
const speed = Number(opt('--speed') ?? 5);
if (!Number.isFinite(speed) || speed < 0) {
  console.error('--speed sıfır ya da pozitif sayı olmalı (0 = beklemesiz).');
  process.exit(1);
}
const loop = args.includes('--loop');
const launch = args.includes('--launch');

const MARKER = '.diji-replay';
let ownDir = false;
let target = opt('--dir');
if (target) {
  target = path.resolve(target);
  if (fs.existsSync(target) && fs.readdirSync(target).some((e) => e !== MARKER)) {
    if (!fs.existsSync(path.join(target, MARKER))) {
      console.error(`Hedef dizin boş değil ve replay dizini değil: ${target}`);
      process.exit(1);
    }
  }
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
} else {
  target = fs.mkdtempSync(path.join(os.tmpdir(), 'dijiterminal-replay-'));
  ownDir = true;
}
fs.chmodSync(target, 0o700);
const targetDir = target;

/** @type {import('node:child_process').ChildProcess[]} */
const children = [];
/** Uyuyan yardımcı süreç → canlı pid. */
function holdPid() {
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
  children.push(c);
  return c.pid ?? process.pid;
}

/** Hedefi temizle (yalnız replay dizini işaretli içerik). */
function resetTarget() {
  for (const e of fs.readdirSync(targetDir)) fs.rmSync(path.join(targetDir, e), { recursive: true, force: true });
  fs.writeFileSync(path.join(targetDir, MARKER), name + '\n');
}

const ac = new AbortController();
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  ac.abort();
  for (const c of children) c.kill('SIGTERM');
  if (ownDir) fs.rmSync(targetDir, { recursive: true, force: true });
}
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(143);
});
process.on('exit', cleanup);

console.log(`▶ ${name} → ${targetDir} (hız ×${speed || '∞'}${loop ? ', döngü' : ''})`);
console.log(`  CLAUDE_CONFIG_DIR=${targetDir}`);

if (launch) {
  const app = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'dev'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, CLAUDE_CONFIG_DIR: targetDir, DIJI_CLAUDE_DIR: targetDir },
  });
  children.push(app);
  app.on('exit', () => {
    cleanup();
    process.exit(0);
  });
}

do {
  resetTarget();
  let first = true;
  const r = await replay({
    fixtureDir: path.join(fixturesRoot, name),
    targetDir,
    speed,
    signal: ac.signal,
    allocPid: () => {
      if (first) {
        first = false;
        return process.pid;
      }
      return holdPid();
    },
    onOp: (op, i, total) => process.stdout.write(`\r  ${String(i + 1).padStart(3)}/${total} ${op.op.padEnd(6)} ${op.path.slice(-60)}\x1b[K`),
  });
  process.stdout.write(`\n  ✓ ${r.applied} işlem uygulandı\n`);
  if (loop && !ac.signal.aborted) {
    for (const c of children.splice(launch ? 1 : 0)) c.kill('SIGTERM');
    await new Promise((res) => setTimeout(res, 2000));
  }
} while (loop && !ac.signal.aborted);

if (launch) {
  console.log('  Uygulama açık; çıkmak için Ctrl+C.');
} else if (args.includes('--once')) {
  cleanup();
  process.exit(0);
} else {
  console.log(`  Oynatma bitti; pid'ler canlı ve dizin açık tutuluyor${ownDir ? ' (çıkışta silinir)' : ''}, çıkmak için Ctrl+C.`);
  setInterval(() => {}, 1 << 30);
}
