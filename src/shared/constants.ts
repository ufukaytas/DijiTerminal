// Ortak sabitler — renkler, araç kategorileri, eşikler (00/02).
import type { EmblemKind, SessionStatus, ToolCategory } from './types';

/** Araç adı → kategori. Tabloda olmayanlar categoryOf'ta kurallarla çözülür. */
export const TOOL_CATEGORY_OF: Readonly<Record<string, ToolCategory>> = {
  Read: 'read',
  NotebookRead: 'read',
  Grep: 'search',
  Glob: 'search',
  ToolSearch: 'search',
  LSP: 'search',
  ListMcpResourcesTool: 'search',
  ReadMcpResourceTool: 'search',
  ReadMcpResourceDirTool: 'search',
  Edit: 'edit',
  Write: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Bash: 'bash',
  BashOutput: 'bash',
  KillShell: 'bash',
  KillBash: 'bash',
  Monitor: 'bash',
  PowerShell: 'bash',
  WebSearch: 'web',
  WebFetch: 'web',
  Agent: 'agent',
  Task: 'agent',
  Workflow: 'agent',
  SendMessage: 'agent',
  TaskStop: 'agent',
  TaskOutput: 'agent',
  ListAgents: 'agent',
};

/** Araç adından kategori. */
export function categoryOf(name: string): ToolCategory {
  const known = TOOL_CATEGORY_OF[name];
  if (known) return known;
  if (name.startsWith('mcp__claude-in-chrome__') || name.startsWith('mcp__computer') || name === 'computer') {
    return 'browser';
  }
  if (name.startsWith('mcp__')) return 'mcp';
  return 'plan';
}

export const STATUS_COLOR: Readonly<Record<SessionStatus, string>> = {
  busy: '#5EB3FF',
  waiting: '#F2B134',
  idle: '#4CC38A',
  ended: '#5A6478',
};
export const SLOW_COLOR = '#FF7A6B';

export const CATEGORY_COLOR: Readonly<Record<ToolCategory, string>> = {
  read: '#5EB3FF',
  search: '#5EB3FF',
  edit: '#C98BFF',
  bash: '#FF9F5A',
  web: '#4CC38A',
  browser: '#7DD3C0',
  agent: '#E4E8EF',
  mcp: '#A5B4FC',
  plan: '#8A94A6',
};

export const THRESHOLDS = {
  slowToolMs: 180_000,
  ctxWarnRatio: 0.8,
  conflictWindowMs: 1_200_000,
  endedVisibleMs: 1_800_000,
  subagentVisibleMs: 900_000,
  logRingSize: 300,
  eventBatchMs: 120,
  snapshotThrottleMs: 1000,
} as const;

export const EMBLEMS: readonly EmblemKind[] = ['team', 'ring', 'stack', 'wave', 'prism', 'cube'];

/** Durum ve kategori renkleriyle karışmayan proje tonları. */
export const PROJECT_PALETTE: readonly string[] = ['#F0A6CA', '#7DD3C0', '#A5B4FC', '#C4E17F', '#F5C29A', '#B8D8F5'];
