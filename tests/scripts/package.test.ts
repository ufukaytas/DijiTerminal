// 05/03: ICNS yazıcı/okuyucu ve paket yapılandırma denetimi (Linux'ta da çalışır).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildIcns, ICNS_TYPES, readIcns } from '../../scripts/lib/icns.mjs';
import { REPO_ROOT } from './_tmp';

/** En küçük geçerli PNG başlığı + IHDR genişliği (yalnızca okuyucunun baktığı baytlar). */
function fakePng(size: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(size, 16);
  b.writeUInt32BE(size, 20);
  return b;
}

describe('icns', () => {
  it('yaz → oku: tüm tipler, uzunluklar ve genişlikler', () => {
    const pngs = new Map([16, 32, 64, 128, 256, 512, 1024].map((s) => [s, fakePng(s)]));
    const buf = buildIcns(pngs);
    const entries = readIcns(buf);
    expect(entries.map((e) => e.type)).toEqual(ICNS_TYPES.map((t) => t.type));
    expect(entries.every((e) => e.isPng && e.length === 33 + 8)).toBe(true);
    expect(entries.find((e) => e.type === 'ic10')?.width).toBe(1024);
  });

  it('eksik boyut ve PNG olmayan girdi reddedilir; bozuk dosya okunmaz', () => {
    expect(() => buildIcns(new Map([[16, fakePng(16)]]))).toThrow(/32 px/);
    const pngs = new Map([16, 32, 64, 128, 256, 512, 1024].map((s) => [s, fakePng(s)]));
    pngs.set(64, Buffer.from('değil'));
    expect(() => buildIcns(pngs)).toThrow(/PNG değil/);
    expect(() => readIcns(Buffer.from('icns\0\0\0\x20'))).toThrow();
  });

  it('repodaki build/icon.icns geçerli ve 1024 px içeriyor', () => {
    const entries = readIcns(fs.readFileSync(path.join(REPO_ROOT, 'build/icon.icns')));
    expect(entries.find((e) => e.type === 'ic10')?.width).toBe(1024);
    expect(entries.find((e) => e.type === 'icp4')?.width).toBe(16);
  });
});

describe('paket yapılandırması', () => {
  it('npm run dist:check geçer (şema + brief kuralları)', () => {
    const out = execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts/check-package-config.mjs')], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(out).toContain('şema geçerli');
    expect(out).toContain('Tamam');
  }, 30_000);
});
