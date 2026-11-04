#!/usr/bin/env node
// @ts-check
// İmzalı .dmg'leri notarize edip bileti dmg'ye ekler (staple). `npm run dist:signed` sonunda kendiliğinden çalışır;
// tek başına: `npm run dist:notarize-dmg`.
//
// electron-builder uygulamayı (.app) notarize eder ama dmg'yi etmez. dmg'yi `-c.dmg.sign=true` ile imzalar; bu script
// imzalı dmg'yi Apple'a gönderir, onaylanınca bileti ekler ve Gatekeeper ile doğrular.
// Kimlik bilgisi: APPLE_KEYCHAIN_PROFILE (`xcrun notarytool store-credentials <profil> …`). Tanımlı değilse atlanır.
// Staple dmg'yi değiştirdiği için electron-builder'ın .blockmap dosyası eskir; uygulamada otomatik güncelleme
// olmadığından silinir.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = path.join(root, 'release');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const profile = process.env.APPLE_KEYCHAIN_PROFILE;

/** @param {string} cmd @param {string[]} args */
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function main() {
  if (process.platform !== 'darwin') {
    console.log('notarize-dmg: yalnızca macOS — atlandı');
    return;
  }
  if (!profile) {
    console.log('notarize-dmg: APPLE_KEYCHAIN_PROFILE tanımlı değil — dmg notarization atlandı');
    return;
  }
  const dmgs = fs.existsSync(releaseDir)
    ? fs.readdirSync(releaseDir).filter((f) => f.startsWith(`DijiTerminal-${version}-`) && f.endsWith('.dmg'))
    : [];
  if (dmgs.length === 0) {
    console.error(`notarize-dmg: release/ altında ${version} sürümüne ait .dmg yok`);
    process.exit(1);
  }

  let failed = 0;
  for (const name of dmgs) {
    const file = path.join(releaseDir, name);
    console.log(`• ${name}`);
    try {
      run('codesign', ['--verify', file]);
    } catch {
      console.error('  ✗ imzasız — `-c.dmg.sign=true` ile build alın (npm run dist:signed)');
      failed++;
      continue;
    }

    console.log('  Apple\'a gönderiliyor, onay bekleniyor (birkaç dakika sürebilir)…');
    /** @type {{ id?: string, status?: string }} */
    let result;
    try {
      result = JSON.parse(
        run('xcrun', ['notarytool', 'submit', file, '--keychain-profile', profile, '--wait', '--output-format', 'json']),
      );
    } catch (e) {
      const err = /** @type {{ stdout?: string, stderr?: string }} */ (e);
      console.error(`  ✗ notarytool: ${(err.stderr || err.stdout || String(e)).trim().split('\n').slice(-2).join(' ')}`);
      failed++;
      continue;
    }
    if (result.status !== 'Accepted') {
      console.error(`  ✗ durum: ${result.status} (id ${result.id})`);
      if (result.id) {
        try {
          console.error(run('xcrun', ['notarytool', 'log', result.id, '--keychain-profile', profile]));
        } catch {
          /* log alınamazsa id yeter */
        }
      }
      failed++;
      continue;
    }
    console.log(`  ✓ notarize (id ${result.id})`);

    run('xcrun', ['stapler', 'staple', file]);
    console.log('  ✓ bilet eklendi');
    try {
      execFileSync('spctl', ['-a', '-t', 'open', '--context', 'context:primary-signature', file], { stdio: 'pipe' });
      console.log('  ✓ Gatekeeper: Notarized Developer ID');
    } catch {
      console.error('  ✗ Gatekeeper dmg\'yi reddetti');
      failed++;
    }

    const blockmap = `${file}.blockmap`;
    if (fs.existsSync(blockmap)) fs.rmSync(blockmap);
  }

  if (failed) {
    console.error(`notarize-dmg: ${failed} dmg başarısız`);
    process.exit(1);
  }
  console.log(`notarize-dmg: ${dmgs.length} dmg hazır`);
}

main();
