import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

const dirs: string[] = [];

/** Test başına geçici dizin; dosya bitince silinir. */
export function tmpDir(prefix = 'diji-scripts-'): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** Dizindeki tüm dosyalar (göreli yol → içerik). */
export function readTree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.set(path.relative(root, p), fs.readFileSync(p, 'utf8'));
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}

export const REPO_ROOT = path.resolve(__dirname, '../..');
