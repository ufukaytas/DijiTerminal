import { describe, expect, it } from 'vitest';
import { clip, fmtBytes, safeText, shortModel, summarizeTool } from '@main/engine/summarize';
import { redact, REDACT_MAX_INPUT } from '@main/engine/redact';

const P = '/Users/demo/Projects/demo-app';

describe('summarizeTool', () => {
  it.each([
    ['Read', { file_path: `${P}/src/editor/ThemePreview.tsx` }, 'editor/ThemePreview.tsx', `${P}/src/editor/ThemePreview.tsx`],
    ['NotebookRead', { notebook_path: `${P}/nb/analiz.ipynb` }, 'nb/analiz.ipynb', `${P}/nb/analiz.ipynb`],
    ['Edit', { file_path: `${P}/lib/cache.ts`, old_string: 'a', new_string: 'b' }, 'lib/cache.ts', `${P}/lib/cache.ts`],
    ['MultiEdit', { file_path: `${P}/a.ts`, edits: [] }, 'demo-app/a.ts', `${P}/a.ts`],
    ['Write', { file_path: '/README.md', content: 'x' }, 'README.md', '/README.md'],
    ['NotebookEdit', { notebook_path: `${P}/nb/x.ipynb` }, 'nb/x.ipynb', `${P}/nb/x.ipynb`],
    ['Grep', { pattern: 'ThemePreview', path: 'src/' }, '"ThemePreview" src/', undefined],
    ['Grep', { pattern: 'TODO', glob: '**/*.ts' }, '"TODO" **/*.ts', undefined],
    ['Grep', { pattern: 'TODO' }, '"TODO"', undefined],
    ['Glob', { pattern: 'src/**/*.tsx' }, 'src/**/*.tsx', undefined],
    ['WebSearch', { query: 'vitest snapshot' }, '"vitest snapshot"', undefined],
    ['WebFetch', { url: 'https://vitest.dev/guide/snapshot?ref=x#y' }, 'vitest.dev/guide/snapshot', undefined],
    ['WebFetch', { url: 'https://example.com/' }, 'example.com', undefined],
    ['WebFetch', { url: 'not a url?q=1' }, 'not a url', undefined],
    ['Agent', { description: 'Snapshot testlerini bul', subagent_type: 'Explore' }, 'Snapshot testlerini bul', undefined],
    ['Task', { subagent_type: 'general-purpose' }, 'general-purpose', undefined],
    ['TodoWrite', { todos: [{}, {}, {}] }, '3 görev', undefined],
    ['mcp__supabase__execute_sql', { query: 'select 1' }, 'supabase · execute_sql', undefined],
    ['mcp__claude-in-chrome__navigate', {}, 'claude-in-chrome · navigate', undefined],
    ['ExitPlanMode', { plan: '…' }, 'ExitPlanMode', undefined],
    ['Bash', undefined, 'Bash', undefined],
    ['Read', {}, 'Read', undefined],
  ])('%s %j → %s', (name, input, label, file) => {
    const s = summarizeTool(name, input);
    expect(s.label).toBe(label);
    expect(s.file).toBe(file);
  });

  it('Bash: ilk satır + " …", komut alanı korunur, description eklenmez', () => {
    const s = summarizeTool('Bash', { command: 'npm test -- editor\n# ikinci satır', description: 'Run tests' });
    expect(s.label).toBe('npm test -- editor …');
    expect(s.command).toBe('npm test -- editor\n# ikinci satır');
  });

  it('Bash: etiket 80 karaktere kırpılır', () => {
    const s = summarizeTool('Bash', { command: 'echo ' + 'a'.repeat(200) });
    expect(s.label.length).toBe(80);
    expect(s.label.endsWith('…')).toBe(true);
  });

  it('Bash: sır hem etikette hem komutta gizlenir', () => {
    const s = summarizeTool('Bash', { command: 'API_KEY=sk-ant-api03-FAKEFAKEFAKE npm run seed' });
    expect(s.label).toBe('API_KEY=‹gizli› npm run seed');
    expect(s.command).not.toContain('FAKE');
  });

  it('50 KB tek satırlık komut kısa etikete iner', () => {
    const s = summarizeTool('Bash', { command: 'x'.repeat(50_000) });
    expect(s.label.length).toBeLessThanOrEqual(80);
    expect(s.command!.length).toBeLessThanOrEqual(2000);
  });

  it('etiketler en fazla 160 karakter', () => {
    expect(summarizeTool('WebSearch', { query: 'q'.repeat(500) }).label.length).toBe(160);
  });
});

describe('shortModel', () => {
  it.each([
    ['claude-opus-5-5-20260601', 'opus 5.5'],
    ['claude-opus-5-5', 'opus 5.5'],
    ['claude-sonnet-5-5-20260601', 'sonnet 5.5'],
    ['claude-sonnet-5', 'sonnet 5'],
    ['claude-haiku-4-5-20251001', 'haiku 4.5'],
    ['claude-haiku-5-5', 'haiku 5.5'],
    ['claude-fable-5-1', 'fable 5.1'],
    ['claude-mythos-5-1-20260615', 'mythos 5.1'],
    ['claude-opus-4-20250514', 'opus 4'],
    ['<synthetic>', '<synthetic>'],
    ['', ''],
  ])('%s → %s', (input, expected) => {
    expect(shortModel(input)).toBe(expected);
  });
  it('null/undefined', () => {
    expect(shortModel(null)).toBe('');
    expect(shortModel(undefined)).toBe('');
  });
});

describe('clip ve fmtBytes', () => {
  it('clip boşlukları teke indirir ve uzunu kısaltır', () => {
    expect(clip('  a \n\t b  ', 10)).toBe('a b');
    expect(clip('abcdef', 4)).toBe('abc…');
    expect(clip(null, 4)).toBe('');
  });
  it.each([
    [512, '512 B'],
    [41984, '41 KB'],
    [1258291, '1.2 MB'],
    [-1, ''],
  ])('fmtBytes(%d) = %s', (n, s) => {
    expect(fmtBytes(n)).toBe(s);
  });
});

// Performans (05/02): clip ve safeText metnin yalnızca görünecek önünü işler; sonuç tam işlemle birebir aynı olmalı.
describe('pencereli clip/safeText eşdeğerliği', () => {
  const fullClip = (s: string, n: number): string => {
    const flat = s.replace(/\s+/g, ' ').trim();
    return flat.length > n ? `${flat.slice(0, Math.max(0, n - 1))}…` : flat;
  };
  const fullSafe = (s: string, n: number): string => fullClip(redact(s.slice(0, REDACT_MAX_INPUT)), n);

  // Deterministik sözde rastgele üreteç.
  let seed = 7;
  const rnd = (k: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % k;
  };
  const pieces = [
    'a', 'bc', 'kelime ', ' ', '   ', '\n\n', '\t', '          ',
    'sk-ant-abcdefghijklmnop', 'sk-ant-abc', 'ghp_abcdefghijklmnopqrstuvwxyz12',
    'github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'AKIAABCDEFGHIJKLMNOP',
    'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4',
    'Bearer abcdefghijklmnopqrstuvwx', 'Bearer' + ' '.repeat(300) + 'abcdefghijklmnopqrstuvwx',
    'API_KEY=supersecretvalue ', 'token' + ' '.repeat(200) + ': "değer içinde boşluk"', 'password=x',
    'xoxb-1234567890-abc', 'ğüşıöç ', '…',
  ];
  const sample = (): string => {
    let s = '';
    const len = rnd(400);
    for (let i = 0; i < len; i++) s += pieces[rnd(pieces.length)];
    return s;
  };

  it('clip: rastgele 3000 metinde tam işlemle aynı', () => {
    for (let i = 0; i < 3000; i++) {
      const s = sample();
      for (const n of [1, 20, 90, 160, 220]) expect(clip(s, n)).toBe(fullClip(s, n));
    }
  });

  it('safeText: rastgele 3000 metinde clip(redact(slice)) ile aynı', () => {
    for (let i = 0; i < 3000; i++) {
      const s = sample();
      for (const n of [20, 70, 160, 220]) expect(safeText(s, n)).toBe(fullSafe(s, n));
    }
  });

  it('safeText: pencere sınırına denk gelen sır yine gizlenir', () => {
    for (let pad = 300; pad < 420; pad++) {
      const s = `${'x'.repeat(pad)} sk-ant-${'a'.repeat(40)} son`;
      expect(safeText(s, 160)).toBe(fullSafe(s, 160));
      const t = `${'y '.repeat(pad)}sk-ant-${'b'.repeat(40)}`;
      expect(safeText(t, 220)).toBe(fullSafe(t, 220));
    }
  });
});
