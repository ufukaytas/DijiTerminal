// 09/01 şema golden kapsaması: en yeni fixtures/compat/schema-<sürüm>.json'daki her transcript kayıt tipi
// ya işlenir (HANDLED_TYPES) ya da bilinçli olarak yok sayılır (IGNORED_TYPES, prefilter SKIP_TYPES).
// Yeni bir Claude Code sürümünden sonra `npm run compat:snapshot` bu testi kırarsa: tipi incele, handler yaz
// ya da IGNORED_TYPES'a ekle; registry'de yeni anahtar → KNOWN_REGISTRY_KEYS.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HANDLED_TYPES, IGNORED_TYPES } from '@main/engine/normalize';
import { KNOWN_REGISTRY_KEYS } from '@main/engine/registry';
import { SKIP_TYPES } from '@main/engine/transcript/prefilter';
import { COMPAT, buildIssueUrl, compareVersions, type CompatReport } from '@shared/compat';

const DIR = path.resolve(__dirname, '..', '..', 'fixtures', 'compat');

interface SchemaGolden {
  claudeVersion: string;
  registry: { keys: Record<string, string> };
  transcripts: { recordTypes: Record<string, number> };
}

function goldens(): { version: string; file: string }[] {
  return fs
    .readdirSync(DIR)
    .map((f) => /^schema-(\d+\.\d+\.\d+)\.json$/.exec(f))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ version: m[1] as string, file: path.join(DIR, m[0]) }))
    .sort((a, b) => compareVersions(a.version, b.version));
}

const latest = goldens().at(-1);

describe('compat kapsaması', () => {
  it('en az bir şema golden\'ı var ve COMPAT.testedMax ile eşleşiyor', () => {
    expect(latest).toBeDefined();
    expect(latest?.version).toBe(COMPAT.testedMax);
  });

  it('her transcript kayıt tipi işleniyor ya da bilinçli olarak yok sayılıyor', () => {
    const g = JSON.parse(fs.readFileSync((latest as { file: string }).file, 'utf8')) as SchemaGolden;
    const known = new Set<string>([...HANDLED_TYPES, ...IGNORED_TYPES, ...SKIP_TYPES]);
    const types = Object.keys(g.transcripts.recordTypes)
      .map((t) => t.split('/')[0] as string)
      .filter((t) => t !== '‹değer›');
    const missing = [...new Set(types)].filter((t) => !known.has(t)).sort();
    expect(missing, `Claude Code ${g.claudeVersion}: tanınmayan kayıt tipleri`).toEqual([]);
  });

  it('her registry anahtarı biliniyor', () => {
    const g = JSON.parse(fs.readFileSync((latest as { file: string }).file, 'utf8')) as SchemaGolden;
    const top = [...new Set(Object.keys(g.registry.keys).map((k) => k.split('.')[0] as string))];
    const missing = top.filter((k) => !KNOWN_REGISTRY_KEYS.has(k)).sort();
    expect(missing, `Claude Code ${g.claudeVersion}: bilinmeyen registry anahtarları`).toEqual([]);
  });

  it('README "Tested with" satırı COMPAT ile aynı', () => {
    const readme = fs.readFileSync(path.resolve(__dirname, '..', '..', 'README.md'), 'utf8');
    expect(readme).toContain(`Tested with Claude Code ${COMPAT.testedMin}–${COMPAT.testedMax}`);
  });
});

describe('issue şablonu (.github/ISSUE_TEMPLATE)', () => {
  // GitHub issue formları `body` parametresini yok sayar ve bilinmeyen alan kimliklerini sessizce atar:
  // URL'deki her alan parametresi formda aynı kimlikle bulunmalı, yoksa rapor issue'ya hiç taşınmaz.
  const report: CompatReport = {
    level: 'warn',
    claudeVersion: '2.1.340',
    testedMin: COMPAT.testedMin,
    testedMax: COMPAT.testedMax,
    untestedVersion: true,
    signals: [{ id: 'unknownRecordTypes', level: 'warn', count: 60, detail: { 'future-record': 60 } }],
    since: 0,
    at: 0,
    records: 100,
  };
  const url = new URL(buildIssueUrl(report, { appVersion: '0.2.0', osVersion: 'macOS 15 (arm64)' }).url);
  const template = url.searchParams.get('template') ?? '';
  const file = path.resolve(__dirname, '..', '..', '.github', 'ISSUE_TEMPLATE', template);

  it('URL\'nin işaret ettiği şablon dosyası var; üst düzey alanlar tam', () => {
    expect(template).toMatch(/\.ya?ml$/);
    expect(fs.existsSync(file)).toBe(true);
    const yml = fs.readFileSync(file, 'utf8');
    for (const key of ['name', 'description', 'body']) expect(yml).toMatch(new RegExp(`^${key}:`, 'm'));
  });

  it('URL alan parametreleri formdaki kimliklerle birebir; kimlikler tekil; rapor alanı kod bloğu değil', () => {
    const yml = fs.readFileSync(file, 'utf8');
    const ids = [...yml.matchAll(/^\s+id:\s*([\w-]+)\s*$/gm)].map((m) => m[1] as string);
    expect(new Set(ids).size).toBe(ids.length);
    const fields = [...url.searchParams.keys()].filter((k) => k !== 'template' && k !== 'title' && k !== 'labels');
    expect(fields.sort()).toEqual(['app-version', 'claude-version', 'report']);
    for (const f of fields) expect(ids, `şablonda "${f}" alanı yok`).toContain(f);
    expect(url.searchParams.get('report')).toContain('future-record');
    // `render:` alanı kod bloğuna çevirir; rapor Markdown tablo olarak okunabilsin.
    const reportBlock = yml.slice(yml.indexOf('id: report'), yml.indexOf('id: observed'));
    expect(reportBlock).not.toMatch(/render:/);
  });
});
