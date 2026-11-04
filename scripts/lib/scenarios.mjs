// @ts-check
// 05/01 Bölüm 4'teki 10 sentetik senaryo. Her biri bir FixtureBuilder döner; make-fixtures.mjs yazar.
// Metinler bilinçli olarak kısa ve sentetiktir (check-fixtures gerçek prompt sızıntısı arar).

import { FixtureBuilder } from './fixture-builder.mjs';

const NOW = '2026-01-01T09:00:00.000Z';
const P = (/** @type {string} */ name) => `/Users/demo/Projects/${name}`;

// ---------- küçük yardımcılar: araç çağrısı + sonucu ----------

/** @param {import('./fixture-builder.mjs').SessionWriter} s @param {string} file */
function read(s, file) {
  const { toolUseIds } = s.assistant({ tools: [{ name: 'Read', input: { file_path: file } }] });
  s.b.advance(600);
  s.toolResult(/** @type {string} */ (toolUseIds[0]), {
    content: '1\t▒▒▒▒',
    toolUseResult: { type: 'text', file: { filePath: file, content: '▒▒▒▒', numLines: 40, startLine: 1, totalLines: 40 } },
  });
  s.b.advance(1200);
}

/** @param {import('./fixture-builder.mjs').SessionWriter} s @param {string} file */
function edit(s, file) {
  const { toolUseIds } = s.assistant({ tools: [{ name: 'Edit', input: { file_path: file, old_string: '▒▒', new_string: '▒▒▒' } }] });
  s.b.advance(900);
  s.toolResult(/** @type {string} */ (toolUseIds[0]), {
    content: 'The file has been updated.',
    toolUseResult: { filePath: file, oldString: '▒▒', newString: '▒▒▒', structuredPatch: [], userModified: false },
  });
  s.b.advance(1500);
}

/** @param {import('./fixture-builder.mjs').SessionWriter} s @param {string} command @param {number} [ms] @param {boolean} [ok] */
function bash(s, command, ms = 4000, ok = true) {
  const { toolUseIds } = s.assistant({ tools: [{ name: 'Bash', input: { command, description: 'demo' } }] });
  s.b.advance(ms);
  s.toolResult(/** @type {string} */ (toolUseIds[0]), {
    ok,
    content: ok ? 'ok' : 'Exit code 1',
    toolUseResult: { stdout: ok ? 'ok' : '', stderr: ok ? '' : 'hata', interrupted: false, isImage: false },
  });
  s.b.advance(1000);
}

/** @param {import('./fixture-builder.mjs').SessionWriter} s @param {string} text */
function endTurn(s, text = 'Tamam.') {
  s.assistant({ text, stop: 'end_turn' });
  s.b.advance(200);
  s.turn(48_000);
}

// ---------- senaryolar ----------

function basicTwoSessions() {
  const b = new FixtureBuilder({ name: 'basic-two-sessions', description: '2 proje, 2 session, birer Read/Edit/Bash turu; ikisi de boşta.', now: NOW });
  const a = b.session({ pid: 41001, cwd: P('demo-1'), name: 'demo-1', status: 'busy' });
  b.at(5_000);
  const c = b.session({ pid: 41002, cwd: P('demo-2'), name: 'demo-2', branch: 'feature/demo-2', model: 'claude-sonnet-5-5', status: 'busy' });
  b.at(10_000);
  a.user('demo istek 1');
  a.aiTitle('Demo görev 1');
  a.lastPrompt('demo istek 1');
  b.advance(800);
  read(a, P('demo-1/src/app.ts'));
  edit(a, P('demo-1/src/app.ts'));
  bash(a, 'npm test');
  endTurn(a);
  a.registry({ status: 'idle' });
  b.at(60_000);
  c.user('demo istek 2');
  c.aiTitle('Demo görev 2');
  c.lastPrompt('demo istek 2');
  b.advance(800);
  read(c, P('demo-2/lib/util.py'));
  edit(c, P('demo-2/lib/util.py'));
  bash(c, 'pytest -q');
  endTurn(c);
  c.registry({ status: 'idle' });
  b.expect({ sessions: 2, statuses: { [a.sessionId]: 'idle', [c.sessionId]: 'idle' }, totals: { liveSessions: 2, waiting: 0 } });
  return b;
}

function waitingPermission() {
  const b = new FixtureBuilder({ name: 'waiting-permission', description: 'Bash izni bekleyen tek session (status waiting).', now: NOW });
  const s = b.session({ pid: 41011, cwd: P('demo-1'), name: 'demo-1', status: 'busy', branch: 'feature/demo-1' });
  b.at(30_000);
  s.user('migration ekle');
  s.aiTitle('Migration');
  s.lastPrompt('migration ekle');
  b.advance(700);
  read(s, P('demo-1/db/schema.sql'));
  edit(s, P('demo-1/db/migrations/0042.sql'));
  s.assistant({ tools: [{ name: 'Bash', input: { command: 'npm run db:migrate', description: 'migrate' } }] });
  b.advance(300);
  s.registry({ status: 'waiting', waitingFor: 'permission:Bash' });
  b.expect({
    sessions: 1,
    statuses: { [s.sessionId]: 'waiting' },
    totals: { waiting: 1 },
    waitingFor: { [s.sessionId]: { tool: 'Bash', label: 'npm run db:migrate' } },
  });
  return b;
}

function subagentsTeam() {
  const b = new FixtureBuilder({ name: 'subagents-team', description: 'Agent takımı: 3 subagent, biri bitmiş, biri arka planda.', now: NOW });
  const root = P('demo-team');
  for (const t of ['audience-seo-researcher', 'pipeline-linkedin-writer', 'ventures-skool-planner']) {
    b.repoFile(`demo-team/.claude/agents/${t}.md`, `---\nname: ${t}\ndescription: demo\n---\n▒▒▒▒\n`);
  }
  const s = b.session({ pid: 41021, cwd: root, name: 'HQ', status: 'busy' });
  // Etkinlik now'dan ~30 sn önce: arka plan ajanı (r3) sessizlik kuralıyla bitmiş ama hâlâ 15 dk görünürlük içinde.
  // Etkinlik 20 dk önce olsaydı r3'ün bitişi son kaydına çekilir ve listeden düşerdi (doğru davranış).
  b.at(1_170_000);
  s.user('haftalık plan');
  s.aiTitle('Haftalık plan');
  s.lastPrompt('haftalık plan');
  b.advance(1000);
  const r1 = s.spawnSubagent({ agentId: 'a1b2c3d4', agentType: 'audience-seo-researcher', description: 'trend araştırması', model: 'claude-haiku-5-5' });
  const r2 = s.spawnSubagent({ agentId: 'e5f6a7b8', agentType: 'pipeline-linkedin-writer', description: 'linkedin taslağı', model: 'inherit' });
  const r3 = s.spawnSubagent({ agentId: 'c9d0e1f2', agentType: 'ventures-skool-planner', description: 'skool planı', model: 'claude-sonnet-5-5', background: true });
  // r3 çalışıp bitiyor
  b.advance(1500);
  read(r3.sub, P('demo-team/plans/skool.md'));
  edit(r3.sub, P('demo-team/plans/skool.md'));
  r3.sub.assistant({ text: 'bitti', stop: 'end_turn' });
  b.advance(500);
  s.finishSubagent(r3.toolUseId, { agentId: 'c9d0e1f2', description: 'skool planı', resolvedModel: 'claude-sonnet-5-5' });
  // r1 ve r2 hâlâ çalışıyor: bekleyen araçlar
  b.advance(2000);
  r1.sub.assistant({ tools: [{ name: 'WebSearch', input: { query: 'demo sorgu' } }] });
  b.advance(500);
  r2.sub.assistant({ tools: [{ name: 'Write', input: { file_path: P('demo-team/drafts/post.md'), content: '▒▒▒▒' } }] });
  b.expect({ sessions: 1, statuses: { [s.sessionId]: 'busy' }, subagents: 3, totals: { runningAgents: 2 } });
  b.extraManifest.repoRoots = { [root]: 'repos/demo-team' };
  b.extraManifest.teams = { a1b2c3d4: 'audience', e5f6a7b8: 'pipeline', c9d0e1f2: 'ventures' };
  return b;
}

function forkResume() {
  const b = new FixtureBuilder({ name: 'fork-resume', description: 'Resume ile yeni sessionId; eski kayıtlar aynı uuid ile tekrarlanır.', now: NOW });
  const old = b.session({ pid: 41031, cwd: P('demo-1'), name: 'demo-1', status: 'busy' });
  b.at(10_000);
  old.user('ilk görev');
  old.aiTitle('İlk görev');
  b.advance(500);
  read(old, P('demo-1/src/a.ts'));
  edit(old, P('demo-1/src/a.ts'));
  endTurn(old);
  old.exit();
  b.at(300_000);
  const resumed = b.session({ pid: 41032, cwd: P('demo-1'), name: 'demo-1', status: 'busy' });
  resumed.copyHistoryFrom(old);
  b.advance(1000);
  resumed.user('devam et');
  b.advance(500);
  bash(resumed, 'npm run build');
  endTurn(resumed);
  resumed.registry({ status: 'idle' });
  b.expect({ sessions: 1, statuses: { [resumed.sessionId]: 'idle' }, superseded: { [old.sessionId]: resumed.sessionId }, toolCalls: 3 });
  return b;
}

function compact() {
  const b = new FixtureBuilder({ name: 'compact', description: 'compact_boundary sonrası aynı süreçte yeni sessionId.', now: NOW });
  const s1 = b.session({ pid: 41041, cwd: P('demo-1'), name: 'demo-1', status: 'busy' });
  b.at(10_000);
  s1.user('uzun görev');
  b.advance(500);
  read(s1, P('demo-1/src/big.ts'));
  edit(s1, P('demo-1/src/big.ts'));
  s1.system('compact_boundary', { content: 'Conversation compacted', level: 'info', compactMetadata: { trigger: 'auto', preTokens: 180000 } });
  b.advance(2000);
  // Aynı pid, yeni sessionId: registry dosyası yeni id ile yeniden yazılır.
  const s2 = b.session({ pid: 41041, cwd: P('demo-1'), name: 'demo-1', status: 'busy', register: false });
  s2.reg.startedAt = s1.reg.startedAt;
  s2.registry({ status: 'busy' });
  s2.userRaw('<command-name>/compact</command-name>', true);
  b.advance(500);
  bash(s2, 'npm test');
  endTurn(s2);
  s2.registry({ status: 'idle' });
  b.expect({ sessions: 1, statuses: { [s2.sessionId]: 'idle' }, superseded: { [s1.sessionId]: s2.sessionId } });
  return b;
}

function conflictSameFile() {
  const b = new FixtureBuilder({ name: 'conflict-same-file', description: 'Aynı repoda iki session (biri worktree) aynı dosyaya yazar.', now: NOW });
  const main = b.session({ pid: 41051, cwd: P('demo-1'), name: 'brief-cache', status: 'busy', branch: 'feature/demo-1' });
  b.at(5_000);
  const wt = b.session({ pid: 41052, cwd: P('demo-1/.claude/worktrees/ui'), name: 'ui', status: 'busy', branch: 'worktree-ui', model: 'claude-sonnet-5-5' });
  const shared = P('demo-1/lib/types.ts');
  b.at(60_000);
  main.user('cache katmanı');
  b.advance(500);
  edit(main, shared);
  b.at(240_000);
  wt.user('rozetler');
  b.advance(500);
  edit(wt, shared);
  edit(wt, P('demo-1/.claude/worktrees/ui/components/Card.tsx'));
  endTurn(main);
  endTurn(wt);
  main.registry({ status: 'idle' });
  wt.registry({ status: 'idle' });
  b.expect({ sessions: 2, conflicts: 1, conflictPaths: [shared], projects: 1 });
  return b;
}

function slowTool() {
  const b = new FixtureBuilder({ name: 'slow-tool', description: '4 dakikadır sonuçlanmamış Bash çağrısı.', now: NOW });
  const s = b.session({ pid: 41061, cwd: P('demo-voice'), name: 'vad', status: 'busy', branch: 'feature/demo-voice' });
  b.at(600_000);
  s.user('testleri koş');
  b.advance(1000);
  s.assistant({ tools: [{ name: 'Bash', input: { command: 'pytest tests/vad -x', description: 'tests' } }] });
  // now = t 20 dk; Bash t=601 sn'de başladı → ~10 dk sonuçsuz (eşik 3 dk)
  b.expect({ sessions: 1, statuses: { [s.sessionId]: 'busy' }, flags: { [s.sessionId]: ['slow-tool'] }, totals: { slowTools: 1 } });
  return b;
}

function apiError() {
  const b = new FixtureBuilder({ name: 'api-error', description: 'isApiErrorMessage ve system/api_error kayıtları; çökme yok.', now: NOW });
  const s = b.session({ pid: 41071, cwd: P('demo-1'), name: 'demo-1', status: 'busy' });
  b.at(10_000);
  s.user('özet çıkar');
  b.advance(2000);
  s.assistant({ text: 'API Error: 529 overloaded', apiError: true, stop: 'stop_sequence' });
  b.advance(1000);
  s.system('api_error', { level: 'error', content: 'API Error: 529 overloaded', retryAttempt: 1, retryInMs: 2000 });
  b.advance(3000);
  read(s, P('demo-1/README.md'));
  endTurn(s);
  s.registry({ status: 'idle' });
  b.expect({ sessions: 1, statuses: { [s.sessionId]: 'idle' }, logErrors: 2 });
  return b;
}

function imagesBase64() {
  const b = new FixtureBuilder({ name: 'images-base64', description: '512 KB base64 görüntü içeren tool_result satırı (parse öncesi kırpılmalı).', now: NOW });
  const s = b.session({ pid: 41081, cwd: P('demo-ui'), name: 'ui', status: 'busy' });
  b.at(10_000);
  s.user('ekran görüntüsüne bak');
  b.advance(500);
  const { toolUseIds } = s.assistant({ tools: [{ name: 'mcp__claude-in-chrome__computer', input: { action: 'screenshot' } }] });
  b.advance(1500);
  const data = 'iVBORw0KGgo' + 'A'.repeat(512 * 1024);
  s.toolResult(/** @type {string} */ (toolUseIds[0]), { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }] });
  b.advance(1000);
  endTurn(s);
  s.registry({ status: 'idle' });
  b.expect({ sessions: 1, statuses: { [s.sessionId]: 'idle' }, maxParseMs: 50 });
  return b;
}

/**
 * 60 MB jsonl, ilk ~55 MB dünden. Yalnızca --include-big ile; repoya konmaz.
 * Builder yerine doğrudan yazılır (milyonlarca op'u bellekte tutmamak için).
 */
export function bigTranscriptSpec() {
  return {
    name: 'big-transcript',
    description: '60 MB transcript, ilk ~55 MB dünden; yalnızca bugünün kayıtları sayılmalı.',
    now: NOW,
    targetBytes: 60 * 1024 * 1024,
    yesterdayBytes: 55 * 1024 * 1024,
  };
}

export const SCENARIOS = {
  'basic-two-sessions': basicTwoSessions,
  'waiting-permission': waitingPermission,
  'subagents-team': subagentsTeam,
  'fork-resume': forkResume,
  compact,
  'conflict-same-file': conflictSameFile,
  'slow-tool': slowTool,
  'api-error': apiError,
  'images-base64': imagesBase64,
};

export const ALL_SCENARIO_NAMES = [...Object.keys(SCENARIOS), 'big-transcript'];
