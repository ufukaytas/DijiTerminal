#!/usr/bin/env node
// @ts-check
// electron-builder yapılandırmasını paketleme yapmadan doğrular (05/03). Linux/CI'da da çalışır.
//   npm run dist:check
// 1) electron-builder şeması (validateConfiguration)  2) brief kuralları: ikon, entitlement'lar, Info.plist
//    anahtarları, pakete girmemesi gereken klasörler, hooks extraResources.
// Mac'te `npm run dist:dir` sonrası `--app release/mac-arm64/DijiTerminal.app` ile paketin kendisi de denetlenir:
//    Info.plist anahtarları, hooks klasörü, asar içinde yasak klasör olmaması, codesign entitlement'ları.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readIcns } from './lib/icns.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const appArg = args.includes('--app') ? args[args.indexOf('--app') + 1] : undefined;

/** @type {string[]} */
const errors = [];
const ok = (/** @type {string} */ m) => console.log(`  ✓ ${m}`);
const fail = (/** @type {string} */ m) => {
  errors.push(m);
  console.log(`  ✗ ${m}`);
};
const check = (/** @type {boolean} */ c, /** @type {string} */ m) => (c ? ok(m) : fail(m));

const ALLOWED_ENTITLEMENTS = [
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.allow-unsigned-executable-memory',
  'com.apple.security.automation.apple-events',
];
const FORBIDDEN_IN_PACKAGE = ['fixtures', 'scripts', 'feature-briefs', 'tests', 'src', 'bench-results'];

async function checkConfig() {
  console.log('electron-builder yapılandırması');
  const { getConfig, validateConfiguration } = require('app-builder-lib/out/util/config/config');
  const { DebugLogger } = require('builder-util');
  const config = await getConfig(root, null, null);
  try {
    await validateConfiguration(config, new DebugLogger(false));
    ok('şema geçerli');
  } catch (e) {
    fail(`şema: ${e instanceof Error ? e.message.split('\n').slice(0, 6).join(' ') : e}`);
  }
  const mac = config.mac ?? {};
  check(config.appId === 'com.dijitalai.dijiterminal' && config.productName === 'DijiTerminal', 'appId / productName');
  check(
    mac.identity === '-' && mac.hardenedRuntime === false,
    'ad-hoc imza, hardened runtime kapalı (dist:signed açar)',
  );
  check(
    typeof mac.extendInfo?.NSAppleEventsUsageDescription === 'string' &&
      mac.extendInfo.NSAppleEventsUsageDescription.length > 20,
    'NSAppleEventsUsageDescription',
  );
  const targets = (mac.target ?? []).map((/** @type {any} */ t) => `${t.target}:${(t.arch ?? []).join('+')}`);
  check(targets.includes('dmg:arm64+x64'), `hedefler: ${targets.join(', ')}`);
  const files = (config.files ?? []).flatMap((/** @type {any} */ f) =>
    typeof f === 'string' ? [f] : (f.filter ?? []),
  );
  check(
    files.includes('out/**') &&
      files.includes('package.json') &&
      files.includes('!**/node_modules/**/*.map') &&
      files.filter((/** @type {string} */ f) => !f.startsWith('!')).length === 2,
    `files yalnızca out/** + package.json (${files.join(', ')})`,
  );
  check(
    (config.extraResources ?? []).some((/** @type {any} */ r) => r.from === 'hooks' && r.to === 'hooks'),
    'hooks → extraResources',
  );
  // 06/01: menü çubuğu ikonları (template image) asar dışında Resources/tray altında.
  check(
    (config.extraResources ?? []).some((/** @type {any} */ r) => r.from === 'resources/tray' && r.to === 'tray'),
    'resources/tray → extraResources (menü çubuğu ikonları)',
  );
  const trayFiles = ['Idle', 'Busy', 'Waiting'].flatMap((n) => [`tray${n}Template.png`, `tray${n}Template@2x.png`]);
  const missingTray = trayFiles.filter((f) => !fs.existsSync(path.join(root, 'resources/tray', f)));
  check(missingTray.length === 0, `menü çubuğu ikonları${missingTray.length ? ` eksik: ${missingTray.join(', ')} — npm run icon:tray` : ''}`);

  // 07/01: node-pty asar dışında; kurulu paketteki spawn-helper çalıştırılabilir (yoksa "posix_spawnp failed").
  const unpack = [config.asarUnpack ?? []].flat();
  check(unpack.some((/** @type {string} */ u) => u.includes('node-pty')), `asarUnpack: node-pty (${unpack.join(', ') || 'yok'})`);
  const helpers = ['darwin-arm64', 'darwin-x64'].map((a) => path.join(root, 'node_modules/node-pty/prebuilds', a, 'spawn-helper'));
  const notExec = helpers.filter((h) => fs.existsSync(h) && (fs.statSync(h).mode & 0o111) === 0);
  check(
    notExec.length === 0,
    `node-pty spawn-helper çalıştırılabilir${notExec.length ? ` değil: ${notExec.map((h) => path.relative(root, h)).join(', ')} — node scripts/fix-node-pty.mjs` : ''}`,
  );

  const ent = fs.readFileSync(path.join(root, mac.entitlements ?? 'build/entitlements.mac.plist'), 'utf8');
  const keys = [...ent.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]);
  check(
    JSON.stringify([...keys].sort()) === JSON.stringify([...ALLOWED_ENTITLEMENTS].sort()),
    `entitlement'lar yalnızca izinli olanlar (${keys.join(', ')})`,
  );

  const icnsPath = path.join(root, mac.icon ?? 'build/icon.icns');
  try {
    const entries = readIcns(fs.readFileSync(icnsPath));
    check(
      entries.some((e) => e.type === 'ic10' && e.width === 1024) && entries.every((e) => e.isPng),
      `ikon: ${entries.length} boyut, 1024 px dahil`,
    );
  } catch (e) {
    fail(`ikon okunamadı (${path.relative(root, icnsPath)}): ${e instanceof Error ? e.message : e} — npm run icon`);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  check(/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(pkg.version), `SemVer sürüm ${pkg.version}`);
  const changelog = fs.existsSync(path.join(root, 'CHANGELOG.md'))
    ? fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
    : '';
  check(changelog.includes(`## [${pkg.version}]`), `CHANGELOG.md'de ${pkg.version} başlığı`);
}

/** Paketlenmiş .app denetimi (yalnızca macOS). @param {string} app */
function checkApp(app) {
  console.log(`\npaket: ${app}`);
  const contents = path.join(app, 'Contents');
  const plist = JSON.parse(
    execFileSync('plutil', ['-convert', 'json', '-o', '-', path.join(contents, 'Info.plist')], { encoding: 'utf8' }),
  );
  check(plist.CFBundleIdentifier === 'com.dijitalai.dijiterminal', 'CFBundleIdentifier');
  check(plist.CFBundleName === 'DijiTerminal', 'CFBundleName (Dock ve bildirimlerde görünen ad)');
  check(typeof plist.NSAppleEventsUsageDescription === 'string', 'Info.plist NSAppleEventsUsageDescription');
  check(fs.existsSync(path.join(contents, 'Resources/hooks/dijiterminal-hook.sh')), 'Resources/hooks asar dışında');
  check(fs.existsSync(path.join(contents, 'Resources/tray/trayIdleTemplate@2x.png')), 'Resources/tray menü çubuğu ikonları');
  const helper = path.join(contents, `Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-${process.arch}/spawn-helper`);
  check(fs.existsSync(helper) && (fs.statSync(helper).mode & 0o111) !== 0, 'node-pty spawn-helper asar dışında ve çalıştırılabilir (07/01)');
  const asar = path.join(contents, 'Resources/app.asar');
  if (fs.existsSync(asar)) {
    const { listPackage } = require('@electron/asar');
    const list = /** @type {string[]} */ (listPackage(asar, { isPack: false }));
    const top = new Set(list.map((p) => p.split(/[\\/]/)[1]).filter(Boolean));
    const bad = FORBIDDEN_IN_PACKAGE.filter((d) => top.has(d));
    check(bad.length === 0, `asar içinde yasak klasör yok${bad.length ? ` (bulunan: ${bad.join(', ')})` : ''}`);
    check(!list.some((p) => p.endsWith('.map')), 'asar içinde .map yok');
  } else fail('app.asar yok');
  try {
    const out = execFileSync('codesign', ['-dv', app], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    ok(`codesign: ${out.trim().split('\n')[0] ?? 'imzalı'}`);
  } catch (e) {
    const msg = String(/** @type {any} */ (e).stderr ?? e);
    check(/Signature=adhoc|Authority=/.test(msg), `codesign ${msg.includes('adhoc') ? '(ad-hoc)' : ''}`);
  }
}

await checkConfig();
if (appArg) {
  if (process.platform !== 'darwin') fail("--app denetimi yalnızca macOS'ta çalışır");
  else checkApp(path.resolve(appArg));
}
console.log(errors.length ? `\n${errors.length} sorun` : '\nTamam');
process.exit(errors.length ? 1 : 0);
