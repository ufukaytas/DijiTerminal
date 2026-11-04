#!/usr/bin/env node
// @ts-check
// DijiTerminal — hook kurulum CLI'ı (Faz 1, uygulamasız)
// Kullanım:
//   node scripts/install-hooks.mjs install   [--yes] [--dry-run] [--no-statusline] [--config-dir <dir>]
//   node scripts/install-hooks.mjs uninstall [--yes] [--dry-run] [--config-dir <dir>]
//   node scripts/install-hooks.mjs status    [--config-dir <dir>]
// Çıkış kodları: 0 başarı, 1 kullanıcı iptali, 2 hata.

import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { install, uninstall, status, InstallError, resolveSettingsPath, resolveDataDir } from '../hooks/lib/installer.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = path.resolve(here, '..', 'hooks');

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

const configDir = opt('--config-dir');
const base = { configDir, sourceDir, statusLine: /** @type {'auto'|'skip'} */ (flag('--no-statusline') ? 'skip' : 'auto') };

const STATUS_LINE_TEXT = {
  none: 'yok',
  ours: 'DijiTerminal (limitler kaydediliyor)',
  chained: 'zincirlenmiş: önceki status line\'ınız korunuyor, limitler kaydediliyor',
  foreign: 'sizin (DijiTerminal dokunmadı, limitler kapalı)',
};

function printStatus(s) {
  console.log(`  Ayar dosyası : ${s.settingsPath}`);
  console.log(`  Hook'lar     : ${s.installed ? 'kurulu' : 'kurulu değil'}`);
  console.log(`  Status line  : ${STATUS_LINE_TEXT[s.statusLine]}`);
  console.log(`  Son yedek    : ${s.backupPath ?? '—'}`);
}

async function confirm(question) {
  if (flag('--yes')) return true;
  if (!process.stdin.isTTY) {
    console.error('Onay için etkileşimli terminal gerekiyor; otomatik onay için --yes kullanın.');
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} (e/H) `)).trim().toLowerCase();
  rl.close();
  return answer === 'e' || answer === 'evet' || answer === 'y' || answer === 'yes';
}

async function main() {
  if (cmd === 'status') {
    console.log('DijiTerminal hook durumu');
    printStatus(status({ configDir }));
    return 0;
  }
  if (cmd !== 'install' && cmd !== 'uninstall') {
    console.log('Kullanım: install-hooks.mjs <install|uninstall|status> [--yes] [--dry-run] [--no-statusline] [--config-dir <dir>]');
    return cmd ? 2 : 0;
  }

  const run = cmd === 'install' ? install : uninstall;
  const preview = await run({ ...base, dryRun: true });
  console.log(`DijiTerminal ${cmd === 'install' ? 'kurulum' : 'kaldırma'} planı`);
  console.log(`  Ayar dosyası : ${resolveSettingsPath({ configDir })}`);
  console.log(`  Script'ler   : ${path.join(resolveDataDir(), 'hooks')}`);
  if (preview.changes.length === 0) {
    console.log('  Değişiklik yok: zaten güncel.');
    if (cmd === 'install') await run(base); // script kopyalarını yine de tazele
    return 0;
  }
  for (const c of preview.changes) console.log(`  • ${c}`);
  if (flag('--dry-run')) return 0;
  console.log('  Değişiklikten önce mevcut settings.json yedeklenir.');
  if (!(await confirm('Devam edilsin mi?'))) {
    console.log('İptal edildi, hiçbir dosya değişmedi.');
    return 1;
  }

  const result = await run(base);
  console.log(cmd === 'install'
    ? `\n${result.changes.length} değişiklik uygulandı.`
    : `\n${result.changes.length} kayıt kaldırıldı.`);
  printStatus(result.status);
  console.log('\nAçık Claude Code session\'larının hook değişikliğini görmesi için yeniden başlatılması gerekir.');
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    if (e instanceof InstallError) console.error(`Hata (${e.code}): ${e.message}`);
    else console.error(`Beklenmeyen hata: ${e?.stack ?? e}`);
    process.exit(2);
  },
);
