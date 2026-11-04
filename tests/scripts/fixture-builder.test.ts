import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeCwd, FixtureBuilder, seededUuid } from '../../scripts/lib/fixture-builder.mjs';
import { SCENARIOS } from '../../scripts/lib/scenarios.mjs';
import { readTree, tmpDir } from './_tmp';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type Rec = Record<string, unknown> & { message?: Record<string, unknown> };

describe('fixture-builder yardımcıları', () => {
  it('encodeCwd alfanümerik olmayan her karakteri tireye çevirir', () => {
    expect(encodeCwd('/Users/demo/Projects/demo-1/.claude/worktrees/ui')).toBe('-Users-demo-Projects-demo-1--claude-worktrees-ui');
  });
  it('seededUuid deterministik ve UUIDv4 biçiminde', () => {
    expect(seededUuid('a')).toBe(seededUuid('a'));
    expect(seededUuid('a')).not.toBe(seededUuid('b'));
    expect(seededUuid('a')).toMatch(UUID);
  });
  it('zaman geri gidemez', () => {
    const b = new FixtureBuilder({ name: 'x', description: 'x', now: '2026-01-01T09:00:00.000Z' });
    b.at(1000);
    expect(() => b.at(500)).toThrow();
  });
});

describe.each(Object.keys(SCENARIOS))('senaryo %s', (name) => {
  const make = SCENARIOS[name as keyof typeof SCENARIOS];
  const out = path.join(tmpDir(), name);
  make().build(out, { force: true });
  const tree = readTree(out);

  it('manifest, timeline ve claude/ var; manifest brief şemasında', () => {
    const m = JSON.parse(tree.get('manifest.json') ?? '{}');
    expect(m.name).toBe(name);
    expect(m.source).toBe('synthetic');
    expect(m.now).toMatch(ISO);
    expect(m.pidAliveOverride).toBe(true);
    expect(typeof m.expect).toBe('object');
    expect(m.expect.sessions).toBeGreaterThanOrEqual(1);
    const tl = JSON.parse(tree.get('timeline.json') ?? '[]');
    expect(tl.length).toBeGreaterThan(0);
    expect(tl.map((o: { at: number }) => o.at)).toEqual([...tl.map((o: { at: number }) => o.at)].sort((a, b) => a - b));
  });

  it('her JSONL satırı gerçekçi Claude Code kaydı', () => {
    const jsonl = [...tree].filter(([p]) => p.startsWith('claude/projects/') && p.endsWith('.jsonl'));
    expect(jsonl.length).toBeGreaterThan(0);
    for (const [p, text] of jsonl) {
      const recs: Rec[] = text.trim().split('\n').map((l) => JSON.parse(l));
      const uuids = new Set(recs.map((r) => r.uuid).filter(Boolean));
      for (const r of recs) {
        if (r.type !== 'user' && r.type !== 'assistant' && r.type !== 'system') continue;
        expect(r.uuid, p).toMatch(UUID);
        expect(r.sessionId).toMatch(UUID);
        expect(r.timestamp).toMatch(ISO);
        expect(String(r.cwd)).toMatch(/^\/Users\/demo\/Projects\/demo-/);
        expect(typeof r.gitBranch).toBe('string');
        expect(r.version).toBeTruthy();
        if (r.parentUuid !== null) expect(uuids.has(r.parentUuid as string), `${p} parentUuid`).toBe(true);
        if (r.type === 'assistant') {
          const msg = r.message ?? {};
          expect(String(msg.id)).toMatch(/^msg_/);
          expect(typeof msg.model).toBe('string');
          expect(msg.usage).toBeTypeOf('object');
          expect('stop_reason' in msg).toBe(true);
          expect(Array.isArray(msg.content)).toBe(true);
        }
      }
    }
  });

  it('registry dosyaları Claude Code şemasında', () => {
    const regs = [...tree].filter(([p]) => /^claude\/sessions\/\d+\.json$/.test(p));
    for (const [p, text] of regs) {
      const r = JSON.parse(text);
      expect(path.basename(p)).toBe(`${r.pid}.json`);
      for (const k of ['sessionId', 'pid', 'status', 'waitingFor', 'name', 'kind', 'cwd', 'startedAt', 'updatedAt', 'statusUpdatedAt', 'entrypoint']) {
        expect(r, `${p}.${k}`).toHaveProperty(k);
      }
      expect(r.kind).toBe('interactive');
      expect(r.updatedAt).toBeGreaterThanOrEqual(r.startedAt);
    }
  });

  it('deterministik: iki üretim bayt bayt aynı', () => {
    const again = path.join(tmpDir(), name);
    make().build(again, { force: true });
    expect(readTree(again)).toEqual(tree);
  });
});

describe('build()', () => {
  it('--force olmadan var olan dizinin üzerine yazmaz', () => {
    const out = path.join(tmpDir(), 'basic');
    SCENARIOS['basic-two-sessions']().build(out);
    expect(() => SCENARIOS['basic-two-sessions']().build(out)).toThrow(/--force/);
    expect(fs.existsSync(path.join(out, 'manifest.json'))).toBe(true);
  });
});
