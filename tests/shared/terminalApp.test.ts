import { describe, expect, it } from 'vitest';
import { focusLabel, terminalAppAccusative, terminalAppName } from '@shared/terminalApp';

describe('terminal uygulama adı', () => {
  it('iTerm2 ayrı; Terminal.app, tmux içi ve bilinmeyen "Terminal"', () => {
    expect(focusLabel('iterm2')).toBe('iTerm2 sekmesine git');
    for (const app of ['terminal', 'other', 'unknown', null, undefined] as const) {
      expect(focusLabel(app)).toBe('Terminal sekmesine git');
      expect(terminalAppName(app)).toBe('Terminal');
    }
  });

  it('belirtme hâli eki', () => {
    expect(terminalAppAccusative('iterm2')).toBe("iTerm2'yi");
    expect(terminalAppAccusative('terminal')).toBe("Terminal'i");
  });
});
