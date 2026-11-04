import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudePaths, type ClaudePaths } from '../../../src/main/engine/paths';
import { TranscriptCursor } from '../../../src/main/engine/transcript/cursor';
import { FIXTURES, tmpDir } from '../_wait';

const DAY = Date.parse('2026-10-28T00:00:00.000Z');
const rec = (i: number, ts = DAY + i * 1000, extra = '') =>
  `{"type":"user","uuid":"u-${i}","sessionId":"s","timestamp":"${new Date(ts).toISOString()}"${extra}}\n`;

let root: string;
let paths: ClaudePaths;
let proj: string;

beforeEach(() => {
  root = tmpDir('diji-cur-');
  paths = claudePaths({ configDir: root });
  proj = path.join(paths.projects, '-Users-demo-app');
  fs.mkdirSync(proj, { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('TranscriptCursor.fromPath', () => {
  it('ana session ve iki subagent yolu', () => {
    const main = TranscriptCursor.fromPath(path.join(proj, 'sid-1.jsonl'), paths);
    expect([main?.sessionId, main?.agentId]).toEqual(['sid-1', null]);
    const a = TranscriptCursor.fromPath(path.join(proj, 'sid-1', 'agent-abc.jsonl'), paths);
    expect([a?.sessionId, a?.agentId]).toEqual(['sid-1', 'abc']);
    const b = TranscriptCursor.fromPath(path.join(proj, 'sid-1', 'subagents', 'agent-def.jsonl'), paths);
    expect([b?.sessionId, b?.agentId]).toEqual(['sid-1', 'def']);
  });
  it('projects dışı, jsonl olmayan ya da kök düzeyi dosyalar null', () => {
    expect(TranscriptCursor.fromPath('/elsewhere/x.jsonl', paths)).toBeNull();
    expect(TranscriptCursor.fromPath(path.join(proj, 'sid-1.json'), paths)).toBeNull();
    expect(TranscriptCursor.fromPath(path.join(paths.projects, 'x.jsonl'), paths)).toBeNull();
  });
});

describe('TranscriptCursor.pump', () => {
  it('yarım satırı bekletir, tamamlanınca verir', async () => {
    const f = path.join(proj, 's.jsonl');
    fs.writeFileSync(f, rec(1) + rec(2).slice(0, 20));
    const c = TranscriptCursor.fromPath(f, paths)!;
    expect((await c.pump({ dayStart: DAY })).map((r) => r['uuid'])).toEqual(['u-1']);
    fs.appendFileSync(f, rec(2).slice(20) + rec(3));
    expect((await c.pump({ dayStart: DAY })).map((r) => r['uuid'])).toEqual(['u-2', 'u-3']);
    expect(await c.pump({ dayStart: DAY })).toEqual([]);
    expect(c.lastRecordTs).toBe(DAY + 3000);
  });

  it('bozuk satır sayılır ve atlanır; ön-filtre tipleri dönmez', async () => {
    const f = path.join(proj, 's.jsonl');
    fs.writeFileSync(f, `${rec(1)}{bozuk\n{"type":"progress","uuid":"p"}\n{"type":"file-history-snapshot"}\n${rec(2)}`);
    const c = TranscriptCursor.fromPath(f, paths)!;
    expect((await c.pump({ dayStart: DAY })).map((r) => r['uuid'])).toEqual(['u-1', 'u-2']);
    expect(c.parseErrors).toBe(1);
  });

  it('dosya kısalırsa baştan okur', async () => {
    const f = path.join(proj, 's.jsonl');
    fs.writeFileSync(f, rec(1) + rec(2) + rec(3));
    const c = TranscriptCursor.fromPath(f, paths)!;
    await c.pump({ dayStart: DAY });
    fs.writeFileSync(f, rec(9));
    expect((await c.pump({ dayStart: DAY })).map((r) => r['uuid'])).toEqual(['u-9']);
  });

  it('silinmiş dosyada boş döner', async () => {
    const c = TranscriptCursor.fromPath(path.join(proj, 'yok.jsonl'), paths)!;
    expect(await c.pump({ dayStart: DAY })).toEqual([]);
  });

  it('>8 MB dosyada dünü atlar, bugünün tüm kayıtlarını verir', async () => {
    const f = path.join(proj, 'big.jsonl');
    const pad = `,"pad":"${'p'.repeat(900)}"`;
    const fd = fs.openSync(f, 'w');
    for (let i = 0; i < 10_000; i++) fs.writeSync(fd, rec(i, DAY - 86_400_000 + i * 1000, pad));
    for (let i = 0; i < 50; i++) fs.writeSync(fd, rec(100_000 + i, DAY + 3600_000 + i * 1000));
    fs.closeSync(fd);
    expect(fs.statSync(f).size).toBeGreaterThan(9 * 1024 * 1024);
    const c = TranscriptCursor.fromPath(f, paths)!;
    const out = await c.pump({ dayStart: DAY });
    const today = out.filter((r) => Date.parse(String(r['timestamp'])) >= DAY);
    expect(today).toHaveLength(50);
    expect(today[0]?.['uuid']).toBe('u-100000');
    expect(out.length).toBeLessThan(2000); // dünün çoğu okunmadı
    expect(c.bytesRead).toBeLessThan(3 * 1024 * 1024);
    expect(c.parseErrors).toBe(0); // ilk (yarım) satır atlandı
  });

  it('2 MB base64 görsel satırı kırpılarak hızla parse edilir', async () => {
    const f = path.join(proj, 'img.jsonl');
    const data = 'iVBORw0KGgo'.repeat(200_000);
    fs.writeFileSync(
      f,
      `{"type":"user","uuid":"img","timestamp":"2026-10-28T09:00:00.000Z","message":{"role":"user","content":[{"type":"tool_result","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"${data}"}}]}]}}\n${rec(2)}`,
    );
    const c = TranscriptCursor.fromPath(f, paths)!;
    const t0 = performance.now();
    const out = await c.pump({ dayStart: DAY });
    expect(performance.now() - t0).toBeLessThan(500);
    expect(out.map((r) => r['uuid'])).toEqual(['img', 'u-2']);
    expect(JSON.stringify(out[0]).length).toBeLessThan(1000);
  });

  it('with-image fixture: küçük görsel korunur', async () => {
    const src = path.join(FIXTURES, 'transcripts', 'with-image', '-Users-demo-Projects-demo-app');
    const dest = path.join(paths.projects, '-Users-demo-Projects-demo-app');
    fs.cpSync(src, dest, { recursive: true });
    const f = path.join(dest, 'a1a1a1a1-0000-4000-8000-000000000001.jsonl');
    const out = await TranscriptCursor.fromPath(f, paths)!.pump({ dayStart: DAY });
    expect(out).toHaveLength(3);
    expect(JSON.stringify(out)).toContain('"media_type":"image/png"');
  });
});
