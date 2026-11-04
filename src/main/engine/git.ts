// git kök çözümü — 02/05. Yalnızca execFile, 2 sn timeout; kabuk yok.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface GitRoots {
  toplevel: string;
  commonDir: string;
}

function run(args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { timeout: 2000, env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' } }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout), err: String(stderr) });
    });
  });
}

const lines = (s: string): string[] => s.split('\n').map((l) => l.trim()).filter(Boolean);

export async function gitRevParse(cwd: string): Promise<GitRoots | null> {
  if (!path.isAbsolute(cwd)) return null;
  try {
    if (!(await fs.promises.stat(cwd)).isDirectory()) return null;
  } catch {
    return null;
  }
  const r = await run(['-C', cwd, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir']);
  if (r.ok) {
    const [toplevel, commonDir] = lines(r.out);
    return toplevel && commonDir ? { toplevel, commonDir } : null;
  }
  // git < 2.31: --path-format tanınmıyor → bir kez onsuz dene.
  if (!/path-format/i.test(r.err)) return null;
  const r2 = await run(['-C', cwd, 'rev-parse', '--show-toplevel', '--git-common-dir']);
  if (!r2.ok) return null;
  const [toplevel, commonDir] = lines(r2.out);
  if (!toplevel || !commonDir) return null;
  // Eski git göreli yolu cwd'ye göre verir.
  return { toplevel, commonDir: path.resolve(cwd, commonDir) };
}
