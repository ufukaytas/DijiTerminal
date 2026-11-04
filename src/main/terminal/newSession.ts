// "Yeni oturum" (07/01): bilinen bir proje kökünde `claude --bg [görev]` başlatır.
// İzin modu bayrağı verilmez (kullanıcının varsayılanı); görev metni argv olarak geçer, shell yok, loglanmaz.
import fs from 'node:fs';
import { BG_ID_RE, BG_TASK_MAX } from '@shared/ipc';
import { isAbsolutePath } from '@shared/settings';
import type { CliExec, ResolvedClaude } from '../engine/claudeCli';

export type StartResult = { ok: true; bgId: string } | { ok: false; code: 'BAD_INPUT' | 'INTERNAL'; message: string };

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f]/;
const BG_LINE_RE = /backgrounded\s*·\s*([0-9a-f]{8})\b/i;

/** Kontrol karakterleri (satır sonu ve sekme hariç) yasak; boş görev null. */
export function validateTask(task: unknown): { ok: true; task: string | null } | { ok: false; message: string } {
  if (task === null || task === undefined) return { ok: true, task: null };
  if (typeof task !== 'string') return { ok: false, message: 'Görev metin olmalı.' };
  const t = task.trim();
  if (!t) return { ok: true, task: null };
  if (t.length > BG_TASK_MAX) return { ok: false, message: `Görev en fazla ${BG_TASK_MAX} karakter olabilir.` };
  if (CONTROL_RE.test(t)) return { ok: false, message: 'Görev metninde kontrol karakteri olamaz.' };
  // `-` ile başlayan görev CLI bayrağı sanılmasın.
  if (t.startsWith('-')) return { ok: true, task: ` ${t}` };
  return { ok: true, task: t };
}

/** `claude --bg` çıktısındaki kısa kimlik ("backgrounded · 2cefe1b1"). */
export function parseBackgrounded(out: string): string | null {
  // eslint-disable-next-line no-control-regex
  const m = BG_LINE_RE.exec(out.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ''));
  const id = m?.[1]?.toLowerCase() ?? null;
  return id && BG_ID_RE.test(id) ? id : null;
}

export interface StartDeps {
  cli: ResolvedClaude;
  exec: CliExec;
  /** cwd beyaz listesi: ayarlardaki projeler, görünen proje kökleri, son klasör seçimleri. */
  allowedCwd: (cwd: string) => boolean;
  isDir?: (p: string) => boolean;
}

export async function startBackground(cwd: unknown, task: unknown, deps: StartDeps): Promise<StartResult> {
  if (typeof cwd !== 'string' || !isAbsolutePath(cwd))
    return { ok: false, code: 'BAD_INPUT', message: 'Geçersiz klasör.' };
  const dir = cwd.replace(/\/+$/, '') || '/';
  if (!deps.allowedCwd(dir))
    return { ok: false, code: 'BAD_INPUT', message: 'Bu klasör bilinen projeler arasında değil.' };
  const isDir =
    deps.isDir ??
    ((p: string) => {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
  if (!isDir(dir)) return { ok: false, code: 'BAD_INPUT', message: 'Klasör bulunamadı.' };
  const v = validateTask(task);
  if (!v.ok) return { ok: false, code: 'BAD_INPUT', message: v.message };

  const args = ['--bg'];
  if (v.task) args.push(v.task);
  const r = await deps.exec(deps.cli.path, args, { timeoutMs: 30_000, env: deps.cli.env, cwd: dir });
  const id = parseBackgrounded(`${r.stdout}\n${r.stderr}`);
  if (!id) {
    console.warn(`[terminal] claude --bg kimlik döndürmedi (kod ${String(r.code)})`);
    return { ok: false, code: 'INTERNAL', message: 'Session başlatıldı mı doğrulanamadı; listeyi yenileyin.' };
  }
  return { ok: true, bgId: id };
}
