import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { isReadableSentence, lineRules, scanPaths, validateCompatSchemas, validateScenarios } from '../../scripts/lib/check.mjs';
import { SCENARIOS } from '../../scripts/lib/scenarios.mjs';
import { REPO_ROOT, tmpDir } from './_tmp';

const rulesOf = (dir: string): string[] => scanPaths([dir]).map((f) => f.rule).sort();

function write(dir: string, rel: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
}

describe('lineRules — pozitif', () => {
  it.each([
    ['{"cwd":"/Users/alice/Projects/x"}', 'home-path'],
    ['C:\\\\Users\\\\alice\\\\x', 'home-path'],
    ['"/Users/demo-x/y"', 'home-path'],
    ['iletişim: alice@corp.io', 'email'],
    ['key sk-ant-api03-abcdefghijklmnop0123', 'secret'],
    ['ghp_abcdefghijklmnopqrstuvwx0123', 'secret'],
    ['AKIAIOSFODNN7EXAMPLE', 'secret'],
    ['xoxb-1234567890-abcdef', 'secret'],
  ])('%s → %s', (text, rule) => {
    expect(lineRules(text, null)).toContain(rule);
  });
  it('kullanıcı adı', () => {
    expect(lineRules('by ufukaytas today', /(?<![A-Za-z0-9])ufukaytas(?![A-Za-z0-9])/i)).toEqual(['username']);
  });
});

describe('lineRules — negatif', () => {
  it.each([
    '{"cwd":"/Users/demo/Projects/demo-1"}',
    '"/Users/demo"',
    'git@example.com',
    'noreply@anthropic.com',
    'bob@foo.invalid',
    'sk-ant-api03-FAKEFAKEFAKEFAKEFAKE_fake-0000',
    'ghp_FAKEFAKEFAKEFAKEFAKEFAKE00',
    'AKIAFAKEFAKEFAKE1234',
    'sk-short',
    'image@2x.png',
  ])('%s temiz', (text) => {
    expect(lineRules(text, null)).toEqual([]);
  });
  it('512 KB tek satır hızlı taranır (regex geri izleme yok)', () => {
    const t0 = Date.now();
    lineRules('"data":"' + 'A'.repeat(512 * 1024) + '"', null);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe('isReadableSentence', () => {
  it('okunabilir cümleyi yakalar, yer tutucu ve kodu yakalamaz', () => {
    expect(isReadableSentence('Bu fonksiyonu yeniden yaz ve testleri de güncelle lütfen hemen')).toBe(true);
    expect(isReadableSentence('▒'.repeat(80))).toBe(false);
    expect(isReadableSentence('const x = foo(bar, baz); return x?.y ?? z; // ok')).toBe(false);
    expect(isReadableSentence('kısa metin')).toBe(false);
  });
});

describe('scanPaths', () => {
  it('cümle kuralı yalnızca anonimleştirilmiş fixture\'larda ve metin alanlarında', () => {
    const d = tmpDir();
    const sentence = 'Kullanıcının gerçek isteği burada açıkça okunabilir biçimde duruyor demek';
    write(d, 'synthetic/manifest.json', '{"source":"synthetic"}');
    write(d, 'synthetic/a.jsonl', JSON.stringify({ message: { content: sentence } }) + '\n');
    expect(rulesOf(d)).toEqual([]);
    write(d, 'anon/manifest.json', '{"source":"anonymized"}');
    write(d, 'anon/a.jsonl', JSON.stringify({ message: { content: sentence } }) + '\n' + JSON.stringify({ model: sentence }) + '\n');
    write(d, 'anon/README.md', sentence);
    const f = scanPaths([d]);
    expect(f.map((x) => [path.basename(x.file), x.line, x.rule])).toEqual([['a.jsonl', 1, 'sentence']]);
    expect(scanPaths([path.join(d, 'synthetic')], { strictSentences: true }).map((x) => x.rule)).toEqual(['sentence']);
  });

  it('dosya adındaki kodlanmış ev dizinini yakalar; .tmp-* ve big-transcript atlanır', () => {
    const d = tmpDir();
    write(d, 'x/projects/-Users-alice-Projects-x/a.jsonl', '{}\n');
    write(d, 'x/projects/-Users-demo-Projects-demo-1/a.jsonl', '{}\n');
    write(d, '.tmp-foo-123/a.json', '"/Users/alice"');
    write(d, 'big-transcript/a.json', '"/Users/alice"');
    expect(rulesOf(d)).toEqual(['home-path']);
  });

  it('bulgularda değer yer almaz', () => {
    const d = tmpDir();
    write(d, 'a.json', '{"k":"sk-ant-api03-realrealrealreal0000"}');
    const f = scanPaths([d]);
    expect(f).toHaveLength(1);
    expect(JSON.stringify(f)).not.toContain('realreal');
  });

  it('üretilen sentetik senaryolar ve repodaki fixtures/ temiz', () => {
    const d = tmpDir();
    for (const [name, make] of Object.entries(SCENARIOS)) make().build(path.join(d, name), { force: true });
    expect(scanPaths([d])).toEqual([]);
    expect(validateScenarios(d)).toEqual([]);
    expect(scanPaths([path.join(REPO_ROOT, 'fixtures')])).toEqual([]);
  });
});

describe('validateScenarios', () => {
  it('bozuk manifest/timeline yakalanır', () => {
    const d = tmpDir();
    write(d, 'a/manifest.json', '{"name":"b","now":"x"}');
    write(d, 'a/timeline.json', '[{"at":5,"op":"write","path":"../x"},{"at":1,"op":"append","path":"y"}]');
    const problems = validateScenarios(d).map((p) => p.problem).join(' | ');
    expect(problems).toMatch(/dizin adıyla/);
    expect(problems).toMatch(/expect/);
    expect(problems).toMatch(/ISO/);
    expect(problems).toMatch(/claude\//);
    expect(problems).toMatch(/geçersiz|sıralı/);
  });
});

describe('check-fixtures CLI', () => {
  it('temiz dizinde 0, sızıntıda 1 döner ve değeri yazmaz', () => {
    const d = tmpDir();
    write(d, 'ok.json', '{"cwd":"/Users/demo/Projects/demo-1"}');
    const cli = path.join(REPO_ROOT, 'scripts/check-fixtures.mjs');
    expect(execFileSync(process.execPath, [cli, d], { encoding: 'utf8' })).toMatch(/temiz/);
    write(d, 'bad.json', '{"cwd":"/Users/alice/secret-project"}');
    let code = 0;
    let stderr = '';
    try {
      execFileSync(process.execPath, [cli, d], { encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      const err = e as { status: number; stderr: string };
      code = err.status;
      stderr = err.stderr;
    }
    expect(code).toBe(1);
    expect(stderr).toMatch(/home-path/);
    expect(stderr).not.toContain('alice');
  });
});

describe('validateCompatSchemas (09/01)', () => {
  const golden = (body: unknown) => {
    const root = tmpDir();
    write(root, 'compat/schema-2.1.318.json', JSON.stringify(body));
    return root;
  };
  it('yalnızca anahtar adı, tip ve sayı → temiz', () => {
    const root = golden({ claudeVersion: '2.1.318', registry: { files: 0, keys: { pid: 'number', cwd: 'string|null' } }, transcripts: { recordTypes: { assistant: 3 } } });
    expect(validateCompatSchemas(root)).toEqual([]);
  });
  it('değer içeren yaprak, dizi ya da cümle anahtar → bulgu', () => {
    expect(validateCompatSchemas(golden({ registry: { keys: { cwd: '/Users/demo/x' } } }))).toHaveLength(1);
    expect(validateCompatSchemas(golden({ registry: { keys: ['pid'] } }))).toHaveLength(1);
    expect(validateCompatSchemas(golden({ x: { 'lütfen bu müşteri kaydını hemen sil ve herkese haber ver': 1 } }))).toHaveLength(1);
  });
  it('dosya adı biçimi', () => {
    const root = tmpDir();
    write(root, 'compat/latest.json', '{}');
    expect(validateCompatSchemas(root)[0]?.problem).toContain('schema-<sürüm>.json');
  });
  it('repodaki golden temiz', () => {
    expect(validateCompatSchemas(path.join(REPO_ROOT, 'fixtures'))).toEqual([]);
  });
});
