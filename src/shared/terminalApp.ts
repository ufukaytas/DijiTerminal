// Session'ın terminal uygulamasının kullanıcıya gösterilen adı (iTerm2 / Terminal.app).
// Düğme etiketleri, popover ipucu ve izin mesajları buradan okunur; main ve renderer ortak kullanır.
import type { TerminalApp } from './types';

/** iTerm2 dışındaki her şey (Terminal.app, tmux içi, bilinmeyen) "Terminal". */
export function terminalAppName(app: TerminalApp | null | undefined): 'iTerm2' | 'Terminal' {
  return app === 'iterm2' ? 'iTerm2' : 'Terminal';
}

/** Belirtme hâli: "iTerm2'yi" / "Terminal'i". */
export function terminalAppAccusative(app: TerminalApp | null | undefined): string {
  return app === 'iterm2' ? "iTerm2'yi" : "Terminal'i";
}

/** "iTerm2 sekmesine git" / "Terminal sekmesine git". */
export function focusLabel(app: TerminalApp | null | undefined): string {
  return `${terminalAppName(app)} sekmesine git`;
}
