// Gerçek pty spawner (07/01): node-pty yalnızca ilk sekme açılırken yüklenir. Böylece testler, demo modu ve
// Linux CI native modül gerektirmez. node-pty 1.1.0'ın Mac prebuild'leri N-API'dir (Electron için yeniden derleme yok).
import fs from 'node:fs';
import path from 'node:path';
import type { PtyProcess, PtySpawn } from './ptyManager';

type NodePtyModule = typeof import('node-pty');
let mod: Promise<NodePtyModule> | null = null;

async function load(): Promise<NodePtyModule> {
  mod ??= import('node-pty').then((m) => {
    const x = m as NodePtyModule & { default?: NodePtyModule };
    return typeof x.spawn === 'function' ? x : (x.default as NodePtyModule);
  });
  return mod;
}

/**
 * node-pty 1.1.0 paketindeki `spawn-helper` çalıştırma izni olmadan gelir (scripts/fix-node-pty.mjs kurulumda düzeltir).
 * Geliştirme ortamında kurulum betiği atlandıysa burada bir kez daha denenir; paketli uygulamada (salt okunur) yalnızca kontrol.
 */
let helperChecked = false;
function ensureHelper(): void {
  if (helperChecked || process.platform !== 'darwin') return;
  helperChecked = true;
  try {
    const root = path.dirname(require.resolve('node-pty/package.json')).replace('app.asar', 'app.asar.unpacked');
    const helper = path.join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
    const st = fs.statSync(helper);
    if ((st.mode & 0o111) === 0) fs.chmodSync(helper, 0o755);
  } catch {
    // Bulunamadı ya da yazılamıyor: spawn hatası açıklayıcı mesajla döner.
  }
}

export const nodePtySpawn: PtySpawn = async (file, args, opts) => {
  const pty = await load();
  ensureHelper();
  const p = pty.spawn(file, args, {
    name: opts.name,
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd,
    env: opts.env as Record<string, string>,
    encoding: 'utf8',
  });
  const proc: PtyProcess = {
    get pid() {
      return p.pid;
    },
    onData: (cb) => p.onData(cb),
    onExit: (cb) =>
      p.onExit((e) => cb({ exitCode: e.exitCode, ...(e.signal !== undefined ? { signal: e.signal } : {}) })),
    write: (d) => p.write(d),
    resize: (c, r) => p.resize(c, r),
    kill: (sig) => p.kill(sig),
  };
  return proc;
};
