// `claude` CLI çözücü
// Finder'dan açılan GUI uygulaması kullanıcının shell PATH'ini görmez; `claude` ikilisini ve login PATH'ini
// bir kez bulur, sürümü ve `agents --json` desteğini doğrular, sonucu önbelleğe alır.
// Saf Node: electron importu yok. Tüm süreçler execFile ile, shell metni sabit; dış veri komut satırına girmez.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TerminalCapability } from '@shared/types';

export interface ExecOut {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}
export type CliExec = (
  file: string,
  args: string[],
  opts: { timeoutMs: number; env?: NodeJS.ProcessEnv; cwd?: string; maxBuffer?: number },
) => Promise<ExecOut>;

export const realExec: CliExec = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        timeout: opts.timeoutMs,
        env: opts.env,
        cwd: opts.cwd,
        maxBuffer: opts.maxBuffer ?? 1024 * 1024,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: unknown; killed?: boolean }) | null;
        resolve({
          ok: !e,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          code: e ? (typeof e.code === 'number' ? e.code : null) : 0,
          timedOut: Boolean(e?.killed),
        });
      },
    );
  });

/** Çözülmüş CLI: yol, sürüm ve pty/execFile için temizlenmiş ortam. */
export interface ResolvedClaude {
  path: string;
  version: string | null;
  /** pty ve execFile ortamı (login PATH, UTF-8, Electron değişkenleri temiz). */
  env: NodeJS.ProcessEnv;
}

export type ResolveResult =
  | { ok: true; cli: ResolvedClaude }
  | {
      ok: false;
      reason: 'not-found' | 'unsupported' | 'error';
      detail: string;
      path: string | null;
      version: string | null;
    };

export interface ClaudeCliOptions {
  /** Ayardaki elle girilmiş yol (null → otomatik). */
  settingsPath: () => string | null;
  /** Ayardaki claudeConfigDir: CLI'ye CLAUDE_CONFIG_DIR olarak geçer (null → ortamdaki değer). */
  configDir?: () => string | null;
  exec?: CliExec;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  exists?: (p: string) => boolean;
  /** Bench/geliştirme (DIJI_TERMINAL_FAKE=1): CLI aranmaz, sahte bir sonuç döner. */
  fake?: boolean;
}

const LOGIN_SCRIPT =
  'printf "\\n__DIJI_CLAUDE__%s\\n" "$(command -v claude 2>/dev/null)"; printf "__DIJI_PATH__%s\\n" "$PATH"';
const VERSION_RE = /(\d+\.\d+\.\d+)/;

/** Bilinen kurulum yerleri (native installer, npm global, Homebrew). */
export function knownLocations(home: string): string[] {
  return [
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
}

/** Login shell çıktısından işaretli satırları ayıklar (zsh temaları, uyarılar stdout'a yazabilir). */
export function parseLoginOutput(out: string): { claude: string | null; pathVar: string | null } {
  let claude: string | null = null;
  let pathVar: string | null = null;
  for (const line of out.split(/\r?\n/)) {
    const c = line.indexOf('__DIJI_CLAUDE__');
    if (c >= 0) {
      const v = line.slice(c + 15).trim();
      if (v.startsWith('/')) claude = v;
    }
    const p = line.indexOf('__DIJI_PATH__');
    if (p >= 0) {
      const v = line.slice(p + 13).trim();
      if (v) pathVar = v;
    }
  }
  return { claude, pathVar };
}

/** Electron/Node değişkenlerini atar; iç içe Claude Code işaretlerini temizler; terminal için UTF-8 ve renk. */
export function cliEnv(base: NodeJS.ProcessEnv, loginPath: string | null, configDir: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (k.startsWith('ELECTRON_') || k.startsWith('CHROME_') || k === 'NODE_OPTIONS' || k === 'NODE_ENV') continue;
    // DijiTerminal bir Claude Code session'ından başlatıldıysa (geliştirme) bu işaretler CLI'yi iç içe moda sokar.
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) continue;
    if (k.startsWith('DIJI_')) continue;
    env[k] = v;
  }
  if (loginPath) env['PATH'] = loginPath;
  if (configDir) env['CLAUDE_CONFIG_DIR'] = configDir;
  if (!env['LANG'] || !/utf-?8/i.test(env['LANG'])) env['LANG'] = 'en_US.UTF-8';
  env['TERM'] = 'xterm-256color';
  env['COLORTERM'] = 'truecolor';
  return env;
}

export class ClaudeCli {
  private readonly opts: ClaudeCliOptions;
  private readonly exec: CliExec;
  private pending: Promise<ResolveResult> | null = null;
  private result: ResolveResult | null = null;
  private loginPath: string | null | undefined = undefined;

  constructor(opts: ClaudeCliOptions) {
    this.opts = opts;
    this.exec = opts.exec ?? realExec;
  }

  /** Önbellekteki sonuç; yoksa çözer (aynı anda tek çözüm). */
  resolve(): Promise<ResolveResult> {
    if (this.result) return Promise.resolve(this.result);
    this.pending ??= this.doResolve().then((r) => {
      this.result = r;
      this.pending = null;
      return r;
    });
    return this.pending;
  }

  /** Ayar değişti ya da kullanıcı "Yeniden dene" dedi. Login PATH de yeniden okunur. */
  invalidate(): void {
    this.result = null;
    this.loginPath = undefined;
  }

  /** Senkron: son sonuç (henüz çözülmediyse null). */
  current(): ResolveResult | null {
    return this.result;
  }

  capability(enabled: boolean): TerminalCapability {
    const r = this.result;
    if (!enabled)
      return {
        available: false,
        reason: 'disabled',
        claudePath: r?.ok ? r.cli.path : null,
        claudeVersion: r?.ok ? r.cli.version : null,
        detail: 'Gömülü terminal ayarlardan kapalı.',
      };
    if (!r) return { available: false, reason: 'pending', claudePath: null, claudeVersion: null, detail: null };
    if (r.ok)
      return { available: true, reason: 'ok', claudePath: r.cli.path, claudeVersion: r.cli.version, detail: null };
    return { available: false, reason: r.reason, claudePath: r.path, claudeVersion: r.version, detail: r.detail };
  }

  private env(): NodeJS.ProcessEnv {
    return cliEnv(this.opts.env ?? process.env, this.loginPath ?? null, this.opts.configDir?.() ?? null);
  }

  private async login(): Promise<{ claude: string | null; pathVar: string | null }> {
    const base = this.opts.env ?? process.env;
    const shell = base['SHELL'] && base['SHELL'].startsWith('/') ? base['SHELL'] : '/bin/zsh';
    const r = await this.exec(shell, ['-l', '-i', '-c', LOGIN_SCRIPT], {
      timeoutMs: 5000,
      env: { ...base, TERM: 'dumb' },
    });
    return parseLoginOutput(r.stdout);
  }

  private async doResolve(): Promise<ResolveResult> {
    if (this.opts.fake) return { ok: true, cli: { path: '/usr/bin/true', version: 'sahte', env: this.env() } };
    const exists = this.opts.exists ?? ((p: string) => isExecutable(p));
    const home = this.opts.homedir ?? os.homedir();
    let candidate: string | null = null;

    const manual = this.opts.settingsPath();
    if (manual) {
      if (!exists(manual))
        return {
          ok: false,
          reason: 'not-found',
          detail: `Ayardaki claude yolu bulunamadı: ${manual}`,
          path: manual,
          version: null,
        };
      candidate = manual;
    }
    try {
      const l = await this.login();
      this.loginPath = l.pathVar;
      if (!candidate && l.claude && exists(l.claude)) candidate = l.claude;
    } catch {
      this.loginPath = null;
    }
    if (!candidate) candidate = knownLocations(home).find((p) => exists(p)) ?? null;
    if (!candidate) {
      return {
        ok: false,
        reason: 'not-found',
        detail: 'claude bulunamadı. Ayarlardan claude dosyasının yolunu girin (Terminal: command -v claude).',
        path: null,
        version: null,
      };
    }

    const env = this.env();
    const v = await this.exec(candidate, ['--version'], { timeoutMs: 8000, env });
    if (!v.ok)
      return {
        ok: false,
        reason: 'error',
        detail: 'claude --version çalıştırılamadı.',
        path: candidate,
        version: null,
      };
    const version = VERSION_RE.exec(v.stdout)?.[1] ?? null;
    const h = await this.exec(candidate, ['agents', '--help'], { timeoutMs: 8000, env });
    if (!h.ok || !/--json/.test(h.stdout + h.stderr)) {
      return {
        ok: false,
        reason: 'unsupported',
        detail:
          "Bu Claude Code sürümü arka plan session listesini (claude agents --json) desteklemiyor. Claude Code'u güncelleyin.",
        path: candidate,
        version,
      };
    }
    return { ok: true, cli: { path: candidate, version, env } };
  }
}

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
