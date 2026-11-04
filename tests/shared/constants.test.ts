import { describe, expect, it } from 'vitest';
import { categoryOf, CATEGORY_COLOR, STATUS_COLOR, THRESHOLDS } from '@shared/constants';
import { fail, IPC_CHANNELS, ok, SESSION_ID_RE } from '@shared/ipc';

describe('categoryOf', () => {
  it.each([
    ['Read', 'read'],
    ['NotebookRead', 'read'],
    ['Grep', 'search'],
    ['Glob', 'search'],
    ['ToolSearch', 'search'],
    ['Edit', 'edit'],
    ['Write', 'edit'],
    ['MultiEdit', 'edit'],
    ['NotebookEdit', 'edit'],
    ['Bash', 'bash'],
    ['BashOutput', 'bash'],
    ['WebSearch', 'web'],
    ['WebFetch', 'web'],
    ['Agent', 'agent'],
    ['Task', 'agent'],
    ['mcp__claude-in-chrome__navigate', 'browser'],
    ['mcp__computer-use__click', 'browser'],
    ['computer', 'browser'],
    ['mcp__supabase__execute_sql', 'mcp'],
    ['TodoWrite', 'plan'],
    ['ExitPlanMode', 'plan'],
    ['BilinmeyenArac', 'plan'],
  ] as const)('%s → %s', (name, cat) => {
    expect(categoryOf(name)).toBe(cat);
  });

  it('her kategorinin bir rengi var', () => {
    for (const c of ['read', 'search', 'edit', 'bash', 'web', 'browser', 'agent', 'mcp', 'plan'] as const) {
      expect(CATEGORY_COLOR[c]).toMatch(/^#[0-9A-F]{6}$/i);
    }
    expect(Object.keys(STATUS_COLOR).sort()).toEqual(['busy', 'ended', 'idle', 'waiting']);
  });

  it('eşikler brief ile aynı', () => {
    expect(THRESHOLDS.slowToolMs).toBe(180_000);
    expect(THRESHOLDS.conflictWindowMs).toBe(20 * 60_000);
    expect(THRESHOLDS.eventBatchMs).toBe(120);
  });
});

describe('ipc yardımcıları', () => {
  it('ok/fail', () => {
    expect(ok(5)).toEqual({ ok: true, data: 5 });
    expect(fail('BAD_INPUT', 'x')).toEqual({ ok: false, error: { code: 'BAD_INPUT', message: 'x' } });
  });
  it('kanal listeleri benzersiz', () => {
    expect(new Set(IPC_CHANNELS.invoke).size).toBe(IPC_CHANNELS.invoke.length);
    expect(new Set(IPC_CHANNELS.events).size).toBe(IPC_CHANNELS.events.length);
  });
  it('session kimliği doğrulama', () => {
    expect(SESSION_ID_RE.test('5f3c2a10-8b7e-4c1d-9a2f-0e6b7d4c3a21')).toBe(true);
    expect(SESSION_ID_RE.test('../../etc')).toBe(false);
  });
});
