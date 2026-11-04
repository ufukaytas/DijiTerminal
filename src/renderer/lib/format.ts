// Biçimlendirme yardımcıları (03/01). Saf fonksiyonlar; tüm paneller kullanır.

const pad = (n: number) => String(n).padStart(2, '0');

/** `42s`, `4:02`, `1:03:10`. Negatif süreler 0 sayılır. */
export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  if (m > 0) return `${m}:${pad(s)}`;
  return `${s}s`;
}

/** Yerel saat, 24 saat biçimi: `14:07:09`. */
export function fmtClock(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** `$1.84`; 1 sentin altı `<$0.01`, sıfır `$0.00`. */
export function fmtCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

/** `950`, `410k`, `1.2M`. */
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 999_500) return `${Math.round(n / 1000)}k`;
  const m = (n / 1_000_000).toFixed(1);
  return `${m.endsWith('.0') ? m.slice(0, -2) : m}M`;
}

let hotkeyPrefix: string | null = '⌃⌥';

/** Ayardan (04/03): `formatAccelerator(sessionPrefix)`; kısayollar kapalıysa null → etiket gösterilmez. */
export function setHotkeyPrefix(prefix: string | null): void {
  hotkeyPrefix = prefix;
}

/** Session kısayol etiketi: `⌃⌥3`. Önek ayarlardan gelir (varsayılan ⌃⌥). */
export function fmtHotkey(n: number | null, prefix: string | null = hotkeyPrefix): string | null {
  if (prefix === null || n === null || !Number.isInteger(n) || n < 1 || n > 9) return null;
  return `${prefix}${n}`;
}

/** Ev dizinini `~` ile kısaltır: `/Users/ufuk/Projects/x` → `~/Projects/x`. */
export function tildify(path: string, home: string): string {
  if (!home) return path;
  const h = home.endsWith('/') ? home.slice(0, -1) : home;
  if (path === h) return '~';
  if (path.startsWith(h + '/')) return '~' + path.slice(h.length);
  return path;
}

/** Yolun son parçası (etiketlerde). */
export function basename(path: string): string {
  const p = path.endsWith('/') ? path.slice(0, -1) : path;
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

/** Yüzde: `%42`. */
export function fmtPct(ratio: number): string {
  return `%${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}`;
}
