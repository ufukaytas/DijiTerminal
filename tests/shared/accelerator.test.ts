// Accelerator yardımcıları (04/03).
import { describe, expect, it } from 'vitest';
import { acceleratorFromKey, formatAccelerator, isValidAccelerator, isValidPrefix, SHORTCUT_PRESETS } from '@shared/accelerator';
import { validateSettings } from '@shared/settings';

describe('accelerator', () => {
  it('formatAccelerator', () => {
    expect(formatAccelerator('Control+Alt+3')).toBe('⌃⌥3');
    expect(formatAccelerator('Command+Shift+W')).toBe('⇧⌘W');
    expect(formatAccelerator('Alt+Control')).toBe('⌃⌥');
    expect(formatAccelerator('CmdOrCtrl+F5')).toBe('⌘F5');
  });

  it('isValidAccelerator / isValidPrefix', () => {
    for (const ok of ['Control+Alt+W', 'Command+Shift+D', 'Alt+F12', 'Control+Alt+9']) expect(isValidAccelerator(ok), ok).toBe(true);
    for (const bad of ['W', 'Control+Alt', 'Control+Alt+w', 'Control+Alt+Space', 'Control++W', 'Hyper+W', 'Control+Alt+F25'])
      expect(isValidAccelerator(bad), bad).toBe(false);
    expect(isValidPrefix('Control+Alt')).toBe(true);
    expect(isValidPrefix('Control+Alt+1')).toBe(false);
    expect(isValidPrefix('')).toBe(false);
  });

  it('hazır setler geçerli', () => {
    for (const p of Object.values(SHORTCUT_PRESETS)) {
      expect(isValidAccelerator(p.focusWaiting)).toBe(true);
      expect(isValidAccelerator(p.toggleBoard)).toBe(true);
      expect(isValidPrefix(p.sessionPrefix)).toBe(true);
    }
  });

  it('acceleratorFromKey: ⌥ ile değişen e.key yerine fiziksel tuş', () => {
    const k = (key: string, code: string, m: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>>) => ({
      key,
      code,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      ...m,
    });
    expect(acceleratorFromKey(k('∑', 'KeyW', { ctrlKey: true, altKey: true }))).toBe('Control+Alt+W');
    expect(acceleratorFromKey(k('3', 'Digit3', { metaKey: true, shiftKey: true }))).toBe('Shift+Command+3');
    expect(acceleratorFromKey(k('w', 'KeyW', {}))).toBeNull();
    expect(acceleratorFromKey(k('Control', 'ControlLeft', { ctrlKey: true }))).toBeNull();
  });

  it('ayar doğrulaması: geçersiz kısayol ve önek varsayılana döner', () => {
    const r = validateSettings({ shortcuts: { focusWaiting: 'Control+Alt', sessionPrefix: 'Control+Alt+1', toggleBoard: 'Command+Shift+D' } });
    expect(r.value.shortcuts.focusWaiting).toBe('Control+Alt+W');
    expect(r.value.shortcuts.sessionPrefix).toBe('Control+Alt');
    expect(r.value.shortcuts.toggleBoard).toBe('Command+Shift+D');
    expect(r.issues).toHaveLength(2);
  });
});
