// 04/01 — sekmeye gitme: tty doğrulama, script seçimi, hata sınıflandırma, kuyruk, IPC handler.
// osascript çalıştırılmaz; runner/exec sahtedir.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TerminalRef } from '@shared/types';
import { classifyOsa, runAppleScript, OSASCRIPT, type AppleScriptResult, type ExecResult } from '@main/os/applescript';
import { focusErrorMessage, isValidTty, SCRIPTS, TerminalFocuser, type ScriptRunner } from '@main/os/iterm';
import { createTerminalHandlers, createToastActionHandlers, TOAST_ACTION_URLS } from '@main/handlers';

const SID = 'aaaaaaaa-0000-4000-8000-000000000001';
const ref = (app: TerminalRef['app'], tty: string | null = '/dev/ttys004'): TerminalRef => ({ app, tty, pid: 703 });

function runner(answers: AppleScriptResult[]) {
  const calls: { script: string; args: string[] }[] = [];
  const run: ScriptRunner = async (script, args) => {
    calls.push({ script, args });
    return answers.shift() ?? { kind: 'ok', stdout: 'not-found' };
  };
  return { run, calls };
}

describe('isValidTty', () => {
  it('yalnızca /dev/ttysNNN', () => {
    expect(isValidTty('/dev/ttys004')).toBe(true);
    expect(isValidTty('/dev/tty1')).toBe(true);
    for (const bad of ['ttys004', '/dev/ttys', '/dev/ttys00412', '/dev/ttys004" & do shell script "x', '/dev/pts/1', '']) {
      expect(isValidTty(bad)).toBe(false);
    }
  });
});

describe('script metinleri', () => {
  it('sabit: birleştirme, şablon değişkeni yok; tty argv ile alınır', () => {
    for (const s of Object.values(SCRIPTS)) {
      expect(s).toContain('on run argv');
      expect(s).toContain('item 1 of argv');
      expect(s).not.toMatch(/\$\{/);
    }
    const src = fs.readFileSync(path.resolve(__dirname, '../../../src/main/os/iterm.ts'), 'utf8');
    const block = src.slice(src.indexOf('export const SCRIPTS'), src.indexOf('} as const;'));
    expect(block).not.toMatch(/\$\{|`\s*\+|\+\s*`/);
  });
});

describe('TerminalFocuser', () => {
  it('iterm2 → yalnızca iTerm2 script\'i, tty argv olarak', async () => {
    const { run, calls } = runner([{ kind: 'ok', stdout: 'found' }]);
    const r = await new TerminalFocuser({ run, platform: 'darwin' }).focus(ref('iterm2'));
    expect(r).toEqual({ ok: true, app: 'iterm2' });
    expect(calls).toEqual([{ script: SCRIPTS.ITERM_FOCUS, args: ['/dev/ttys004'] }]);
  });

  it('terminal → Terminal script\'i', async () => {
    const { run, calls } = runner([{ kind: 'ok', stdout: 'found' }]);
    expect(await new TerminalFocuser({ run, platform: 'darwin' }).focus(ref('terminal'))).toEqual({ ok: true, app: 'terminal' });
    expect(calls[0]?.script).toBe(SCRIPTS.TERMINAL_FOCUS);
  });

  it('other/unknown → önce iTerm2, bulunamazsa Terminal', async () => {
    const { run, calls } = runner([{ kind: 'ok', stdout: 'not-found' }, { kind: 'ok', stdout: 'found' }]);
    expect(await new TerminalFocuser({ run, platform: 'darwin' }).focus(ref('other'))).toEqual({ ok: true, app: 'terminal' });
    expect(calls.map((c) => c.script)).toEqual([SCRIPTS.ITERM_FOCUS, SCRIPTS.TERMINAL_FOCUS]);
  });

  it('izin reddi Terminal\'e düşmez; sonuç permission', async () => {
    const { run, calls } = runner([{ kind: 'permission' }]);
    expect(await new TerminalFocuser({ run, platform: 'darwin' }).focus(ref('unknown'))).toEqual({ ok: false, reason: 'permission', app: 'iterm2' });
    expect(calls).toHaveLength(1);
  });

  it('iTerm2 kapalı → not-running', async () => {
    const { run } = runner([{ kind: 'ok', stdout: 'not-running' }]);
    expect(await new TerminalFocuser({ run, platform: 'darwin' }).focus(ref('iterm2'))).toMatchObject({ ok: false, reason: 'not-running' });
  });

  it('tty yok/geçersiz → script çalışmaz', async () => {
    const { run, calls } = runner([]);
    const f = new TerminalFocuser({ run, platform: 'darwin' });
    expect(await f.focus(ref('iterm2', null))).toEqual({ ok: false, reason: 'no-tty' });
    expect(await f.focus(ref('iterm2', '/dev/ttys004; rm -rf /'))).toEqual({ ok: false, reason: 'no-tty' });
    expect(calls).toEqual([]);
  });

  it('macOS dışında unsupported', async () => {
    const { run, calls } = runner([]);
    expect(await new TerminalFocuser({ run, platform: 'linux' }).focus(ref('iterm2'))).toEqual({ ok: false, reason: 'unsupported' });
    expect(calls).toEqual([]);
  });

  it('kuyruk: çalışan çağrı varken en fazla bir bekleyen; fazlası busy', async () => {
    let release: (() => void) | null = null;
    const calls: string[] = [];
    const run: ScriptRunner = async (_s, args) => {
      calls.push(args[0] ?? '');
      if (calls.length === 1) await new Promise<void>((r) => (release = r));
      return { kind: 'ok', stdout: 'found' };
    };
    const f = new TerminalFocuser({ run, platform: 'darwin' });
    const p1 = f.focus(ref('iterm2', '/dev/ttys001'));
    const p2 = f.focus(ref('iterm2', '/dev/ttys002'));
    const p3 = f.focus(ref('iterm2', '/dev/ttys003'));
    await new Promise((r) => setTimeout(r, 0));
    release!();
    expect(await p1).toEqual({ ok: true, app: 'iterm2' });
    expect(await p2).toEqual({ ok: false, reason: 'busy' });
    expect(await p3).toEqual({ ok: true, app: 'iterm2' });
    expect(calls).toEqual(['/dev/ttys001', '/dev/ttys003']);
  });
});

describe('osascript sonuç sınıflandırma', () => {
  const err = (msg: string, extra: object = {}): ExecResult => ({ error: Object.assign(new Error(msg), extra), stdout: '', stderr: msg });
  it('başarı, izin, çalışmıyor, zaman aşımı, diğer', () => {
    expect(classifyOsa({ error: null, stdout: 'found\n', stderr: '' })).toEqual({ kind: 'ok', stdout: 'found' });
    expect(classifyOsa(err('execution error: Not authorized to send Apple events to iTerm2. (-1743)'))).toEqual({ kind: 'permission' });
    expect(classifyOsa(err("execution error: iTerm2 got an error: Application isn't running. (-600)"))).toEqual({ kind: 'not-running' });
    expect(classifyOsa(err('', { killed: true, signal: 'SIGKILL' }))).toEqual({ kind: 'timeout' });
    expect(classifyOsa(err('syntax error (-2741)'))).toMatchObject({ kind: 'error' });
  });

  it('runAppleScript: osascript\'e -e script + argv, shell yok', async () => {
    const seen: unknown[] = [];
    const r = await runAppleScript(SCRIPTS.ITERM_FOCUS, ['/dev/ttys004'], 3000, async (file, args, t) => {
      seen.push(file, args, t);
      return { error: null, stdout: 'found', stderr: '' };
    });
    expect(r).toEqual({ kind: 'ok', stdout: 'found' });
    expect(seen).toEqual([OSASCRIPT, ['-e', SCRIPTS.ITERM_FOCUS, '/dev/ttys004'], 3000]);
  });
});

describe('action:focusTerminal handler', () => {
  function make(terminal: TerminalRef | null | undefined, result: Awaited<ReturnType<TerminalFocuser['focus']>> = { ok: true, app: 'iterm2' }) {
    const denied: string[] = [];
    const focused: TerminalRef[] = [];
    const h = createTerminalHandlers({
      terminalOf: () => terminal,
      focus: async (r) => {
        focused.push(r);
        return result;
      },
      onPermissionDenied: (app) => denied.push(app),
    })['action:focusTerminal'];
    return { h, denied, focused };
  }

  it('girdi doğrulama ve session/terminal yok', async () => {
    expect(await make(ref('iterm2')).h('../etc' as string)).toMatchObject({ ok: false, error: { code: 'BAD_INPUT' } });
    expect(await make(undefined).h(SID)).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'Session artık çalışmıyor.' } });
    expect(await make(null).h(SID)).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'Bu session bir terminale bağlı değil.' } });
  });

  it('başarı; terminal bilgisi renderer\'dan değil store\'dan', async () => {
    const m = make(ref('iterm2'));
    expect(await m.h(SID)).toEqual({ ok: true, data: { app: 'iterm2' } });
    expect(m.focused).toEqual([ref('iterm2')]);
  });

  it('hata eşlemesi ve izin reddi bildirimi', async () => {
    const m = make(ref('iterm2'), { ok: false, reason: 'permission', app: 'iterm2' });
    const r = await m.h(SID);
    expect(r).toMatchObject({ ok: false, error: { code: 'PERMISSION' } });
    expect(m.denied).toEqual(['iterm2']);
    expect(await make(ref('iterm2'), { ok: false, reason: 'not-running', app: 'iterm2' }).h(SID)).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'iTerm2 çalışmıyor.' },
    });
    expect(await make(ref('iterm2'), { ok: false, reason: 'timeout', app: 'iterm2' }).h(SID)).toMatchObject({ error: { message: 'iTerm2 yanıt vermedi.' } });
  });

  it('mesajlar', () => {
    expect(focusErrorMessage({ ok: false, reason: 'not-found' }, 'other')).toBe('Sekme bulunamadı (tmux içinde olabilir).');
    expect(focusErrorMessage({ ok: false, reason: 'permission', app: 'terminal' }, 'terminal')).toContain("Terminal'i kontrol etme izni yok");
  });
});

describe('app:toastAction handler', () => {
  it('yalnızca bilinen eylem kimlikleri; adres main\'de sabit', async () => {
    const opened: string[] = [];
    const h = createToastActionHandlers({ openExternal: async (u) => void opened.push(u) })['app:toastAction'];
    expect(await h('open-automation-settings')).toEqual({ ok: true, data: null });
    expect(await h('https://evil.example' as never)).toMatchObject({ ok: false, error: { code: 'BAD_INPUT' } });
    expect(opened).toEqual([TOAST_ACTION_URLS['open-automation-settings']]);
  });
});
