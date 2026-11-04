// Motor testleri için küçük yardımcılar (02/01, 02/02).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Koşul sağlanana kadar bekler; en fazla `timeoutMs` (varsayılan 5 sn). */
export async function waitFor(cond: () => boolean, timeoutMs = 5000, stepMs = 20): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error('waitFor: zaman aşımı');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export function tmpDir(prefix = 'diji-eng-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Bir fixture klasörünü hedefe kopyalar. */
export function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

export const FIXTURES = path.resolve(__dirname, '..', '..', 'fixtures');

/** mtime'ı ileri al (aynı milisaniyede yazılan dosyalar için). */
export function bumpMtime(file: string, deltaMs = 2000): void {
  const st = fs.statSync(file);
  const t = new Date(st.mtimeMs + deltaMs);
  fs.utimesSync(file, t, t);
}
