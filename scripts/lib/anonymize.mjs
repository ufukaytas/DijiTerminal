// @ts-check
// Gerçek bir Claude Code session'ını repoya konabilir fixture'a çeviren anonimleştirme (05/01 --from modu).
// Kaynak (~/.claude) yalnızca okunur. Kural: yapı, sayılar, tip/model/durum alanları korunur;
// metinler aynı uzunlukta '▒' yer tutucu olur; id'ler tuzlu ve deterministik yeniden üretilir (ilişkiler korunur);
// yollar /Users/demo/Projects/demo-N altına eşlenir; zamanlar 2026-01-01T09:00Z'a kaydırılır.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeCwd, seededId, seededUuid } from './fixture-builder.mjs';

export const BASE_TIME = Date.parse('2026-01-01T09:00:00.000Z');
const PLACEHOLDER = '▒';
const MAX_TEXT = 2000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Değeri olduğu gibi kalan alanlar (enum benzeri, motorun asıl girdileri). */
const KEEP_KEYS = new Set([
  'type', 'role', 'subtype', 'model', 'stop_reason', 'stop_sequence', 'version', 'userType', 'level', 'requestShape',
  'media_type', 'service_tier', 'status', 'entrypoint', 'kind', 'speed', 'trigger', 'agentType', 'subagent_type',
  'effort', 'permissionMode', 'codeText', 'resolvedModel', 'action',
]);
const ID_KEYS = new Set([
  'uuid', 'parentUuid', 'logicalParentUuid', 'leafUuid', 'sessionId', 'tool_use_id', 'toolUseId', 'agentId',
  'requestId', 'promptId', 'messageId', 'hostSessionId', 'id',
]);
const PATH_KEYS = new Set(['cwd', 'file_path', 'notebook_path', 'path', 'filePath', 'transcript_path', 'projectDir']);
const TIME_MS_KEYS = new Set(['startedAt', 'updatedAt', 'statusUpdatedAt']);
const COMMON_SEGMENTS = new Set([
  'src', 'lib', 'app', 'apps', 'packages', 'tests', 'test', '__tests__', 'components', 'pages', 'public', 'scripts',
  'docs', 'config', 'utils', 'hooks', 'api', 'server', 'client', 'styles', 'assets', '.claude', 'agents', 'worktrees',
  'node_modules', 'dist', 'build', 'migrations', 'db', 'supabase', 'functions',
]);

/** Repo kökünde .fixture-salt (gitignore'da); yoksa oluşturur. @param {string} repoRoot */
export function getSalt(repoRoot) {
  const f = path.join(repoRoot, '.fixture-salt');
  try {
    return fs.readFileSync(f, 'utf8').trim();
  } catch {
    const s = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(f, s + '\n', { mode: 0o600 });
    return s;
  }
}

export class Anonymizer {
  /** @param {{ salt: string, home?: string }} o */
  constructor(o) {
    this.salt = o.salt;
    this.home = (o.home ?? os.homedir()).replace(/\/+$/, '');
    /** @type {Map<string, string>} */ this.ids = new Map();
    /** @type {string[]} gerçek proje kökleri, eşleme sırası demo-1, demo-2… */ this.roots = [];
    /** @type {Map<string, string>} */ this.branches = new Map();
    /** @type {Map<number, number>} */ this.pids = new Map();
    this.timeBase = /** @type {number | null} */ (null);
  }

  /** @param {string} s */
  hash(s) {
    return crypto.createHash('sha1').update(this.salt + ':' + s).digest('hex');
  }

  /** Kimlik eşlemesi; aynı girdi her zaman aynı çıktıyı verir. @param {string} v */
  id(v) {
    const hit = this.ids.get(v);
    if (hit) return hit;
    let out;
    const seed = this.salt + ':' + v;
    if (UUID_RE.test(v)) out = seededUuid(seed);
    else if (v.startsWith('msg_')) out = seededId(seed, 'msg_');
    else if (v.startsWith('toolu_')) out = seededId(seed, 'toolu_');
    else if (v.startsWith('req_')) out = seededId(seed, 'req_');
    else if (/^[0-9a-f]+$/i.test(v)) out = this.hash(v).slice(0, v.length);
    else out = seededId(seed, '', Math.min(Math.max(v.length, 6), 32));
    this.ids.set(v, out);
    return out;
  }

  /** Session cwd'sini proje köküne kaydet (worktree → ana kök). @param {string} cwd */
  learnRoot(cwd) {
    const root = cwd.split('/.claude/worktrees/')[0] ?? cwd;
    if (!this.roots.includes(root)) this.roots.push(root);
  }

  /** @param {string} seg */
  segment(seg) {
    if (!seg || COMMON_SEGMENTS.has(seg)) return seg;
    const dot = seg.lastIndexOf('.');
    const ext = dot > 0 && seg.length - dot <= 6 ? seg.slice(dot) : '';
    return (ext ? 'f' : 'd') + this.hash(seg).slice(0, 6) + ext;
  }

  /** Mutlak yol eşlemesi. @param {string} p */
  path(p) {
    if (typeof p !== 'string' || !p.startsWith('/')) return typeof p === 'string' ? this.text(p) : p;
    const roots = [...this.roots].sort((a, b) => b.length - a.length);
    for (const r of roots) {
      if (p === r || p.startsWith(r + '/')) {
        const n = this.roots.indexOf(r) + 1;
        const rest = p.slice(r.length).split('/').filter(Boolean);
        const mapped = rest.map((s, i) => (rest[i - 1] === 'worktrees' ? 'wt-' + this.hash(s).slice(0, 4) : this.segment(s)));
        return [`/Users/demo/Projects/demo-${n}`, ...mapped].join('/');
      }
    }
    if (p === this.home || p.startsWith(this.home + '/')) {
      const rest = p.slice(this.home.length).split('/').filter(Boolean).map((s) => this.segment(s));
      return ['/Users/demo', ...rest].join('/');
    }
    if (/^\/(tmp|usr|opt|bin|etc|var|private\/tmp|System|Applications)(\/|$)/.test(p)) return p.replace(/\/Users\/[^/]+/g, '/Users/demo');
    return '/x/' + p.split('/').filter(Boolean).map((s) => this.segment(s)).join('/');
  }

  /** @param {string} s */
  text(s) {
    return PLACEHOLDER.repeat(Math.min([...s].length, MAX_TEXT));
  }

  /** @param {string} b */
  branch(b) {
    if (b === 'main' || b === 'master' || b === 'HEAD' || b === 'develop') return b;
    if (!this.branches.has(b)) this.branches.set(b, `feature/demo-${this.branches.size + 1}`);
    return /** @type {string} */ (this.branches.get(b));
  }

  /** @param {number} ms */
  timeMs(ms) {
    if (this.timeBase === null) this.timeBase = ms;
    return BASE_TIME + (ms - this.timeBase);
  }

  /** @param {string} iso */
  timeIso(iso) {
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? new Date(this.timeMs(ms)).toISOString() : iso;
  }

  /** @param {number} pid */
  pid(pid) {
    if (!this.pids.has(pid)) this.pids.set(pid, 42000 + this.pids.size + 1);
    return /** @type {number} */ (this.pids.get(pid));
  }

  /**
   * Bir JSON değerini kurallarla dönüştür.
   * @param {unknown} v @param {string} [key] @param {Record<string, unknown>} [parent]
   * @returns {unknown}
   */
  value(v, key = '', parent = {}) {
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'number') {
      if (TIME_MS_KEYS.has(key)) return this.timeMs(v < 1e12 ? v * 1000 : v);
      if (key === 'pid') return this.pid(v);
      return v;
    }
    if (Array.isArray(v)) return v.map((x) => this.value(x, key, parent));
    if (typeof v === 'object') {
      /** @type {Record<string, unknown>} */
      const o = /** @type {Record<string, unknown>} */ (v);
      /** @type {Record<string, unknown>} */
      const out = {};
      for (const [k, x] of Object.entries(o)) out[k] = this.value(x, k, o);
      return out;
    }
    if (typeof v !== 'string') return v;
    if (KEEP_KEYS.has(key)) return v;
    if (key === 'name' && (parent.type === 'tool_use' || parent.type === 'server_tool_use')) return v; // araç adı
    if (ID_KEYS.has(key)) return this.id(v);
    if (PATH_KEYS.has(key)) return this.path(v);
    if (key === 'timestamp') return this.timeIso(v);
    if (key === 'gitBranch') return this.branch(v);
    if (key === 'url') return `https://example.com/${this.hash(v).slice(0, 8)}`;
    if (key === 'data' && parent.type === 'base64') return 'A'.repeat(1024);
    if (key === 'signature') return 'sig';
    return this.text(v);
  }
}

/** @param {string} dir @returns {string[]} */
function walkFiles(dir) {
  /** @type {string[]} */
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(p));
    else out.push(p);
  }
  return out;
}

/** @param {string} file @returns {Record<string, unknown>[]} */
function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
    try {
      const o = JSON.parse(l);
      return o && typeof o === 'object' ? [o] : [];
    } catch {
      return [];
    }
  });
}

/**
 * @param {{ claudeDir: string, sessionId: string, outDir: string, name: string, salt?: string, home?: string, repoRoot?: string }} o
 * @returns {Promise<{ records: number, files: number }>}
 */
export async function anonymizeSession(o) {
  const projects = path.join(o.claudeDir, 'projects');
  if (!fs.existsSync(projects)) throw new Error(`Claude projeleri bulunamadı: ${projects}`);
  let mainFile = null;
  for (const d of fs.readdirSync(projects)) {
    const f = path.join(projects, d, `${o.sessionId}.jsonl`);
    if (fs.existsSync(f)) { mainFile = f; break; }
  }
  if (!mainFile) throw new Error('Bu session transcript\'i bulunamadı.');
  const subDir = mainFile.slice(0, -'.jsonl'.length);
  const subFiles = walkFiles(subDir).filter((f) => /agent-[^/]+\.(jsonl|meta\.json)$/.test(f));

  const salt = o.salt ?? getSalt(o.repoRoot ?? process.cwd());
  const a = new Anonymizer({ salt, ...(o.home ? { home: o.home } : {}) });

  const mainRecs = readJsonl(mainFile);
  /** @type {Map<string, Record<string, unknown>[]>} */
  const subRecs = new Map();
  for (const f of subFiles.filter((x) => x.endsWith('.jsonl'))) subRecs.set(f, readJsonl(f));

  // Kökleri ve zaman tabanını öğren (en erken kayıt → BASE_TIME).
  const all = [...mainRecs, ...[...subRecs.values()].flat()];
  for (const r of all) if (typeof r.cwd === 'string') a.learnRoot(r.cwd);
  const times = all.map((r) => Date.parse(String(r.timestamp ?? ''))).filter(Number.isFinite);
  if (times.length) a.timeBase = Math.min(...times);

  // Registry dosyası (varsa)
  /** @type {Record<string, unknown> | null} */
  let reg = null;
  const sessDir = path.join(o.claudeDir, 'sessions');
  if (fs.existsSync(sessDir)) {
    for (const f of fs.readdirSync(sessDir).filter((x) => /^\d+\.json$/.test(x))) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(sessDir, f), 'utf8'));
        if (j && j.sessionId === o.sessionId) { reg = j; break; }
      } catch { /* yarım dosya */ }
    }
  }
  const firstCwd = /** @type {string} */ (all.find((r) => typeof r.cwd === 'string')?.cwd ?? (reg?.cwd ?? '/Users/demo/Projects/demo-1'));
  if (typeof firstCwd === 'string') a.learnRoot(firstCwd);
  const lastMs = times.length ? Math.max(...times) : Date.now();
  if (!reg) {
    reg = { pid: 99999, sessionId: o.sessionId, cwd: firstCwd, name: null, kind: 'interactive', entrypoint: 'cli', status: 'idle', waitingFor: null, startedAt: a.timeBase ?? lastMs, updatedAt: lastMs, statusUpdatedAt: lastMs };
  }

  const newSid = a.id(o.sessionId);
  const newCwd = a.path(firstCwd);
  const claude = path.join(o.outDir, 'claude');
  const encDir = path.join(claude, 'projects', encodeCwd(newCwd));
  fs.mkdirSync(encDir, { recursive: true });
  fs.mkdirSync(path.join(claude, 'sessions'), { recursive: true });

  /** @type {{ at: number, op: string, path: string, line?: unknown, json?: unknown }[]} */
  const timeline = [];
  const rel = (/** @type {string} */ p) => path.relative(claude, p);
  const atOf = (/** @type {unknown} */ ts) => {
    const ms = Date.parse(String(ts ?? ''));
    return Number.isFinite(ms) && a.timeBase !== null ? ms - a.timeBase : 0;
  };

  const regOut = /** @type {Record<string, unknown>} */ (a.value(reg));
  const regPath = path.join(claude, 'sessions', `${regOut.pid}.json`);
  fs.writeFileSync(regPath, JSON.stringify(regOut, null, 2) + '\n');
  timeline.push({ at: 0, op: 'write', path: rel(regPath), json: regOut });

  let records = 0;
  /** @param {string} out @param {Record<string, unknown>[]} recs */
  const writeRecs = (out, recs) => {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const lines = recs.map((r) => {
      const at = atOf(r.timestamp);
      const v = a.value(r);
      timeline.push({ at, op: 'append', path: rel(out), line: v });
      records++;
      return JSON.stringify(v);
    });
    fs.writeFileSync(out, lines.join('\n') + (lines.length ? '\n' : ''));
  };
  writeRecs(path.join(encDir, `${newSid}.jsonl`), mainRecs);
  let files = 2;
  for (const [f, recs] of subRecs) {
    const relSub = path.relative(subDir, f).split('/').map((s) => s.replace(/^agent-(.+)\.jsonl$/, (_m, id) => `agent-${a.id(id)}.jsonl`)).join('/');
    writeRecs(path.join(encDir, newSid, relSub), recs);
    files++;
  }
  for (const f of subFiles.filter((x) => x.endsWith('.meta.json'))) {
    try {
      const meta = JSON.parse(fs.readFileSync(f, 'utf8'));
      const out = /** @type {Record<string, unknown>} */ (a.value(meta));
      if (meta && typeof meta.description === 'string') out.description = `${o.name} ajan`;
      const relSub = path.relative(subDir, f).split('/').map((s) => s.replace(/^agent-(.+)\.meta\.json$/, (_m, id) => `agent-${a.id(id)}.meta.json`)).join('/');
      const p = path.join(encDir, newSid, relSub);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(out, null, 2) + '\n');
      timeline.push({ at: 0, op: 'write', path: rel(p), json: out });
      files++;
    } catch { /* bozuk meta atlanır */ }
  }
  timeline.sort((x, y) => x.at - y.at);
  fs.writeFileSync(path.join(o.outDir, 'timeline.json'), JSON.stringify(timeline) + '\n');
  fs.writeFileSync(path.join(o.outDir, 'manifest.json'), JSON.stringify({
    name: o.name,
    description: `Anonimleştirilmiş gerçek session (${o.name}).`,
    source: 'anonymized',
    now: new Date(a.timeMs(lastMs) + 60_000).toISOString(),
    pidAliveOverride: true,
    expect: { sessions: 1 },
  }, null, 2) + '\n');
  return { records, files };
}
