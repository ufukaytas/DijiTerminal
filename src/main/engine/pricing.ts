// Liste fiyatları ve maliyet — 02/07.
// liste fiyatları; claude.com/pricing ile doğrulanmalı.
// Birim: $ / milyon token. UI'da "liste fiyatıyla tahmini" olarak gösterilir.
export { shortModel } from './summarize';

export interface Price {
  in: number;
  out: number;
  cr: number;
  ctx: number;
  long?: { at: number; in: number; out: number; cr: number };
}

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number };
  speed?: 'fast' | string;
}

const TABLE: Record<string, Price> = {
  'claude-fable-5-1': { in: 10, out: 50, cr: 0.25, ctx: 1e6 },
  'claude-mythos-5-1': { in: 10, out: 50, cr: 0.25, ctx: 1e6 },
  'claude-fable-5': { in: 10, out: 50, cr: 1, ctx: 1e6 },
  'claude-mythos-5': { in: 10, out: 50, cr: 1, ctx: 1e6 },
  'claude-opus-5-5': { in: 4, out: 20, cr: 0.2, ctx: 1e6 },
  'claude-opus-5': { in: 5, out: 25, cr: 0.5, ctx: 1e6 },
  'claude-opus-4': { in: 5, out: 25, cr: 0.5, ctx: 1e6 },
  'claude-sonnet-5': { in: 2, out: 10, cr: 0.2, ctx: 1e6 },
  'claude-sonnet-4': { in: 3, out: 15, cr: 0.3, ctx: 1e6 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5, cr: 0.01, ctx: 0, long: { at: 100_000, in: 0.5, out: 2.5, cr: 0.05 } },
  'claude-haiku-4-5': { in: 1, out: 5, cr: 0.1, ctx: 2e5 },
};

/** En uzun önek önce: 'claude-opus-5-5-…' 'claude-opus-5'e düşmesin. */
const PREFIXES = Object.keys(TABLE).sort((a, b) => b.length - a.length);

export const PRICES: Readonly<Record<string, Price>> = TABLE;

export function priceFor(model?: string | null): Price | null {
  if (!model) return null;
  for (const p of PREFIXES) if (model.startsWith(p)) return TABLE[p] ?? null;
  return null;
}

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

export function costOf(model: string | null | undefined, u: Usage): number {
  const p = priceFor(model);
  if (!p) return 0;
  const input = n(u.input_tokens);
  const output = n(u.output_tokens);
  const cacheRead = n(u.cache_read_input_tokens);
  const cacheWrite = n(u.cache_creation_input_tokens);
  const w1h = Math.min(cacheWrite, n(u.cache_creation?.ephemeral_1h_input_tokens));
  const w5m = cacheWrite - w1h;
  const rate = p.long && input + cacheRead + cacheWrite > p.long.at ? p.long : p;
  let cost = input * rate.in + output * rate.out + cacheRead * rate.cr + w5m * rate.in * 1.25 + w1h * rate.in * 2;
  if (u.speed === 'fast') cost *= 2;
  return cost / 1e6;
}

/** Önbellekten okunan token'ların tam fiyata göre kazandırdığı. */
export function savedOf(model: string | null | undefined, u: Usage): number {
  const p = priceFor(model);
  if (!p) return 0;
  return (n(u.cache_read_input_tokens) * (p.in - p.cr)) / 1e6;
}

/** Tablodaki context penceresi; 0 → null (UI yüzde göstermez). */
export function ctxMaxFor(model?: string | null): number | null {
  const p = priceFor(model);
  return p && p.ctx > 0 ? p.ctx : null;
}

/** Motorun usage olayından pricing Usage'ına. */
export function usageOf(ev: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  speed: 'fast' | 'standard';
}): Usage {
  return {
    input_tokens: ev.input,
    output_tokens: ev.output,
    cache_read_input_tokens: ev.cacheRead,
    cache_creation_input_tokens: ev.cacheWrite,
    cache_creation: { ephemeral_1h_input_tokens: ev.cacheWrite1h },
    speed: ev.speed,
  };
}
