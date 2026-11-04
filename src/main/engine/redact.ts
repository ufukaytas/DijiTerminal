// Etiketlerdeki sırları maskeler — 02/03. IPC'ye giden her metin bu katmandan geçer.
// Amaç UI'da ve ekran paylaşımında kazara görünürlüğü azaltmak; her sırrı yakalamak mümkün değildir.

export const REDACTED = '‹gizli›';

/** Regex DoS'u önlemek için desenlerden önce metin bu uzunluğa kırpılır. */
export const REDACT_MAX_INPUT = 2048;

const TOKEN_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /xox[abpr]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g, // JWT
];

const AUTH_HEADER = /\b(Bearer|Basic)(\s+)[A-Za-z0-9._~+/=-]{16,}/g;
// Anahtar adı kalır, değer gizlenir: API_KEY=xyz → API_KEY=‹gizli›
const KEY_VALUE = /\b(api[_-]?key|token|secret|password|passwd)\b(\s*[=:]\s*)("[^"]+"|'[^']+'|\S+)/gi;

export function redact(text: string): string {
  if (!text) return '';
  let out = text.length > REDACT_MAX_INPUT ? text.slice(0, REDACT_MAX_INPUT) : text;
  for (const re of TOKEN_PATTERNS) out = out.replace(re, REDACTED);
  out = out.replace(AUTH_HEADER, (_m, kind: string, sp: string) => `${kind}${sp}${REDACTED}`);
  out = out.replace(KEY_VALUE, (_m, key: string, sep: string) => `${key}${sep}${REDACTED}`);
  return out;
}
