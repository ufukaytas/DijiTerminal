#!/usr/bin/env node
// @ts-check
// Performans benchmark'ı (05/02). Sonucu Bölüm 10 bütçesiyle karşılaştırır.
//
//   npm run bench                 uygulama (Electron) + 4 fixture ×5 replay, 120 sn
//   npm run bench:hidden          aynısı; 20. sn'de pencere gizlenir, gizli faz ayrıca raporlanır
//   npm run bench:big             büyük günlük transcript klasörü (varsayılan 500 MB) ile ilk snapshot süresi
//   npm run bench:soak            60 dk döngülü replay, 5 dk'lık RSS trendi
//   npm run bench:headless        motor tek başına (Electron/GPU yok; CI ve konteyner için)
//
// Bayraklar: --headless --hidden --big [--mb 500] --soak --idle --duration <sn> --speed <×> --quality high|balanced --strict --keep
//            --terminal (07/01): bir arka plan session'ı eklenir, 5. sn'de gömülü terminalde sahte akışla açılır
// Rapor: bench-results/<ISO>-<senaryo>-<mod>.json. Bütçe aşımında exit 1 — yalnızca referans makinede
// (Apple M3) ya da --strict ile; başka makinede eşikler bilgi amaçlıdır.
// Gerçek ~/.claude okunmaz: her şey geçici bir CLAUDE_CONFIG_DIR'de olur ve sonunda silinir.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { evaluate, formatTable, isReferenceMachine } from './lib/budget.mjs';
import { replay } from './lib/replay-core.mjs';
import { generate, startOfToday } from './lib/synthetic-transcripts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const has = (/** @type {string} */ f) => args.includes(f);
const opt = (/** @type {string} */ f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

const headless = has('--headless');
const mode = headless ? 'headless' : 'app';
/** @type {import('./lib/budget.mjs').Scenario} */
const scenario = has('--big') ? 'big' : has('--soak') ? 'soak' : has('--idle') ? 'idle' : 'active';
const durationMs = Number(opt('--duration') ?? (scenario === 'soak' ? 3600 : scenario === 'big' ? 15 : 120)) * 1000;
const hideAtMs = has('--hidden') ? Math.min(20_000, Math.floor(durationMs / 2)) : 0;
const speed = Number(opt('--speed') ?? 5);
const bigMb = Number(opt('--mb') ?? 500);
/** Bellek bütçesi Dengeli kaliteye göre (Retina'da piksel oranı 1.5); Yüksek'i ölçmek için --quality high. */
const quality = opt('--quality') === 'high' ? 'high' : 'balanced';
const BENCH_FIXTURES = ['subagents-team', 'conflict-same-file', 'slow-tool', 'waiting-permission'];
/** 07/01: gömülü terminal açıkken ölçüm (sahte pty; gerçek claude çağrılmaz). */
const terminal = has('--terminal');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diji-bench-'));
const claudeDir = path.join(tmp, 'claude');
const userData = path.join(tmp, 'userdata');
fs.mkdirSync(path.join(claudeDir, 'sessions'), { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(claudeDir, 'projects'), { recursive: true, mode: 0o700 });
fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ schemaVersion: 1, renderQuality: quality }), { mode: 0o600 });
const outFile = path.join(tmp, 'perf.json');

/** @type {import('node:child_process').ChildProcess[]} */
const holders = [];
const ac = new AbortController();
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  ac.abort();
  for (const c of holders) c.kill('SIGTERM');
  if (!has('--keep')) fs.rmSync(tmp, { recursive: true, force: true });
}
process.on('exit', cleanup);
for (const sig of /** @type {const} */ (['SIGINT', 'SIGTERM'])) {
  process.on(sig, () => {
    cleanup();
    process.exit(130);
  });
}

/** Registry pid'leri için canlı yardımcı süreç (motor kill(pid,0) ile canlılık bakar). */
function holdPid() {
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
  holders.push(c);
  return c.pid ?? process.pid;
}

/**
 * Fixture'ı döngüde oynatır. Session'lar ve pid'ler döngüler arasında aynı kalır, kayıt kimlikleri
 * her döngüde değişir (withVariant) → motor için aynı 4 session sürekli çalışıyormuş gibi görünür.
 * @param {string} name
 */
async function loopFixture(name) {
  /** @type {Map<number, number>} */
  const pidMap = new Map();
  for (let variant = 0; !ac.signal.aborted; variant++) {
    await replay({
      fixtureDir: path.join(root, 'fixtures', name),
      targetDir: claudeDir,
      speed,
      signal: ac.signal,
      variant,
      maxGapMs: 3000, // fixture'lardaki dakikalık boşluklar ölçümü boş geçirmesin
      allocPid: (p) => {
        if (!pidMap.has(p)) pidMap.set(p, holdPid());
        return /** @type {number} */ (pidMap.get(p));
      },
    }).catch((e) => {
      if (!ac.signal.aborted) console.error(`[bench] replay ${name}:`, e);
    });
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Motor + PerfSampler'ı tek ESM dosyasına paketler (chokidar proje node_modules'ından çözülür). */
async function bundleEngine() {
  const dir = path.join(root, 'node_modules', '.diji-bench');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `engine-${process.pid}.mjs`);
  await build({
    stdin: {
      contents:
        "export { SessionEngine } from './src/main/engine/index';\nexport { PerfSampler } from './src/main/perf';\n",
      resolveDir: root,
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    external: ['chokidar'],
    alias: { '@shared': path.join(root, 'src/shared'), '@main': path.join(root, 'src/main') },
    outfile: out,
    logLevel: 'silent',
  });
  process.on('exit', () => fs.rmSync(out, { force: true }));
  return out;
}

/** @param {string} cmd @param {string[]} a @param {NodeJS.ProcessEnv} env */
function run(cmd, a, env) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, a, { cwd: root, env, stdio: ['ignore', 'inherit', 'inherit'] });
    c.on('error', reject);
    c.on('exit', (code) => resolve(code ?? 1));
  });
}

async function measureHeadless() {
  const bundle = await bundleEngine();
  const cfg = { bundle, configDir: claudeDir, appDataDir: userData, durationMs, hideAtMs, out: outFile };
  const code = await run(
    process.execPath,
    [path.join(root, 'scripts/lib/bench-engine-runner.mjs'), JSON.stringify(cfg)],
    { ...process.env },
  );
  if (code !== 0) throw new Error(`motor süreci ${code} ile çıktı`);
}

/** Klasördeki en yeni dosyanın mtime'ı (ms): derlenmiş çıktı kaynaktan eskiyse ölçüm eski kodu ölçer. */
function newestMtime(dir) {
  let max = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    max = Math.max(max, e.isDirectory() ? newestMtime(p) : fs.statSync(p).mtimeMs);
  }
  return max;
}

async function measureApp() {
  if (process.platform !== 'darwin')
    console.warn('[bench] Uyarı: uygulama ölçümü macOS için tasarlandı; burada --headless kullanın.');
  const built = path.join(root, 'out/main/index.js');
  const stale = fs.existsSync(built) && newestMtime(path.join(root, 'src')) > fs.statSync(built).mtimeMs;
  if (!fs.existsSync(built) || stale || has('--rebuild')) {
    console.log(`[bench] ${stale ? 'out/ kaynaktan eski' : 'out/ yok'}, derleniyor (npm run build)…`);
    if ((await run('npm', ['run', 'build'], process.env)) !== 0) throw new Error('derleme başarısız');
  }
  const require = createRequire(import.meta.url);
  /** @type {string} */
  const electron = require('electron');
  if (typeof electron !== 'string' || !fs.existsSync(electron))
    throw new Error('Electron ikili dosyası yok: npx install-electron');
  const env = {
    ...process.env,
    DIJI_CLAUDE_DIR: claudeDir,
    CLAUDE_CONFIG_DIR: claudeDir,
    DIJI_USER_DATA: userData, // ayrı userData: gerçek ayarlara/app.lock'a dokunmaz, açık uygulamayla tek-örnek kilidi çakışmaz
    DIJI_PERF: '1',
    DIJI_PERF_OUT: outFile,
    DIJI_BENCH_QUIT_AT: String(durationMs),
    ...(hideAtMs ? { DIJI_BENCH_HIDE_AT: String(hideAtMs) } : {}),
    ...(terminal ? { DIJI_TERMINAL_FAKE: '1', DIJI_BENCH_OPEN_TERMINAL: '5000' } : {}),
  };
  const code = await run(electron, [root], env);
  if (code !== 0) console.warn(`[bench] uygulama ${code} ile kapandı`);
}

async function main() {
  console.log(
    `[bench] senaryo: ${scenario} · mod: ${mode} · süre: ${durationMs / 1000} sn${hideAtMs ? ` · ${hideAtMs / 1000}. sn'de gizle` : ''}`,
  );
  if (scenario === 'big') {
    const t0 = Date.now();
    const g = generate(path.join(claudeDir, 'projects'), bigMb);
    console.log(
      `[bench] sentetik veri: ${g.files} dosya, ${(g.written / 1024 / 1024).toFixed(0)} MB (${Date.now() - t0} ms); gün başı ${new Date(startOfToday()).toISOString()}`,
    );
  }
  if (terminal) {
    // Arka plan session'ı (registry kind "bg" + jobId); canlı pid için yardımcı süreç.
    const now = Date.now();
    const entry = { pid: holdPid(), sessionId: 'b0b0b0b0-0000-4000-8000-000000000001', cwd: tmp, startedAt: now, updatedAt: now, statusUpdatedAt: now, status: 'busy', kind: 'bg', jobId: '0b0e0c0d', entrypoint: 'cli' };
    fs.writeFileSync(path.join(claudeDir, 'sessions', `${entry.pid}.json`), JSON.stringify(entry), { mode: 0o600 });
  }
  /** @type {Promise<void>[]} */
  const loops = scenario === 'active' || scenario === 'soak' ? BENCH_FIXTURES.map((n) => loopFixture(n)) : [];

  if (headless) await measureHeadless();
  else await measureApp();
  ac.abort();
  await Promise.allSettled(loops);

  if (!fs.existsSync(outFile)) throw new Error("perf raporu üretilmedi (DIJI_PERF bağlantısı main/index.ts'te mi?)");
  const report = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  const rows = evaluate(report, scenario);
  report.scenario = scenario;
  report.quality = quality;
  report.terminal = terminal;
  report.budgetViolations = rows
    .filter((r) => r.status === 'fail')
    .map((r) => ({ metric: r.key, value: r.value, limit: r.limit }));
  report.budget = rows;

  const ref = isReferenceMachine(report.machine);
  console.log(
    `\n${report.machine.cpuModel} · ${report.machine.cores} çekirdek · ${report.machine.memGb} GB · ${report.machine.os}`,
  );
  if (!ref) console.log('Not: referans makine (Apple M3) değil — eşikler bilgi amaçlı.');
  console.log(`İlk snapshot: ${report.firstSnapshotMs ?? '—'} ms · görüntü kalitesi: ${quality === 'high' ? 'Yüksek' : 'Dengeli'}${terminal ? ' · gömülü terminal açık (sahte akış)' : ''}`);
  const rr = report.renderer;
  if (rr && rr.modeShare) {
    const pct = (/** @type {number} */ v) => `%${Math.round(v * 100)}`;
    const s = rr.modeShare;
    console.log(
      `Harita döngüsü: aktif ${pct(s.active)} · ortam ${pct(s.ambient)} · boşta ${pct(s.idle)} · durdu ${pct(s.stopped)} — ` +
        `fps aktif ${rr.fpsActive ?? '—'} / ortam ${rr.fpsAmbient ?? '—'} / boşta ${rr.fpsIdle ?? '—'} · kare ${rr.frameMsAvg} ms (en çok ${rr.frameMsMax})`,
    );
  } else if (mode === 'app') console.log('Harita döngüsü: renderer örneği gelmedi (liste görünümü ya da WebGL yok).');
  console.log('');
  console.log(formatTable(rows, { color: process.stdout.isTTY }));

  const dir = path.join(root, 'bench-results');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${scenario}-${mode}${terminal ? '-terminal' : ''}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`\nRapor: ${path.relative(root, file)}`);

  const failed = report.budgetViolations.length > 0;
  cleanup();
  process.exit(failed && (ref || has('--strict')) ? 1 : 0);
}

main().catch((e) => {
  console.error('[bench]', e instanceof Error ? e.message : e);
  cleanup();
  process.exit(2);
});
