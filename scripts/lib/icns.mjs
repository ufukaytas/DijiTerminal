// @ts-check
// Bağımlılıksız ICNS yazıcı/okuyucu (05/03 ikon). Yalnızca PNG gömülü ikon tipleri (macOS 10.7+):
// her kayıt = 4 bayt tip + 4 bayt uzunluk (başlık dahil, big-endian) + PNG verisi; dosya başlığı 'icns' + toplam uzunluk.

/** @type {{ type: string, size: number }[]} */
export const ICNS_TYPES = [
  { type: 'icp4', size: 16 },
  { type: 'icp5', size: 32 },
  { type: 'ic11', size: 32 }, // 16@2x
  { type: 'icp6', size: 64 },
  { type: 'ic12', size: 64 }, // 32@2x
  { type: 'ic07', size: 128 },
  { type: 'ic08', size: 256 },
  { type: 'ic13', size: 256 }, // 128@2x
  { type: 'ic09', size: 512 },
  { type: 'ic14', size: 512 }, // 256@2x
  { type: 'ic10', size: 1024 }, // 512@2x
];

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** @param {Map<number, Buffer>} pngs boyut → PNG */
export function buildIcns(pngs) {
  /** @type {Buffer[]} */
  const parts = [];
  for (const { type, size } of ICNS_TYPES) {
    const png = pngs.get(size);
    if (!png) throw new Error(`ICNS için ${size} px PNG eksik`);
    if (!png.subarray(0, 8).equals(PNG_MAGIC)) throw new Error(`${size} px girdi PNG değil`);
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(png.length + 8, 4);
    parts.push(head, png);
  }
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([header, body]);
}

/** ICNS içindekiler: [{ type, length, isPng, width }] — testler ve doğrulama için. @param {Buffer} buf */
export function readIcns(buf) {
  if (buf.toString('ascii', 0, 4) !== 'icns') throw new Error('ICNS değil');
  if (buf.readUInt32BE(4) !== buf.length) throw new Error('ICNS uzunluğu tutmuyor');
  /** @type {{ type: string, length: number, isPng: boolean, width: number | null }[]} */
  const out = [];
  for (let off = 8; off < buf.length;) {
    const type = buf.toString('ascii', off, off + 4);
    const length = buf.readUInt32BE(off + 4);
    if (length < 8 || off + length > buf.length) throw new Error(`bozuk kayıt: ${type}`);
    const data = buf.subarray(off + 8, off + length);
    const isPng = data.subarray(0, 8).equals(PNG_MAGIC);
    out.push({ type, length, isPng, width: isPng ? data.readUInt32BE(16) : null });
    off += length;
  }
  return out;
}
