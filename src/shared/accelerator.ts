// Electron accelerator yardımcıları (04/03). Saf; main ve renderer kullanır.

const MOD = '(?:Command|Cmd|Control|Ctrl|Alt|Option|Shift|CommandOrControl|CmdOrCtrl)';
const KEY = '(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4]))';
/** En az bir değiştirici + tek tuş: 'Control+Alt+W', 'Command+Shift+F5'. */
const ACCEL_RE = new RegExp(`^${MOD}(?:\\+${MOD})*\\+${KEY}$`);
/** Yalnızca değiştiriciler (session kısayolu öneki): 'Control+Alt'. */
const PREFIX_RE = new RegExp(`^${MOD}(?:\\+${MOD})*$`);

export function isValidAccelerator(acc: string): boolean {
  return typeof acc === 'string' && acc.length <= 40 && ACCEL_RE.test(acc);
}

export function isValidPrefix(prefix: string): boolean {
  return typeof prefix === 'string' && prefix.length <= 40 && PREFIX_RE.test(prefix);
}

const SYMBOL: Record<string, string> = {
  Control: '⌃',
  Ctrl: '⌃',
  Alt: '⌥',
  Option: '⌥',
  Shift: '⇧',
  Command: '⌘',
  Cmd: '⌘',
  CommandOrControl: '⌘',
  CmdOrCtrl: '⌘',
};
/** macOS menülerindeki sıra: ⌃⌥⇧⌘. */
const ORDER = ['⌃', '⌥', '⇧', '⌘'];

/** 'Control+Alt+3' → '⌃⌥3'; 'Control+Alt' → '⌃⌥'. Tanınmayan parça olduğu gibi kalır. */
export function formatAccelerator(acc: string): string {
  const parts = acc.split('+').filter(Boolean);
  const mods: string[] = [];
  const keys: string[] = [];
  for (const p of parts) {
    const s = SYMBOL[p];
    if (s) {
      if (!mods.includes(s)) mods.push(s);
    } else keys.push(p);
  }
  mods.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  return mods.join('') + keys.join('+');
}

/** Session N kısayolu: önek + rakam. */
export function sessionAccelerator(prefix: string, n: number): string {
  return `${prefix}+${n}`;
}

/** Ayarlardaki hazır setler. ⌘ seti iTerm2'nin ⌘⌥1–9 ve ⌘⇧D kısayollarını ezer (04/03 Bölüm 4). */
export const SHORTCUT_PRESETS = {
  default: { focusWaiting: 'Control+Alt+W', toggleBoard: 'Control+Alt+D', sessionPrefix: 'Control+Alt' },
  command: { focusWaiting: 'Command+Shift+W', toggleBoard: 'Command+Shift+D', sessionPrefix: 'Command+Alt' },
} as const;

/**
 * Klavye olayından accelerator üretir (ayarlardaki "kısayolu kaydet" alanı).
 * Değiştirici yoksa ya da tuş harf/rakam/F tuşu değilse null.
 */
export function acceleratorFromKey(e: { key: string; code?: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): string | null {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Command');
  if (mods.length === 0) return null;
  // ⌥ basılıyken e.key özel karakter olur (⌥W → ∑); fiziksel tuş için code kullan.
  let key: string | null = null;
  const code = e.code ?? '';
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) key = code;
  else if (/^[a-z0-9]$/i.test(e.key)) key = e.key.toUpperCase();
  if (!key) return null;
  const acc = [...mods, key].join('+');
  return isValidAccelerator(acc) ? acc : null;
}
