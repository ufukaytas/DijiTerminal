// Claude Code yolları
// Saf Node: electron importu yok.
import os from 'node:os';
import path from 'node:path';

export interface ClaudePaths {
  root: string;
  projects: string;
  sessions: string;
  settingsFile: string;
}

/** Kök klasör önceliği: ayar → $CLAUDE_CONFIG_DIR → ~/.claude (Claude Code'un kendi sırası). */
export function claudePaths(opts: { configDir?: string | null; home?: string } = {}): ClaudePaths {
  const root =
    opts.configDir || process.env['CLAUDE_CONFIG_DIR'] || path.join(opts.home ?? os.homedir(), '.claude');
  return {
    root,
    projects: path.join(root, 'projects'),
    sessions: path.join(root, 'sessions'),
    settingsFile: path.join(root, 'settings.json'),
  };
}

const isAsciiAlnum = (c: string): boolean => /^[A-Za-z0-9]$/.test(c);

/** cwd → projects altındaki klasör adı: ASCII harf/rakam dışındaki her karakter '-' olur. */
export function encodeCwd(cwd: string): string {
  let out = '';
  for (const ch of cwd) out += isAsciiAlnum(ch) ? ch : '-';
  return out;
}

export function transcriptPathFor(cwd: string, sid: string, paths: ClaudePaths = claudePaths()): string {
  return path.join(paths.projects, encodeCwd(cwd), `${sid}.jsonl`);
}

/** Subagent dosyalarının bulunduğu klasör (02/04). Sonunda ayırıcı vardır. */
export function subagentDirFor(cwd: string, sid: string, paths: ClaudePaths = claudePaths()): string {
  return path.join(paths.projects, encodeCwd(cwd), sid) + path.sep;
}
