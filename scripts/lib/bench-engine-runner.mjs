// @ts-check
// Başsız benchmark süreci (05/02 `bench --headless`): SessionEngine'i Electron olmadan çalıştırır ve
// PerfSampler ile ölçer. bench.mjs bunu ayrı süreç olarak başlatır; böylece replay yazıcısının CPU'su
// ölçüme karışmaz. Argümanlar JSON olarak verilir:
//   node bench-engine-runner.mjs '{"bundle":"…","configDir":"…","appDataDir":"…","durationMs":120000,"hideAtMs":20000,"out":"…"}'

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const cfg = JSON.parse(process.argv[2] ?? '{}');
const { SessionEngine, PerfSampler } = await import(pathToFileURL(cfg.bundle).href);

let lastCpu = process.cpuUsage();
let lastAt = performance.now();
/** Bu sürecin CPU'su (tek çekirdek = %100) ve RSS'i, Electron ProcessMetric biçiminde ('Browser' = main). */
function metrics() {
  const cpu = process.cpuUsage(lastCpu);
  const now = performance.now();
  const pct = ((cpu.user + cpu.system) / 1000 / Math.max(1, now - lastAt)) * 100;
  lastCpu = process.cpuUsage();
  lastAt = now;
  return [
    { type: 'Browser', cpu: { percentCPUUsage: pct }, memory: { workingSetSize: process.memoryUsage().rss / 1024 } },
  ];
}

/** @type {'visible' | 'hidden'} */
let visibility = 'visible';
const engine = new SessionEngine({ configDir: cfg.configDir, appDataDir: cfg.appDataDir });
const sampler = new PerfSampler({
  metrics,
  engine,
  bytesRead: () => engine.internals?.pool?.stats?.().bytesRead ?? 0,
  visibility: () => visibility,
  mode: 'headless',
});

sampler.start(cfg.intervalMs ?? 1000);
const t0 = performance.now();
await engine.start();
// Motor booted snapshot'ı yayınlamadan start() dönebilir; onSnapshot yakalamazsa start süresini kullan.
sampler.markFirstSnapshot(performance.now() - t0);

if (cfg.hideAtMs) {
  setTimeout(() => {
    visibility = 'hidden';
    engine.setTempo('background');
  }, cfg.hideAtMs);
}

await new Promise((r) => setTimeout(r, cfg.durationMs));
sampler.sample();
sampler.stop();
await engine.stop();
fs.writeFileSync(cfg.out, JSON.stringify(sampler.report(), null, 2));
process.exit(0);
