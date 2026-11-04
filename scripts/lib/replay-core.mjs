// @ts-check
// Fixture timeline'ını hedef bir Claude config dizinine zamanlı olarak yeniden yazar (05/01 replay).
// Dönüşümler: kayıt zaman damgaları ve registry ms alanları "şimdi"ye kaydırılır (speed ile sıkıştırılır);
// registry pid'leri canlı pid'lere eşlenir (allocPid), dosya adları sessions/<yeniPid>.json olur.

import fs from 'node:fs';
import path from 'node:path';

/** @typedef {{ at: number, op: 'write'|'append'|'delete', path: string, json?: unknown, line?: Record<string, unknown> }} TimelineOp */

/** fixtures/ altındaki oynatılabilir senaryolar (manifest.json + timeline.json). @param {string} root */
export function listFixtures(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter((n) => !n.startsWith('.') && fs.existsSync(path.join(root, n, 'manifest.json')) && fs.existsSync(path.join(root, n, 'timeline.json'))).sort();
}

/** @param {string} dir @returns {{ manifest: Record<string, unknown>, timeline: TimelineOp[] }} */
export function loadFixture(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const timeline = JSON.parse(fs.readFileSync(path.join(dir, 'timeline.json'), 'utf8'));
  if (!Array.isArray(timeline)) throw new Error('timeline.json dizi değil');
  for (const op of timeline) {
    if (typeof op.path !== 'string' || op.path.includes('..') || path.isAbsolute(op.path)) throw new Error(`Geçersiz timeline yolu: ${op.path}`);
  }
  return { manifest, timeline: [...timeline].sort((a, b) => a.at - b.at) };
}

/** Timeline'ın fixture saatindeki t=0 anı (ilk zaman damgalı kayıttan çıkarılır). @param {TimelineOp[]} tl */
export function fixtureEpoch(tl) {
  for (const op of tl) {
    const ts = op.line && typeof op.line.timestamp === 'string' ? Date.parse(op.line.timestamp) : NaN;
    if (Number.isFinite(ts)) return ts - op.at;
    const j = /** @type {Record<string, unknown> | undefined} */ (op.json);
    if (j && typeof j.startedAt === 'number') return j.startedAt - op.at;
  }
  return 0;
}

const REG_RE = /^sessions\/(\d+)\.json$/;

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Timeline'daki session kimlikleri (döngüde korunur: aynı session devam eder). @param {TimelineOp[]} tl */
export function sessionIdsOf(tl) {
  /** @type {Set<string>} */
  const out = new Set();
  for (const op of tl) {
    const j = /** @type {Record<string, unknown> | undefined} */ (op.json);
    for (const v of [j?.sessionId, op.line?.sessionId]) if (typeof v === 'string') out.add(v.toLowerCase());
  }
  return out;
}

/**
 * Döngü varyantı: kayıt/mesaj/araç kimliklerini değiştirir, session kimliklerini korur. Böylece aynı fixture
 * tekrar oynatıldığında motorun uuid/messageId tekilleştirmesi yeni kayıtları atlamaz ama session'lar aynı kalır
 * (bench: "4 aktif session" sürekli çalışır). variant 0 → değişiklik yok.
 * @template T @param {T} value @param {number} variant @param {Set<string>} keep
 * @returns {T}
 */
export function withVariant(value, variant, keep) {
  if (!variant || value === undefined || value === null) return value;
  const text = JSON.stringify(value)
    .replace(UUID_RE, (u) => (keep.has(u.toLowerCase()) ? u : `${((Number.parseInt(u.slice(0, 8), 16) ^ variant) >>> 0).toString(16).padStart(8, '0')}${u.slice(8)}`))
    .replace(/"msg_/g, `"msg_v${variant}_`)
    .replace(/"toolu_/g, `"toolu_v${variant}_`);
  return JSON.parse(text);
}

/**
 * @param {{
 *   fixtureDir: string, targetDir: string, speed?: number, startMs?: number,
 *   allocPid?: (fixturePid: number) => number,
 *   sleep?: (ms: number) => Promise<void>, signal?: AbortSignal,
 *   onOp?: (op: TimelineOp, i: number, total: number) => void,
 *   variant?: number, maxGapMs?: number,
 * }} o speed: 0 ya da Infinity → beklemesiz; variant: döngü numarası (withVariant);
 *   maxGapMs: iki işlem arası en uzun bekleme (hız uygulandıktan sonra) — benchmark'ta uzun boşlukları sıkıştırır
 * @returns {Promise<{ applied: number, pids: Map<number, number> }>}
 */
export async function replay(o) {
  const { timeline } = loadFixture(o.fixtureDir);
  const variant = o.variant ?? 0;
  const keep = variant ? sessionIdsOf(timeline) : new Set();
  const speed = o.speed ?? 5;
  const fast = !speed || !Number.isFinite(speed);
  // Beklemesiz oynatmada son işlem "şimdi"ye denk gelsin (gelecek tarihli kayıt olmasın).
  const lastAt = timeline.length ? (timeline[timeline.length - 1]?.at ?? 0) : 0;
  const startMs = o.startMs ?? (fast ? Date.now() - lastAt : Date.now());
  const epoch = fixtureEpoch(timeline);
  // skipped: maxGapMs ile atlanan oynatma süresi; zaman damgaları gerçek yazım anıyla uyumlu kalsın.
  let skipped = 0;
  /** fixture saati → oynatma saati @param {number} ms */
  const mapMs = (ms) => Math.round(startMs + (ms - epoch) / (fast ? 1 : speed) - skipped);
  // Varsayılan bekleme iptal sinyaliyle hemen biter (uzun timeline boşluklarında abort beklemesin).
  const sleep =
    o.sleep ??
    ((ms) =>
      new Promise((r) => {
        const t = setTimeout(done, ms);
        function done() {
          clearTimeout(t);
          o.signal?.removeEventListener('abort', done);
          r(undefined);
        }
        o.signal?.addEventListener('abort', done, { once: true });
      }));
  const maxGap = o.maxGapMs ?? Infinity;
  /** @type {Map<number, number>} */
  const pids = new Map();
  const pidFor = (/** @type {number} */ p) => {
    if (!pids.has(p)) pids.set(p, o.allocPid ? o.allocPid(p) : p);
    return /** @type {number} */ (pids.get(p));
  };
  /** @param {string} rel */
  const mapPath = (rel) => {
    const m = REG_RE.exec(rel);
    return m ? `sessions/${pidFor(Number(m[1]))}.json` : rel;
  };
  /** @param {unknown} j */
  const mapJson = (j) => {
    if (!j || typeof j !== 'object' || Array.isArray(j)) return j;
    const out = { .../** @type {Record<string, unknown>} */ (j) };
    if (typeof out.pid === 'number') out.pid = pidFor(out.pid);
    for (const k of ['startedAt', 'updatedAt', 'statusUpdatedAt']) if (typeof out[k] === 'number') out[k] = mapMs(/** @type {number} */ (out[k]));
    return out;
  };
  /** @param {Record<string, unknown>} line */
  const mapLine = (line) => {
    if (typeof line.timestamp !== 'string') return line;
    const ts = Date.parse(line.timestamp);
    return Number.isFinite(ts) ? { ...line, timestamp: new Date(mapMs(ts)).toISOString() } : line;
  };

  fs.mkdirSync(o.targetDir, { recursive: true });
  let prevAt = timeline[0]?.at ?? 0;
  let applied = 0;
  for (const [i, op] of timeline.entries()) {
    if (o.signal?.aborted) break;
    const wait = op.at - prevAt;
    prevAt = op.at;
    if (!fast && wait > 0) {
      const full = wait / speed;
      const ms = Math.min(maxGap, full);
      skipped += full - ms;
      await sleep(ms);
    }
    if (o.signal?.aborted) break;
    const abs = path.join(o.targetDir, mapPath(op.path));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (op.op === 'write') {
      // Claude Code gibi atomik: geçici dosya + rename.
      const tmp = `${abs}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(mapJson(withVariant(op.json, variant, keep)), null, 2) + '\n');
      fs.renameSync(tmp, abs);
    } else if (op.op === 'append') {
      fs.appendFileSync(abs, JSON.stringify(mapLine(withVariant(op.line ?? {}, variant, keep))) + '\n');
    } else if (op.op === 'delete') {
      fs.rmSync(abs, { force: true });
    }
    applied++;
    o.onOp?.(op, i, timeline.length);
  }
  return { applied, pids };
}
