// Büyük transcript'lerde günün başına binary search — 02/02.
import fs from 'node:fs';

const PROBE_READ = 2 * 1024 * 1024;
const PROBE_TEXT = 256 * 1024;
const STOP_GAP = 1024 * 1024;
const MAX_ITER = 32;
const TS_RE = /"timestamp":"(\d{4}-\d\d-\d\dT[^"]+)"/;

/** offset'ten sonraki ilk tam satırdaki zaman damgası (ms); bulunamazsa null. */
async function probe(fh: fs.promises.FileHandle, pos: number, size: number): Promise<number | null> {
  const len = Math.min(PROBE_READ, size - pos);
  if (len <= 0) return null;
  const buf = Buffer.allocUnsafe(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  const data = buf.subarray(0, bytesRead);
  const nl = data.indexOf(0x0a);
  if (nl === -1) return null;
  const text = data.subarray(nl + 1, nl + 1 + PROBE_TEXT).toString('utf8');
  const m = TS_RE.exec(text);
  if (!m || !m[1]) return null;
  const t = Date.parse(m[1]);
  return Number.isFinite(t) ? t : null;
}

/**
 * Kayıtların `sinceMs`'ye ulaştığı byte offset'inin alt sınırı.
 * Dönen offset satır ortasına düşebilir: okuyucu ilk satırı atlamalıdır.
 */
export async function seekToTime(filePath: string, size: number, sinceMs: number): Promise<number> {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    let lo = 0;
    let hi = size;
    for (let i = 0; i < MAX_ITER && hi - lo > STOP_GAP; i++) {
      const mid = Math.floor((lo + hi) / 2);
      const t = await probe(fh, mid, size);
      // Zaman bulunamazsa güvenli tarafta kal: daha erken başla.
      if (t !== null && t < sinceMs) lo = mid;
      else hi = mid;
    }
    return lo;
  } finally {
    await fh.close();
  }
}
