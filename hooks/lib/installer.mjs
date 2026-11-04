// @ts-check
// DijiTerminal — Claude Code hook ve statusLine kurulumu
//
// Bağımlılıksız (yalnızca node:fs, node:path, node:os). Faz 1'de CLI (scripts/install-hooks.mjs),
// Faz 2'de Electron main (src/main/hooks.ts) aynı modülü kullanır.
//
// İlkeler:
//  - Kullanıcının settings.json'u her yazımdan önce yedeklenir; bozuksa hiçbir şey yazılmaz.
//  - Yalnızca kendi kayıtlarımız eklenir/kaldırılır (komut yolunda "/DijiTerminal/hooks/" geçenler).
//  - Kurulum idempotenttir; kaldırma, kurulum öncesi hale anlamsal olarak birebir döner.
//  - Kullanıcının mevcut statusLine'ı silinmez, zincirlenir.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const HOOK_EVENTS = /** @type {const} */ ([
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'Notification', 'Stop', 'SubagentStop', 'SessionEnd',
]);
const MATCHER_EVENTS = new Set(['PreToolUse', 'PostToolUse']);
const OWN_MARK = '/DijiTerminal/hooks/';
const HOOK_TIMEOUT_SEC = 5;
const MAX_BACKUPS = 10;
const REQUIRED_SCRIPTS = ['dijiterminal-hook.sh', 'statusline.sh'];
const OPTIONAL_SCRIPTS = ['notify.sh', 'focus-tty.sh'];

export class InstallError extends Error {
  /**
   * @param {'INVALID_JSON'|'NOT_WRITABLE'|'SOURCE_MISSING'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'InstallError';
    this.code = code;
  }
}

/** @param {{ configDir?: string | null }} [o] */
export function resolveSettingsPath(o = {}) {
  const dir = o.configDir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(dir, 'settings.json');
}

/** @param {{ dataDir?: string }} [o] */
export function resolveDataDir(o = {}) {
  return o.dataDir || process.env.DIJI_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'DijiTerminal');
}

/** Tek tırnaklı shell quote; yol içindeki ' karakteri kaçırılır. @param {string} s */
export function shellQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** @param {unknown} entry */
export function isOurs(entry) {
  return isObj(entry) && entry.type === 'command' && typeof entry.command === 'string' && entry.command.includes(OWN_MARK);
}

/**
 * @param {string} file
 * @returns {{ exists: boolean, raw: string | null, json: Record<string, any> }}
 */
export function readSettings(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return { exists: false, raw: null, json: {} };
    throw new InstallError('NOT_WRITABLE', `settings.json okunamadı: ${/** @type {Error} */ (e).message}`);
  }
  if (raw.trim() === '') return { exists: true, raw, json: {} };
  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new InstallError('INVALID_JSON', `settings.json okunamadı: ${/** @type {Error} */ (e).message}. Dosyayı düzeltip tekrar deneyin.`);
  }
  if (!isObj(json)) throw new InstallError('INVALID_JSON', 'settings.json bir JSON nesnesi değil. Dosyayı düzeltip tekrar deneyin.');
  return { exists: true, raw, json };
}

/** @param {Record<string, any>} json */
function hooksObject(json) {
  if (json.hooks === undefined) return undefined;
  if (!isObj(json.hooks)) throw new InstallError('INVALID_JSON', 'settings.json içindeki "hooks" alanı beklenen biçimde değil.');
  return json.hooks;
}

/**
 * Saf fonksiyon: kurulumdan sonra settings.json'un nasıl görüneceğini hesaplar.
 * @param {Record<string, any>} json
 * @param {{ hookCommand: string, statusCommand: string, statusLine: 'auto'|'skip', existingChain?: boolean }} o
 */
export function plan(json, o) {
  const next = structuredClone(json);
  /** @type {string[]} */
  const changes = [];
  const hooks = hooksObject(next) ?? (next.hooks = {});

  for (const event of HOOK_EVENTS) {
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) {
      throw new InstallError('INVALID_JSON', `settings.json içindeki "hooks.${event}" bir dizi değil.`);
    }
    const groups = hooks[event] ?? (hooks[event] = []);
    let found = false;
    for (const g of groups) {
      if (!isObj(g) || !Array.isArray(g.hooks)) continue;
      for (const h of g.hooks) {
        if (!isOurs(h)) continue;
        found = true;
        if (h.command !== o.hookCommand) { h.command = o.hookCommand; changes.push(`${event}: komut yolu güncellendi`); }
        if (h.timeout !== HOOK_TIMEOUT_SEC) { h.timeout = HOOK_TIMEOUT_SEC; }
      }
    }
    if (!found) {
      /** @type {Record<string, any>} */
      const group = {};
      if (MATCHER_EVENTS.has(event)) group.matcher = '*';
      group.hooks = [{ type: 'command', command: o.hookCommand, timeout: HOOK_TIMEOUT_SEC }];
      groups.push(group);
      const userGroups = groups.length - 1;
      changes.push(userGroups > 0 ? `${event}: eklendi (sizin ${userGroups} kaydınız korunuyor)` : `${event}: eklendi`);
    }
  }

  /** @type {'none'|'ours'|'chained'|'foreign'} */
  let statusLineMode;
  /** @type {{ command: string, padding?: number, original: Record<string, any> } | null} */
  let chain = null;
  const cur = next.statusLine;
  if (o.statusLine === 'skip') {
    statusLineMode = cur === undefined ? 'none' : isOurs(cur) ? (o.existingChain ? 'chained' : 'ours') : 'foreign';
    if (cur === undefined) changes.push('statusLine: atlandı (--no-statusline)');
  } else if (cur === undefined) {
    next.statusLine = { type: 'command', command: o.statusCommand, padding: 0 };
    statusLineMode = 'ours';
    changes.push('statusLine: eklendi (kullanım limitleri için)');
  } else if (isOurs(cur)) {
    if (cur.command !== o.statusCommand) { cur.command = o.statusCommand; changes.push('statusLine: komut yolu güncellendi'); }
    statusLineMode = o.existingChain ? 'chained' : 'ours';
  } else if (isObj(cur) && cur.type === 'command' && typeof cur.command === 'string') {
    chain = { command: cur.command, original: structuredClone(cur) };
    if (typeof cur.padding === 'number') chain.padding = cur.padding;
    next.statusLine = { type: 'command', command: o.statusCommand, padding: typeof cur.padding === 'number' ? cur.padding : 0 };
    statusLineMode = 'chained';
    changes.push('statusLine: zincirlendi (önceki status line\'ınız aynen görünmeye devam eder)');
  } else {
    statusLineMode = 'foreign';
    changes.push('statusLine: komut türünde olmadığı için dokunulmadı (limitler devre dışı)');
  }

  return { next, changes, statusLineMode, chain };
}

/**
 * Saf fonksiyon: yalnızca bizim kayıtları çıkarır, statusLine'ı geri yükler.
 * @param {Record<string, any>} json
 * @param {{ chain?: { command: string, padding?: number, original?: Record<string, any> } | null }} [o]
 */
export function planUninstall(json, o = {}) {
  const next = structuredClone(json);
  /** @type {string[]} */
  const changes = [];
  const hooks = hooksObject(next);
  if (hooks) {
    for (const event of Object.keys(hooks)) {
      const groups = hooks[event];
      if (!Array.isArray(groups)) continue;
      let removed = false;
      hooks[event] = groups.filter((g) => {
        if (!isObj(g) || !Array.isArray(g.hooks)) return true;
        const before = g.hooks.length;
        g.hooks = g.hooks.filter((h) => !isOurs(h));
        if (g.hooks.length === before) return true;
        removed = true;
        return g.hooks.length > 0;
      });
      if (removed) {
        changes.push(`${event}: kaldırıldı`);
        if (hooks[event].length === 0) delete hooks[event];
      }
    }
    if (Object.keys(hooks).length === 0 && changes.length > 0) delete next.hooks;
  }
  if (isOurs(next.statusLine)) {
    if (o.chain) {
      next.statusLine = o.chain.original
        ? structuredClone(o.chain.original)
        : { type: 'command', command: o.chain.command, ...(o.chain.padding !== undefined ? { padding: o.chain.padding } : {}) };
      changes.push('statusLine: önceki komutunuz geri yüklendi');
    } else {
      delete next.statusLine;
      changes.push('statusLine: kaldırıldı');
    }
  }
  return { next, changes };
}

// ---------- dosya sistemi ----------

/** @param {string} dataDir */
const chainPath = (dataDir) => path.join(dataDir, 'statusline-chain.json');
/** @param {string} dataDir */
const backupDir = (dataDir) => path.join(dataDir, 'backups');

/** @param {string} dataDir */
function readChain(dataDir) {
  try {
    const j = JSON.parse(fs.readFileSync(chainPath(dataDir), 'utf8'));
    return isObj(j) && typeof j.command === 'string' ? /** @type {{command:string,padding?:number,original?:Record<string,any>}} */ (j) : null;
  } catch {
    return null;
  }
}

/** @param {string} dataDir */
function latestBackup(dataDir) {
  try {
    const files = fs.readdirSync(backupDir(dataDir)).filter((f) => f.startsWith('claude-settings-')).sort();
    return files.length ? path.join(backupDir(dataDir), files[files.length - 1]) : null;
  } catch {
    return null;
  }
}

/**
 * @param {unknown} e
 * @param {string} what
 */
function fsError(e, what) {
  const err = /** @type {NodeJS.ErrnoException} */ (e);
  if (err && (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EROFS')) {
    return new InstallError('NOT_WRITABLE', `${what} yazılamıyor: izinleri kontrol edin.`);
  }
  return e instanceof Error ? e : new Error(String(e));
}

/** Aynı dizinde .tmp + rename. @param {string} file @param {string} content @param {number} mode */
function atomicWrite(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.diji-${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, file);
}

/** @param {string} dataDir @param {string} raw */
function writeBackup(dataDir, raw) {
  const dir = backupDir(dataDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let name = `claude-settings-${Date.now()}.json`;
  for (let i = 1; fs.existsSync(path.join(dir, name)); i++) name = `claude-settings-${Date.now()}-${i}.json`;
  const file = path.join(dir, name);
  fs.writeFileSync(file, raw, { mode: 0o600 });
  const all = fs.readdirSync(dir).filter((f) => f.startsWith('claude-settings-')).sort();
  for (const old of all.slice(0, Math.max(0, all.length - MAX_BACKUPS))) fs.rmSync(path.join(dir, old), { force: true });
  return file;
}

/** @param {string} sourceDir @param {string} dataDir */
function copyScripts(sourceDir, dataDir) {
  for (const f of REQUIRED_SCRIPTS) {
    if (!fs.existsSync(path.join(sourceDir, f))) throw new InstallError('SOURCE_MISSING', `Kurulacak script bulunamadı: ${path.join(sourceDir, f)}`);
  }
  const dest = path.join(dataDir, 'hooks');
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  for (const f of [...REQUIRED_SCRIPTS, ...OPTIONAL_SCRIPTS]) {
    const src = path.join(sourceDir, f);
    if (!fs.existsSync(src)) continue;
    fs.copyFileSync(src, path.join(dest, f));
    fs.chmodSync(path.join(dest, f), 0o755);
  }
  // notify.conf: yoksa örnekten oluştur, varsa kullanıcının ayarına dokunma (01/03)
  const conf = path.join(dataDir, 'notify.conf');
  const example = path.join(sourceDir, 'notify.conf.example');
  if (!fs.existsSync(conf) && fs.existsSync(example)) {
    fs.copyFileSync(example, conf);
    fs.chmodSync(conf, 0o600);
  }
}

/** @param {Record<string, any>} json */
const serialize = (json) => `${JSON.stringify(json, null, 2)}\n`;

/**
 * @param {{ configDir?: string | null, dataDir?: string }} [o]
 * @returns {import('./installer').HookInstallStatus}
 */
export function status(o = {}) {
  const settingsPath = resolveSettingsPath(o);
  const dataDir = resolveDataDir(o);
  const { json } = readSettings(settingsPath);
  const hooks = isObj(json.hooks) ? json.hooks : {};
  const installed = HOOK_EVENTS.every((ev) =>
    Array.isArray(hooks[ev]) && hooks[ev].some((g) => isObj(g) && Array.isArray(g.hooks) && g.hooks.some(isOurs)));
  /** @type {'none'|'ours'|'chained'|'foreign'} */
  let statusLine = 'none';
  if (json.statusLine !== undefined) statusLine = isOurs(json.statusLine) ? (readChain(dataDir) ? 'chained' : 'ours') : 'foreign';
  return { installed, statusLine, settingsPath, backupPath: latestBackup(dataDir) };
}

/**
 * @param {import('./installer').InstallOptions} o
 * @returns {Promise<{ status: import('./installer').HookInstallStatus, changes: string[] }>}
 */
export async function install(o) {
  const settingsPath = resolveSettingsPath(o);
  const dataDir = resolveDataDir(o);
  const settings = readSettings(settingsPath);
  const hookCommand = shellQuote(path.join(dataDir, 'hooks', 'dijiterminal-hook.sh'));
  const statusCommand = shellQuote(path.join(dataDir, 'hooks', 'statusline.sh'));
  const existingChain = readChain(dataDir) !== null;
  const p = plan(settings.json, { hookCommand, statusCommand, statusLine: o.statusLine ?? 'auto', existingChain });

  if (o.dryRun) return { status: status(o), changes: p.changes };

  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    copyScripts(o.sourceDir, dataDir);
    const nextText = serialize(p.next);
    // Anlamsal fark yoksa dosyaya dokunma: ikinci kurulum byte byte aynı bırakır.
    if (!settings.exists || nextText !== serialize(settings.json)) {
      if (settings.exists && settings.raw !== null) writeBackup(dataDir, settings.raw);
      if (p.chain) atomicWrite(chainPath(dataDir), serialize(p.chain), 0o600);
      atomicWrite(settingsPath, nextText, settings.exists ? fileMode(settingsPath) : 0o644);
    }
  } catch (e) {
    if (e instanceof InstallError) throw e;
    throw fsError(e, settingsPath);
  }
  return { status: status(o), changes: p.changes };
}

/**
 * @param {import('./installer').InstallOptions} o
 * @returns {Promise<{ status: import('./installer').HookInstallStatus, changes: string[] }>}
 */
export async function uninstall(o) {
  const settingsPath = resolveSettingsPath(o);
  const dataDir = resolveDataDir(o);
  const settings = readSettings(settingsPath);
  const chain = readChain(dataDir);
  const p = planUninstall(settings.json, { chain });

  if (o.dryRun) return { status: status(o), changes: p.changes };
  if (!settings.exists || p.changes.length === 0) {
    fs.rmSync(chainPath(dataDir), { force: true });
    return { status: status(o), changes: [] };
  }
  try {
    if (settings.raw !== null) writeBackup(dataDir, settings.raw);
    atomicWrite(settingsPath, serialize(p.next), fileMode(settingsPath));
    fs.rmSync(chainPath(dataDir), { force: true });
  } catch (e) {
    throw fsError(e, settingsPath);
  }
  return { status: status(o), changes: p.changes };
}

/** Mevcut dosyanın izinlerini koru. @param {string} file */
function fileMode(file) {
  try { return fs.statSync(file).mode & 0o777; } catch { return 0o644; }
}
