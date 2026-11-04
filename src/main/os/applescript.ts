// osascript köprüsü — 04/01. Script metni her zaman bu klasördeki sabitlerden gelir;
// değişken veri (tty) yalnızca `on run argv` argümanı olarak geçer. Shell kullanılmaz.
import { execFile } from 'node:child_process';

export type AppleScriptResult =
  | { kind: 'ok'; stdout: string }
  | { kind: 'permission' }
  | { kind: 'not-running' }
  | { kind: 'timeout' }
  | { kind: 'error'; message: string };

/** Marka tip: yalnızca `defineScript` ile üretilen sabit metinler çalıştırılabilir. */
export type AppleScriptSource = string & { readonly __appleScript: unique symbol };

/** Modül düzeyinde sabit script tanımı. Çalışma anında üretilmiş metinle çağrılmamalı. */
export function defineScript(source: string): AppleScriptSource {
  return source as AppleScriptSource;
}

export interface ExecResult {
  error: (Error & { code?: unknown; killed?: boolean; signal?: string | null }) | null;
  stdout: string;
  stderr: string;
}
export type OsaExec = (file: string, args: string[], timeoutMs: number) => Promise<ExecResult>;

export const OSASCRIPT = '/usr/bin/osascript';

const realExec: OsaExec = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });

/** stderr ve çıkış bilgisinden sonuç türü. */
export function classifyOsa(r: ExecResult): AppleScriptResult {
  if (!r.error) return { kind: 'ok', stdout: r.stdout.trim() };
  const err = r.error;
  if (err.killed || err.signal === 'SIGKILL' || err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT') return { kind: 'timeout' };
  const text = `${r.stderr}\n${err.message}`;
  if (/-1743\b|not authori[sz]ed to send apple events/i.test(text)) return { kind: 'permission' };
  if (/-600\b|-609\b|isn.t running|application isn't running/i.test(text)) return { kind: 'not-running' };
  return { kind: 'error', message: r.stderr.trim().slice(0, 200) || err.message.slice(0, 200) };
}

export async function runAppleScript(
  script: AppleScriptSource,
  args: string[],
  timeoutMs = 3000,
  exec: OsaExec = realExec,
): Promise<AppleScriptResult> {
  const r = await exec(OSASCRIPT, ['-e', script, ...args], timeoutMs);
  return classifyOsa(r);
}
