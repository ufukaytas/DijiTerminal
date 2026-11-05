// Şema özeti kuralları (09/01) — scripts/lib/schema-summary.mjs'in TS ikizi.
// Motor tanınmayan kayıtların yalnızca anahtar adlarını ve tiplerini saklar; değerler asla.
// İki kopyanın aynı davrandığı tests/shared/schemaRules.test.ts'te doğrulanır.

export function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** Kısa, enum benzeri, kimlik içermeyen dizeler aynen; geri kalan her şey `‹değer›`. */
export function enumValue(v: unknown): string {
  return typeof v === 'string' && v.length <= 40 && /^[a-z_][a-z0-9_:-]*$/i.test(v) && !/[0-9a-f]{8}/i.test(v) ? v : '‹değer›';
}

/** Kimlik taşıyan anahtar adları `‹id›` olur (toolu_…, UUID, uzun hex, uzun sayı). */
export function keyName(k: string): string {
  if (/^(toolu_|srvtoolu_|call_|msg_|req_)/.test(k)) return '‹id›';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(k)) return '‹id›';
  if (/^[0-9a-f]{12,}$/i.test(k) || /^\d{4,}$/.test(k)) return '‹id›';
  return k;
}

/**
 * Anahtar → tip kümesi (schema-summary `shape` ile aynı kural: bir seviye iç içe, `input` açılmaz).
 * `maxKeys` aşılınca yeni anahtar eklenmez (bellek sınırı).
 */
export function shapeInto(into: Map<string, Set<string>>, o: Record<string, unknown>, maxKeys = 40, prefix = '', depth = 0): void {
  for (const [k, v] of Object.entries(o)) {
    const key = prefix + keyName(k);
    let set = into.get(key);
    if (!set) {
      if (into.size >= maxKeys) continue;
      set = new Set();
      into.set(key, set);
    }
    set.add(typeOf(v));
    if (depth < 1 && v && typeof v === 'object' && !Array.isArray(v) && k !== 'input') {
      shapeInto(into, v as Record<string, unknown>, maxKeys, key + '.', depth + 1);
    }
  }
}

/** Map<anahtar, Set<tip>> → { anahtar: 'tip1|tip2' } (sıralı). */
export function shapeObject(m: Map<string, Set<string>>): Record<string, string> {
  return Object.fromEntries([...m].sort(([a], [b]) => a.localeCompare(b)).map(([k, s]) => [k, [...s].sort().join('|')]));
}
