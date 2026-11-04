import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { anonymizeSession } from '../../scripts/lib/anonymize.mjs';
import { scanPaths } from '../../scripts/lib/check.mjs';
import { encodeCwd } from '../../scripts/lib/fixture-builder.mjs';
import { readTree, REPO_ROOT, tmpDir } from './_tmp';

const HOME = '/Users/alice';
const CWD = `${HOME}/Work/acme-billing`;
const SID = '5f0e2c1a-9b7d-4c3e-8a21-0f1e2d3c4b5a';
const AGENT = 'a9f8e7d6c5b4a3921';

/** Gerçek görünümlü sahte bir ~/.claude kur (değerler "gizli" olmalı). */
function makeClaudeHome(): string {
  const root = tmpDir('diji-anon-src-');
  const pdir = path.join(root, 'projects', encodeCwd(CWD));
  fs.mkdirSync(path.join(pdir, SID, 'subagents'), { recursive: true });
  fs.mkdirSync(path.join(root, 'sessions'), { recursive: true });
  const base = { isSidechain: false, userType: 'external', cwd: CWD, sessionId: SID, version: '2.1.3', gitBranch: 'alice/secret-feature' };
  const recs = [
    { ...base, parentUuid: null, type: 'user', uuid: '11111111-1111-4111-8111-111111111111', timestamp: '2026-10-20T14:00:00.000Z', message: { role: 'user', content: 'Müşteri faturalarını alice@acme.io adresine gönderen kodu düzelt lütfen hemen şimdi' } },
    { ...base, parentUuid: '11111111-1111-4111-8111-111111111111', type: 'assistant', uuid: '22222222-2222-4222-8222-222222222222', timestamp: '2026-10-20T14:00:05.000Z', requestId: 'req_011CRealRequest', message: { id: 'msg_01RealMessageId', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Tamam, önce fatura gönderim modülünü okuyup ardından düzeltmeyi yapacağım şimdi.' }], stop_reason: null, usage: { input_tokens: 10, output_tokens: 20 } } },
    { ...base, parentUuid: '22222222-2222-4222-8222-222222222222', type: 'assistant', uuid: '33333333-3333-4333-8333-333333333333', timestamp: '2026-10-20T14:00:06.000Z', requestId: 'req_011CRealRequest', message: { id: 'msg_01RealMessageId', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_01RealTool', name: 'Read', input: { file_path: `${CWD}/src/billing/send-invoice.ts` } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 20 } } },
    { ...base, parentUuid: '33333333-3333-4333-8333-333333333333', type: 'user', uuid: '44444444-4444-4444-8444-444444444444', timestamp: '2026-10-20T14:00:07.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01RealTool', content: [{ type: 'text', text: 'export const KEY = "sk-ant-api03-realrealrealrealreal"; // send invoices for the customer' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' + 'x'.repeat(5000) } }] }] }, toolUseResult: { type: 'text', file: { filePath: `${CWD}/src/billing/send-invoice.ts`, content: 'gizli kaynak kodu buraya gelir ve uzun bir satır olarak duruyor', numLines: 120 } } },
    { type: 'last-prompt', sessionId: SID, lastPrompt: 'Müşteri faturalarını gönderen kodu düzelt lütfen hemen şimdi tamam mı' },
  ];
  fs.writeFileSync(path.join(pdir, `${SID}.jsonl`), recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const sub = { ...base, isSidechain: true, agentId: AGENT, parentUuid: null, type: 'user', uuid: '55555555-5555-4555-8555-555555555555', timestamp: '2026-10-20T14:00:08.000Z', message: { role: 'user', content: 'Fatura modülündeki e-posta gönderim hatasını araştır ve raporla bana' } };
  fs.writeFileSync(path.join(pdir, SID, 'subagents', `agent-${AGENT}.jsonl`), JSON.stringify(sub) + '\n');
  fs.writeFileSync(path.join(pdir, SID, 'subagents', `agent-${AGENT}.meta.json`), JSON.stringify({ description: 'Fatura e-posta hatasını araştır', agentType: 'Explore', model: 'inherit', requestShape: 'foreground' }));
  fs.writeFileSync(path.join(root, 'sessions', '73519.json'), JSON.stringify({ pid: 73519, sessionId: SID, cwd: CWD, name: 'acme billing fix', kind: 'interactive', entrypoint: 'cli', status: 'busy', waitingFor: null, startedAt: Date.parse('2026-10-20T13:59:00Z'), updatedAt: Date.parse('2026-10-20T14:00:08Z'), statusUpdatedAt: Date.parse('2026-10-20T14:00:08Z') }));
  return root;
}

async function run(salt = 'test-salt'): Promise<{ out: string; tree: Map<string, string> }> {
  const src = makeClaudeHome();
  const out = tmpDir('diji-anon-out-');
  await anonymizeSession({ claudeDir: src, sessionId: SID, outDir: out, name: 'real-1', salt, home: HOME });
  return { out, tree: readTree(out) };
}

describe('anonymizeSession', () => {
  it('çıktı katı tarayıcıdan (cümle kuralı dahil) temiz geçer ve hiçbir gerçek değer kalmaz', async () => {
    const { out, tree } = await run();
    expect(scanPaths([out], { strictSentences: true })).toEqual([]);
    const all = [...tree.keys(), ...tree.values()].join('\n');
    for (const leak of ['alice', 'acme', 'billing', 'send-invoice', 'secret-feature', 'realreal', 'Müşteri', 'RealMessageId', 'toolu_01RealTool', SID, AGENT, '73519', '2026-10-20']) {
      expect(all, leak).not.toContain(leak);
    }
  });

  it('yapı korunur: tipler, sayılar, model, stop_reason, araç adı, ilişkiler', async () => {
    const { tree } = await run();
    const main = [...tree].find(([p]) => /^claude\/projects\/[^/]+\/[^/]+\.jsonl$/.test(p));
    expect(main).toBeDefined();
    const recs = (main?.[1] ?? '').trim().split('\n').map((l) => JSON.parse(l));
    expect(recs.map((r) => r.type)).toEqual(['user', 'assistant', 'assistant', 'user', 'last-prompt']);
    const [u1, a1, a2, tr] = recs;
    expect(a1.parentUuid).toBe(u1.uuid);
    expect(a2.parentUuid).toBe(a1.uuid);
    expect(a1.message.id).toBe(a2.message.id); // blok başına satır: aynı message.id korunur
    expect(a1.message.id).toMatch(/^msg_/);
    expect(a1.message.model).toBe('claude-opus-5-5');
    expect(a2.message.stop_reason).toBe('tool_use');
    expect(a1.message.usage).toEqual({ input_tokens: 10, output_tokens: 20 });
    expect(a2.message.content[0].name).toBe('Read');
    expect(tr.message.content[0].tool_use_id).toBe(a2.message.content[0].id);
    expect(tr.message.content[0].content[1].source.data).toHaveLength(1024);
    expect(tr.toolUseResult.file.numLines).toBe(120);
    expect(u1.timestamp).toBe('2026-01-01T09:00:00.000Z');
    expect(a1.timestamp).toBe('2026-01-01T09:00:05.000Z');
    expect(u1.cwd).toBe('/Users/demo/Projects/demo-1');
    expect(a2.message.content[0].input.file_path).toMatch(/^\/Users\/demo\/Projects\/demo-1\/src\//);
    expect(u1.gitBranch).toBe('feature/demo-1');
    expect(u1.message.content).toMatch(/^▒+$/);
    expect(path.basename(main?.[0] ?? '')).toBe(`${u1.sessionId}.jsonl`);
    expect(path.dirname(main?.[0] ?? '')).toBe(`claude/projects/${encodeCwd('/Users/demo/Projects/demo-1')}`);
  });

  it('subagent, meta, registry ve manifest üretilir', async () => {
    const { tree } = await run();
    const meta = [...tree].find(([p]) => p.endsWith('.meta.json'));
    expect(JSON.parse(meta?.[1] ?? '{}')).toMatchObject({ agentType: 'Explore', model: 'inherit', requestShape: 'foreground', description: 'real-1 ajan' });
    expect([...tree.keys()].some((p) => /subagents\/agent-[^/]+\.jsonl$/.test(p))).toBe(true);
    const reg = [...tree].find(([p]) => /^claude\/sessions\/\d+\.json$/.test(p));
    const r = JSON.parse(reg?.[1] ?? '{}');
    expect(r).toMatchObject({ kind: 'interactive', status: 'busy', entrypoint: 'cli', cwd: '/Users/demo/Projects/demo-1' });
    expect(r.name).toMatch(/^▒+$/);
    expect(r.startedAt).toBe(Date.parse('2026-01-01T08:59:00.000Z'));
    const m = JSON.parse(tree.get('manifest.json') ?? '{}');
    expect(m).toMatchObject({ name: 'real-1', source: 'anonymized', pidAliveOverride: true, expect: { sessions: 1 } });
    expect(JSON.parse(tree.get('timeline.json') ?? '[]').length).toBe(1 + 5 + 1 + 1);
  });

  it('aynı tuz → aynı çıktı; farklı tuz → farklı kimlikler', async () => {
    const a = await run('s1');
    const b = await run('s1');
    const c = await run('s2');
    expect([...a.tree.values()]).toEqual([...b.tree.values()]);
    expect([...a.tree.keys()]).not.toEqual([...c.tree.keys()]);
  });

  it('make-fixtures --from uçtan uca: geçici dizinde üretir, tarar, yerine taşır', () => {
    const src = makeClaudeHome();
    const outRoot = tmpDir('diji-anon-cli-');
    const cli = path.join(REPO_ROOT, 'scripts/make-fixtures.mjs');
    const stdout = execFileSync(process.execPath, [cli, '--from', src, '--session', SID, '--name', 'real-cli', '--out', outRoot], { encoding: 'utf8', cwd: tmpDir() });
    expect(stdout).toMatch(/real-cli/);
    expect(fs.readdirSync(outRoot)).toEqual(['real-cli']);
    expect(scanPaths([outRoot], { strictSentences: true })).toEqual([]);
    // Ayrılmış ad reddedilir
    expect(() => execFileSync(process.execPath, [cli, '--from', src, '--session', SID, '--name', 'compact', '--out', outRoot], { stdio: 'pipe' })).toThrow();
  });
});
