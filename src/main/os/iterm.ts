// iTerm2 / Terminal.app sekmesine odaklanma — 04/01.
// Script'ler sabit; tty yalnızca argv ile geçer ve önce regex ile doğrulanır.
import { terminalAppAccusative, terminalAppName } from '@shared/terminalApp';
import type { TerminalApp, TerminalRef } from '@shared/types';
import { defineScript, runAppleScript, type AppleScriptResult, type AppleScriptSource } from './applescript';

export const SCRIPTS = {
  ITERM_FOCUS: defineScript(`on run argv
  set targetTty to item 1 of argv
  if application "iTerm2" is not running then return "not-running"
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is targetTty then
            select w
            tell t to select
            tell s to select
            activate
            return "found"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "not-found"
end run`),
  TERMINAL_FOCUS: defineScript(`on run argv
  set targetTty to item 1 of argv
  if application "Terminal" is not running then return "not-running"
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is targetTty then
          set selected tab of w to t
          set index of w to 1
          activate
          return "found"
        end if
      end repeat
    end repeat
  end tell
  return "not-found"
end run`),
} as const;

export type FocusFailure = 'no-tty' | 'not-running' | 'not-found' | 'permission' | 'timeout' | 'error' | 'unsupported' | 'busy';
export type FocusResult = { ok: true; app: TerminalApp } | { ok: false; reason: FocusFailure; app?: TerminalApp; message?: string };

const TTY_RE = /^\/dev\/ttys?\d{1,4}$/;

export function isValidTty(tty: string): boolean {
  return TTY_RE.test(tty);
}

export type ScriptRunner = (script: AppleScriptSource, args: string[]) => Promise<AppleScriptResult>;

export interface FocuserOptions {
  run?: ScriptRunner;
  platform?: NodeJS.Platform;
}

type Attempt = { app: 'iterm2' | 'terminal'; script: AppleScriptSource };

function attemptsFor(app: TerminalApp): Attempt[] {
  const iterm: Attempt = { app: 'iterm2', script: SCRIPTS.ITERM_FOCUS };
  const term: Attempt = { app: 'terminal', script: SCRIPTS.TERMINAL_FOCUS };
  if (app === 'iterm2') return [iterm];
  if (app === 'terminal') return [term];
  return [iterm, term]; // other/unknown: hook kaynaklı tty'de uygulama bilinmeyebilir
}

/**
 * Aynı anda tek osascript: çalışan bir çağrı varken en fazla bir istek bekler, fazlası `busy` ile düşer
 * (kısayola art arda basıldığında süreç yığılmasın). Bekleyen istek en son gelenle değiştirilir.
 */
export class TerminalFocuser {
  private readonly run: ScriptRunner;
  private readonly platform: NodeJS.Platform;
  private active: Promise<FocusResult> | null = null;
  private pending: { ref: TerminalRef; resolve: (r: FocusResult) => void } | null = null;

  constructor(opts: FocuserOptions = {}) {
    this.run = opts.run ?? ((s, a) => runAppleScript(s, a));
    this.platform = opts.platform ?? process.platform;
  }

  focus(ref: TerminalRef): Promise<FocusResult> {
    if (!this.active) {
      this.active = this.doFocus(ref).finally(() => this.next());
      return this.active;
    }
    return new Promise((resolve) => {
      this.pending?.resolve({ ok: false, reason: 'busy' });
      this.pending = { ref, resolve };
    });
  }

  private next(): void {
    this.active = null;
    const p = this.pending;
    this.pending = null;
    if (p) void this.focus(p.ref).then(p.resolve);
  }

  private async doFocus(ref: TerminalRef): Promise<FocusResult> {
    if (this.platform !== 'darwin') return { ok: false, reason: 'unsupported' };
    if (!ref.tty || !isValidTty(ref.tty)) return { ok: false, reason: 'no-tty' };
    let last: FocusResult = { ok: false, reason: 'not-found' };
    for (const a of attemptsFor(ref.app)) {
      const r = await this.run(a.script, [ref.tty]);
      if (r.kind === 'ok') {
        if (r.stdout === 'found') return { ok: true, app: a.app };
        last = { ok: false, reason: r.stdout === 'not-running' ? 'not-running' : 'not-found', app: a.app };
        continue; // diğer terminali dene
      }
      if (r.kind === 'not-running') {
        last = { ok: false, reason: 'not-running', app: a.app };
        continue;
      }
      // İzin, zaman aşımı ve beklenmeyen hata: ikinci terminale geçmek sorunu gizler.
      return r.kind === 'error' ? { ok: false, reason: 'error', app: a.app, message: r.message } : { ok: false, reason: r.kind, app: a.app };
    }
    return last;
  }
}

/** FocusResult hatası → kullanıcıya gösterilecek Türkçe mesaj (04/01 Bölüm 7). */
export function focusErrorMessage(r: Extract<FocusResult, { ok: false }>, requested: TerminalApp): string {
  const name = terminalAppName(r.app ?? requested);
  switch (r.reason) {
    case 'no-tty':
      return 'Bu session bir terminale bağlı değil.';
    case 'not-running':
      return `${name} çalışmıyor.`;
    case 'not-found':
      return requested === 'other' ? 'Sekme bulunamadı (tmux içinde olabilir).' : 'Sekme bulunamadı; session kapanmış olabilir.';
    case 'permission': {
      const acc = terminalAppAccusative(r.app ?? requested);
      return `${acc} kontrol etme izni yok. Sistem Ayarları > Gizlilik ve Güvenlik > Otomasyon'dan DijiTerminal için ${acc} açın.`;
    }
    case 'timeout':
      return `${name} yanıt vermedi.`;
    case 'unsupported':
      return 'Sekmeye gitme yalnızca macOS\'ta çalışır.';
    case 'busy':
      return 'Önceki istek sürüyor.';
    default:
      return 'Sekmeye gidilemedi.';
  }
}
