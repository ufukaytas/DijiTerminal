// Parse öncesi byte düzeyinde ön-filtre — 02/02.
// UI'da kullanılmayan büyük kayıt tiplerini JSON.parse'a hiç sokmaz; base64 görselleri kırpar.

export const SKIP_TYPES = ['attachment', 'file-history-snapshot', 'progress', 'queue-operation', 'permission-mode'] as const;

const TYPE_KEY = Buffer.from('"type":"');
/** `"type":"` sonrasında aranacak değerler, kapanış tırnağıyla birlikte (ör. `progress"`). */
const SKIP_VALUES = SKIP_TYPES.map((t) => Buffer.from(`${t}"`));
const HEAD_BYTES = 600;
const LARGE_LINE = 32 * 1024;
const MAX_DATA = 1024;
const DATA_KEY = Buffer.from('"data":"');
const QUOTE = 0x22;

/** Satırın ilk 600 byte'ında atlanacak bir tip geçiyorsa true. */
export function shouldSkip(line: Buffer): boolean {
  // Her tip için ayrı tarama yerine `"type":"` geçişlerini (çoğu satırda 1–3) bulup ardından gelen değere bakar:
  // `"type":"progress"` iğnesinin geçmesiyle birebir aynı koşul, beş kat daha az tarama.
  const head = line.length > HEAD_BYTES ? line.subarray(0, HEAD_BYTES) : line;
  const end = head.length;
  let at = head.indexOf(TYPE_KEY);
  while (at !== -1) {
    const v = at + TYPE_KEY.length;
    for (const val of SKIP_VALUES) {
      if (v + val.length <= end && head.compare(val, 0, val.length, v, v + val.length) === 0) return true;
    }
    at = head.indexOf(TYPE_KEY, v);
  }
  return false;
}

/**
 * 32 KB'tan uzun satırlarda `"data":"…"` değerlerinden 1024 byte'ı aşanları boş string yapar.
 * Ekran görüntüleri base64 olarak burada durur; parse maliyetini ve belleği korur.
 * Base64'te kaçışlı tırnak olmaz, bu yüzden kapanış için ilk `"` yeterlidir.
 */
export function stripLargeData(line: Buffer): Buffer {
  if (line.length <= LARGE_LINE) return line;
  const parts: Buffer[] = [];
  let from = 0;
  for (;;) {
    const hit = line.indexOf(DATA_KEY, from);
    if (hit === -1) break;
    const open = hit + DATA_KEY.length;
    let close = line.indexOf(QUOTE, open);
    if (close === -1) close = line.length;
    if (close - open > MAX_DATA) {
      parts.push(line.subarray(from, open)); // ...,"data":"
      from = close; // kapanış tırnağından devam
    } else {
      parts.push(line.subarray(from, close));
      from = close;
    }
    if (close >= line.length) break;
  }
  if (parts.length === 0) return line;
  parts.push(line.subarray(from));
  return Buffer.concat(parts);
}
