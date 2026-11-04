// Araç çağrıları ve model adları için kısa, UI'a hazır etiketler — 02/03.
import { redact, REDACT_MAX_INPUT } from './redact';

export const LABEL_MAX = 160;
const BASH_LABEL_MAX = 80;
/** tool-start.command alanı da IPC'ye gidebilir: redakte edilir ve bu uzunluğa kırpılır. */
const COMMAND_MAX = 2000;

/** Normal boşluk dışında bir boşluk karakteri ya da yan yana iki boşluk: yalnızca o zaman değiştirmek gerekir. */
const NEEDS_COLLAPSE = /[^\S ]| {2}/;
const collapse = (s: string): string => (NEEDS_COLLAPSE.test(s) ? s.replace(/\s+/g, ' ') : s).trim();

/**
 * Boşlukları teke indirir; n'den uzunsa n-1 karakter + '…'.
 * Uzun metinde (açılışta on binlerce kayıt) tamamını değil, sonucu belirleyecek kadar önünü işler:
 * collapse(önek) her zaman collapse(tam)'ın bir önekidir, o yüzden önek n'i aşıyorsa sonuç aynıdır.
 */
export function clip(s: string | undefined | null, n: number): string {
  if (s === undefined || s === null) return '';
  const str = String(s);
  for (let w = n * 2 + 32; w < str.length; w *= 4) {
    const flat = collapse(str.slice(0, w));
    if (flat.length > n) return `${flat.slice(0, Math.max(0, n - 1))}…`;
  }
  const flat = collapse(str);
  return flat.length > n ? `${flat.slice(0, Math.max(0, n - 1))}…` : flat;
}

/**
 * Pencerenin sonundaki yarım bir sır deseni (en uzun önek ~31 karakter) görünen kısmı etkilemesin diye
 * pencere sonucu ancak bu kadar fazlalıkla kabul edilir.
 */
const SAFE_MARGIN = 48;

/**
 * Redakte et + kırp: `clip(redact(s.slice(0, REDACT_MAX_INPUT)), n)` ile aynı sonucu, metnin yalnızca
 * görünecek kısmını işleyerek üretir (redakte etme metni yalnızca kısaltır; pencere sonucu n + SAFE_MARGIN'i
 * aşıyorsa pencerenin dışındaki hiçbir eşleşme ilk n karaktere dokunamaz).
 */
export function safeText(s: string, n: number): string {
  const max = Math.min(s.length, REDACT_MAX_INPUT);
  for (let w = n * 2 + 64; w < max; w *= 4) {
    const flat = collapse(redact(s.slice(0, w)));
    if (flat.length > n + SAFE_MARGIN) return `${flat.slice(0, Math.max(0, n - 1))}…`;
  }
  return clip(redact(s.slice(0, REDACT_MAX_INPUT)), n);
}

/** Önce kırp (regex DoS), sonra redakte et, sonra son uzunluğa indir. */
function safeLabel(s: string, n = LABEL_MAX): string {
  return safeText(s, n);
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** '/Users/x/proj/src/editor/ThemePreview.tsx' → 'editor/ThemePreview.tsx' */
function shortPath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts.slice(-2).join('/') || p;
}

const FILE_TOOLS = new Set(['Read', 'NotebookRead', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

export function summarizeTool(name: string, input: unknown): { label: string; file?: string; command?: string } {
  const i = obj(input);

  if (FILE_TOOLS.has(name)) {
    const file = str(i.file_path) ?? str(i.notebook_path);
    return file ? { label: safeLabel(shortPath(file)), file } : { label: name };
  }

  switch (name) {
    case 'Bash': {
      const command = str(i.command);
      if (!command) return { label: name };
      const lines = command.split('\n');
      const first = lines[0] ?? '';
      const multi = lines.slice(1).some((l) => l.trim().length > 0);
      const head = clip(redact(first.slice(0, REDACT_MAX_INPUT)), BASH_LABEL_MAX);
      return {
        label: clip(multi ? `${head} …` : head, LABEL_MAX),
        command: redact(command.slice(0, REDACT_MAX_INPUT)).slice(0, COMMAND_MAX),
      };
    }
    case 'Grep': {
      const pattern = str(i.pattern);
      if (!pattern) return { label: name };
      const where = str(i.path) ?? str(i.glob) ?? '';
      return { label: safeLabel(`"${pattern}" ${where}`.trim()) };
    }
    case 'Glob':
      return { label: str(i.pattern) ? safeLabel(String(i.pattern)) : name };
    case 'WebSearch':
      return { label: str(i.query) ? safeLabel(`"${String(i.query)}"`) : name };
    case 'WebFetch': {
      const url = str(i.url);
      if (!url) return { label: name };
      try {
        const u = new URL(url);
        return { label: safeLabel(`${u.host}${u.pathname === '/' ? '' : u.pathname}`) };
      } catch {
        return { label: safeLabel(url.split('?')[0] ?? url) };
      }
    }
    case 'Agent':
    case 'Task': {
      const d = str(i.description) ?? str(i.subagent_type);
      return { label: d ? safeLabel(d) : name };
    }
    case 'TodoWrite': {
      const todos = Array.isArray(i.todos) ? i.todos.length : 0;
      return { label: `${todos} görev` };
    }
  }

  if (name.startsWith('mcp__')) {
    const [, server, ...rest] = name.split('__');
    if (server && rest.length > 0) return { label: safeLabel(`${server} · ${rest.join('__')}`) };
  }
  return { label: safeLabel(name) || name };
}

/** 'claude-opus-5-5-20260601' → 'opus 5.5'; 'claude-sonnet-5' → 'sonnet 5'. */
export function shortModel(model: string | undefined | null): string {
  if (!model) return '';
  return model
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
    .replace(/^([a-z]+)-(\d+)-(\d+)$/, '$1 $2.$3')
    .replace(/^([a-z]+)-(\d+)$/, '$1 $2');
}

/** 41984 → '41 KB', 1258291 → '1.2 MB'. */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
