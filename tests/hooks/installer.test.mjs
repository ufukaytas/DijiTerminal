// tests/hooks/installer.test.mjs — 01/02 HookInstaller testleri (node:test, bağımlılıksız)
// Çalıştır: node --test tests/hooks/   (Sprint 1'de Vitest'e taşınacak)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  install, uninstall, status, plan, planUninstall, shellQuote, isOurs, InstallError, HOOK_EVENTS,
} from '../../hooks/lib/installer.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FX = path.join(root, 'fixtures', 'claude-settings');
const sourceDir = path.join(root, 'hooks');

function sandbox(fixture) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diji-inst-'));
  const configDir = path.join(dir, 'claude');
  const dataDir = path.join(dir, 'App Support', 'DijiTerminal'); // boşluklu yol, gerçek konum gibi
  fs.mkdirSync(configDir, { recursive: true });
  const settings = path.join(configDir, 'settings.json');
  if (fixture !== 'empty') fs.copyFileSync(path.join(FX, fixture), settings);
  return { dir, configDir, dataDir, settings, opts: { configDir, dataDir, sourceDir } };
}
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const backups = (dataDir) => {
  try { return fs.readdirSync(path.join(dataDir, 'backups')); } catch { return []; }
};

const ROUND_TRIP = ['empty', 'minimal.json', 'with-user-hooks.json', 'with-statusline.json', 'with-both.json'];

for (const fx of ROUND_TRIP) {
  test(`${fx}: kur → idempotent → kaldır → orijinal`, async () => {
    const s = sandbox(fx);
    const original = fx === 'empty' ? {} : readJson(s.settings);

    const r1 = await install(s.opts);
    assert.equal(r1.status.installed, true);
    const after1 = fs.readFileSync(s.settings);
    const json1 = readJson(s.settings);
    for (const ev of HOOK_EVENTS) {
      const ours = json1.hooks[ev].flatMap((g) => g.hooks).filter(isOurs);
      assert.equal(ours.length, 1, `${ev} için tek kayıt`);
      assert.ok(ours[0].command.startsWith("'") && ours[0].command.includes('/DijiTerminal/hooks/dijiterminal-hook.sh'));
    }
    assert.equal(json1.hooks.PreToolUse.at(-1).matcher, '*');
    assert.equal(json1.hooks.Stop.at(-1).matcher, undefined);
    assert.ok(fs.statSync(path.join(s.dataDir, 'hooks', 'dijiterminal-hook.sh')).mode & 0o100, 'script çalıştırılabilir');

    const backupsAfter1 = backups(s.dataDir).length;
    const r2 = await install(s.opts);
    assert.deepEqual(fs.readFileSync(s.settings), after1, 'ikinci kurulum dosyayı değiştirmedi');
    assert.equal(backups(s.dataDir).length, backupsAfter1, 'değişiklik yoksa yedek alınmaz');
    assert.equal(r2.status.installed, true);

    await uninstall(s.opts);
    assert.deepEqual(readJson(s.settings), original);
    assert.equal(status(s.opts).installed, false);
    assert.ok(!fs.existsSync(path.join(s.dataDir, 'statusline-chain.json')), 'zincir dosyası temizlendi');
  });
}

test('kullanıcı hook\'ları korunur ve sırası değişmez', async () => {
  const s = sandbox('with-user-hooks.json');
  await install(s.opts);
  const j = readJson(s.settings);
  assert.equal(j.hooks.Stop[0].hooks[0].command, 'afplay /System/Library/Sounds/Glass.aiff');
  assert.equal(j.hooks.PreToolUse[0].matcher, 'Bash');
  assert.equal(j.hooks.PreToolUse[0].hooks[0].command, '~/bin/guard-bash.sh');
  assert.equal(j.hooks.PreCompact.length, 1, 'kaydetmediğimiz olaya dokunulmadı');
  assert.deepEqual(Object.keys(j).slice(0, 3), ['model', 'permissions', 'hooks'], 'anahtar sırası korundu');
});

test('statusLine zincirleme: orijinal komut ve padding saklanır, kaldırınca aynen döner', async () => {
  const s = sandbox('with-statusline.json');
  const r = await install(s.opts);
  assert.equal(r.status.statusLine, 'chained');
  const chain = readJson(path.join(s.dataDir, 'statusline-chain.json'));
  assert.equal(chain.command, "~/.claude/statusline-command.sh 'with quotes'");
  assert.equal(chain.padding, 1);
  const j = readJson(s.settings);
  assert.ok(isOurs(j.statusLine));
  assert.equal(j.statusLine.padding, 1, 'görünüm için padding korunur');
  assert.equal((fs.statSync(path.join(s.dataDir, 'statusline-chain.json')).mode & 0o777), 0o600);
});

test('--no-statusline: kullanıcının statusLine\'ına dokunulmaz', async () => {
  const s = sandbox('with-statusline.json');
  const before = readJson(s.settings).statusLine;
  const r = await install({ ...s.opts, statusLine: 'skip' });
  assert.equal(r.status.statusLine, 'foreign');
  assert.deepEqual(readJson(s.settings).statusLine, before);
});

test('bozuk JSON: hiçbir dosya yazılmaz', async () => {
  const s = sandbox('invalid.json');
  const before = fs.readFileSync(s.settings);
  await assert.rejects(install(s.opts), (e) => e instanceof InstallError && e.code === 'INVALID_JSON');
  assert.deepEqual(fs.readFileSync(s.settings), before);
  assert.equal(backups(s.dataDir).length, 0);
  assert.ok(!fs.existsSync(path.join(s.dataDir, 'statusline-chain.json')));
});

test('dry-run hiçbir şey yazmaz ama değişiklikleri listeler', async () => {
  const s = sandbox('minimal.json');
  const before = fs.readFileSync(s.settings);
  const r = await install({ ...s.opts, dryRun: true });
  assert.ok(r.changes.length >= HOOK_EVENTS.length);
  assert.deepEqual(fs.readFileSync(s.settings), before);
  assert.ok(!fs.existsSync(s.dataDir));
});

test('yedekler 0600 ve en fazla 10 tane tutulur', async () => {
  const s = sandbox('minimal.json');
  for (let i = 0; i < 7; i++) { await install(s.opts); await uninstall(s.opts); }
  const list = backups(s.dataDir);
  assert.equal(list.length, 10);
  assert.equal(fs.statSync(path.join(s.dataDir, 'backups', list[0])).mode & 0o777, 0o600);
  assert.ok(status(s.opts).backupPath?.endsWith(list.sort().at(-1)));
});

test('kaynak script yoksa SOURCE_MISSING', async () => {
  const s = sandbox('minimal.json');
  await assert.rejects(install({ ...s.opts, sourceDir: path.join(s.dir, 'yok') }), (e) => e.code === 'SOURCE_MISSING');
});

test('notify.conf yoksa örnekten oluşur, varsa korunur', async () => {
  const s = sandbox('minimal.json');
  await install(s.opts);
  const conf = path.join(s.dataDir, 'notify.conf');
  assert.ok(fs.existsSync(conf));
  fs.writeFileSync(conf, 'WAITING=0\n');
  await uninstall(s.opts);
  await install(s.opts);
  assert.equal(fs.readFileSync(conf, 'utf8'), 'WAITING=0\n');
});

test('plan ve planUninstall saf fonksiyonlar: girdiyi değiştirmez', () => {
  const input = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] } };
  const copy = structuredClone(input);
  const p = plan(input, { hookCommand: "'/a/DijiTerminal/hooks/dijiterminal-hook.sh'", statusCommand: "'/a/DijiTerminal/hooks/statusline.sh'", statusLine: 'auto' });
  assert.deepEqual(input, copy);
  planUninstall(p.next, {});
  assert.deepEqual(input, copy);
});

test('hooks alanı dizi/nesne değilse INVALID_JSON', () => {
  assert.throws(() => plan({ hooks: [] }, { hookCommand: 'a', statusCommand: 'b', statusLine: 'auto' }), (e) => e.code === 'INVALID_JSON');
  assert.throws(() => plan({ hooks: { Stop: {} } }, { hookCommand: 'a', statusCommand: 'b', statusLine: 'auto' }), (e) => e.code === 'INVALID_JSON');
});

test('shellQuote tek tırnağı kaçırır', () => {
  assert.equal(shellQuote("/Users/o'neil/App Support/x.sh"), "'/Users/o'\\''neil/App Support/x.sh'");
});
