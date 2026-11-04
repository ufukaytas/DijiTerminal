// Elle yazılmış örnek BoardSnapshot — gerçek veri içermez (demo projeler, uydurma yollar).
// Renderer testleri ve Playwright ekran görüntüsü bunu kullanır.
import type { AgentView, BoardSnapshot, LogEntry, ProjectView, SessionView, ToolCall } from '@shared/types';

export const IDS = {
  waiting: '11111111-1111-4111-8111-111111111111',
  team: '22222222-2222-4222-8222-222222222222',
  idle: '33333333-3333-4333-8333-333333333333',
  busy: '44444444-4444-4444-8444-444444444444',
  ended: '55555555-5555-4555-8555-555555555555',
  waiting2: '66666666-6666-4666-8666-666666666666',
} as const;

function call(
  sessionId: string,
  agentId: string | null,
  name: string,
  category: ToolCall['category'],
  label: string,
  startedAt: number,
  file?: string,
): ToolCall {
  return {
    id: `toolu_${sessionId.slice(0, 4)}_${startedAt}`,
    sessionId,
    agentId,
    name,
    category,
    label,
    startedAt,
    ...(file ? { file } : {}),
  };
}

function agent(sessionId: string, o: Partial<AgentView> & Pick<AgentView, 'id' | 'name'>, now: number): AgentView {
  const isMain = o.id === 'main';
  return {
    sessionId,
    isMain,
    agentType: isMain ? 'main' : 'general-purpose',
    team: null,
    model: 'opus',
    background: false,
    running: true,
    done: false,
    current: null,
    toolCount: 0,
    errorCount: 0,
    costUsd: 0,
    firstTs: now - 3_600_000,
    lastTs: now - 5_000,
    doneAt: null,
    loopSuspect: false,
    ...o,
  };
}

function session(
  o: Partial<SessionView> & Pick<SessionView, 'id' | 'name' | 'projectId' | 'status' | 'agents'>,
  now: number,
): SessionView {
  return {
    pid: 40000,
    live: o.status !== 'ended',
    title: o.name,
    lastPrompt: '',
    cwd: '/Users/demo/Projects/demo',
    branch: 'main',
    worktree: null,
    model: 'opus-4.7',
    effort: null,
    statusSince: now - 60_000,
    waitingFor: null,
    ctxTokens: 120_000,
    ctxMax: 200_000,
    ctxRatio: 0.6,
    costUsd: 1.2,
    toolCount: 30,
    errorCount: 0,
    flags: [],
    terminal: { app: 'iterm2', tty: '/dev/ttys004', pid: 40000 },
    background: null,
    hotkey: null,
    startedAt: now - 2 * 3_600_000,
    lastTs: now - 2_000,
    cpuPct: null,
    memMb: null,
    ...o,
  };
}

export function makeSnapshot(now = Date.now()): BoardSnapshot {
  const projects: ProjectView[] = [
    {
      id: 'p1demoapp',
      root: '/Users/demo/Projects/demo-app',
      name: 'demo-app',
      displayPath: '~/Projects/demo-app',
      color: '#F0A6CA',
      emblem: 'ring',
      tag: null,
      sessionIds: [IDS.waiting, IDS.busy, IDS.ended],
      costUsd: 4.12,
      conflicts: [],
      hotFiles: [],
    },
    {
      id: 'p2agents',
      root: '/Users/demo/Projects/agent-lab',
      name: 'agent-lab',
      displayPath: '~/Projects/agent-lab',
      color: '#7DD3C0',
      emblem: 'team',
      tag: 'agent takımı',
      sessionIds: [IDS.team],
      costUsd: 6.4,
      conflicts: [
        {
          path: '/Users/demo/Projects/agent-lab/src/plan.md',
          projectId: 'p2agents',
          sessionIds: [IDS.team, IDS.idle],
          lastTs: now - 60_000,
        },
      ],
      hotFiles: [],
    },
    {
      id: 'p3docs',
      root: '/Users/demo/Projects/docs-site',
      name: 'docs-site',
      displayPath: '~/Projects/docs-site',
      color: '#A5B4FC',
      emblem: 'stack',
      tag: null,
      sessionIds: [IDS.idle, IDS.waiting2],
      costUsd: 0.88,
      conflicts: [],
      hotFiles: [],
    },
  ];

  const sessions: SessionView[] = [
    session(
      {
        id: IDS.waiting,
        name: 'ödeme akışı',
        projectId: 'p1demoapp',
        status: 'waiting',
        statusSince: now - 95_000,
        waitingFor: { tool: 'Bash', label: 'npm run migrate -- --env staging', since: now - 95_000 },
        lastPrompt: 'Stripe webhook doğrulamasını ekle ve testleri çalıştır',
        hotkey: 1,
        branch: 'feat/payments',
        effort: 'high',
        agents: [agent(IDS.waiting, { id: 'main', name: 'ana ajan', toolCount: 41, costUsd: 2.1 }, now)],
      },
      now,
    ),
    session(
      {
        id: IDS.team,
        name: 'pazar araştırması',
        projectId: 'p2agents',
        status: 'busy',
        statusSince: now - 600_000,
        lastPrompt: 'Takımı çalıştır: rakip analizi ve özet rapor',
        hotkey: 2,
        ctxTokens: 168_000,
        ctxRatio: 0.84,
        flags: ['ctx-80', 'conflict'],
        costUsd: 6.4,
        agents: [
          agent(IDS.team, { id: 'main', name: 'ana ajan', toolCount: 12 }, now),
          agent(
            IDS.team,
            {
              id: 'a1',
              name: 'audience-seo-researcher',
              team: 'audience',
              agentType: 'audience-seo-researcher',
              model: 'sonnet',
              toolCount: 18,
              current: call(IDS.team, 'a1', 'WebSearch', 'web', 'rakip fiyatlandırma 2026', now - 12_000),
            },
            now,
          ),
          agent(
            IDS.team,
            {
              id: 'a2',
              name: 'audience-persona-writer',
              team: 'audience',
              agentType: 'audience-persona-writer',
              model: 'sonnet',
              toolCount: 9,
              current: call(IDS.team, 'a2', 'Bash', 'bash', 'python scripts/scrape.py --all', now - 200_000),
            },
            now,
          ),
          agent(
            IDS.team,
            {
              id: 'a3',
              name: 'Explore',
              agentType: 'Explore',
              model: 'haiku',
              toolCount: 22,
              running: false,
              done: true,
              doneAt: now - 300_000,
            },
            now,
          ),
        ],
      },
      now,
    ),
    session(
      {
        id: IDS.busy,
        name: 'api refaktör',
        projectId: 'p1demoapp',
        status: 'busy',
        statusSince: now - 30_000,
        hotkey: 3,
        ctxRatio: 0.32,
        ctxTokens: 64_000,
        agents: [
          agent(
            IDS.busy,
            {
              id: 'main',
              name: 'ana ajan',
              toolCount: 57,
              current: call(
                IDS.busy,
                null,
                'Edit',
                'edit',
                'src/api/orders.ts',
                now - 4_000,
                '/Users/demo/Projects/demo-app/src/api/orders.ts',
              ),
            },
            now,
          ),
        ],
      },
      now,
    ),
    session(
      {
        id: IDS.idle,
        name: 'docs düzeltmeleri',
        projectId: 'p3docs',
        status: 'idle',
        statusSince: now - 420_000,
        hotkey: 4,
        terminal: null,
        ctxRatio: 0.12,
        ctxTokens: 24_000,
        costUsd: 0.4,
        agents: [agent(IDS.idle, { id: 'main', name: 'ana ajan', running: false, toolCount: 14 }, now)],
      },
      now,
    ),
    session(
      {
        id: IDS.waiting2,
        name: 'blog taslağı',
        projectId: 'p3docs',
        status: 'waiting',
        statusSince: now - 20_000,
        waitingFor: { tool: 'ExitPlanMode', label: 'plan onayı', since: now - 20_000 },
        hotkey: 5,
        agents: [agent(IDS.waiting2, { id: 'main', name: 'ana ajan', toolCount: 6 }, now)],
      },
      now,
    ),
    session(
      {
        id: IDS.ended,
        name: 'eski deneme',
        projectId: 'p1demoapp',
        status: 'ended',
        live: false,
        statusSince: now - 900_000,
        agents: [agent(IDS.ended, { id: 'main', name: 'ana ajan', running: false, done: true }, now)],
      },
      now,
    ),
  ];

  const tools: [string, LogEntry['category'], string, string][] = [
    ['Read', 'read', 'src/api/orders.ts', IDS.busy],
    ['Grep', 'search', '"webhook" in src/', IDS.waiting],
    ['Edit', 'edit', 'src/payments/stripe.ts', IDS.waiting],
    ['Bash', 'bash', 'npm test -- payments', IDS.waiting],
    ['WebFetch', 'web', 'https://example.com/pricing', IDS.team],
    ['Write', 'edit', 'docs/guide/intro.md', IDS.idle],
    ['Glob', 'search', 'src/**/*.test.ts', IDS.busy],
    ['mcp__notion__search', 'mcp', 'roadmap Q4', IDS.team],
  ];
  const log: LogEntry[] = [];
  log.push({
    id: 'l-run-1',
    ts: now - 4_000,
    sessionId: IDS.busy,
    agentId: null,
    kind: 'tool',
    category: 'edit',
    toolName: 'Edit',
    label: 'src/api/orders.ts',
    state: 'run',
    durationMs: null,
  });
  log.push({
    id: 'l-wait-1',
    ts: now - 20_000,
    sessionId: IDS.waiting2,
    agentId: null,
    kind: 'tool',
    category: 'plan',
    toolName: 'ExitPlanMode',
    label: 'plan onayı',
    state: 'wait',
    durationMs: null,
  });
  log.push({
    id: 'l-run-2',
    ts: now - 200_000,
    sessionId: IDS.team,
    agentId: 'a2',
    kind: 'tool',
    category: 'bash',
    toolName: 'Bash',
    label: 'python scripts/scrape.py --all',
    state: 'run',
    durationMs: null,
  });
  log.push({
    id: 'l-say-1',
    ts: now - 210_000,
    sessionId: IDS.team,
    agentId: null,
    kind: 'say',
    category: null,
    toolName: null,
    label: 'Üç alt ajanı başlatıyorum, sonuçları birleştireceğim.',
    state: 'ok',
    durationMs: null,
  });
  log.push({
    id: 'l-err-1',
    ts: now - 230_000,
    sessionId: IDS.waiting,
    agentId: null,
    kind: 'tool',
    category: 'bash',
    toolName: 'Bash',
    label: 'npm run lint',
    state: 'err',
    durationMs: 4_200,
  });
  for (let i = 0; i < 40; i++) {
    const t = tools[i % tools.length]!;
    log.push({
      id: `l-${i}`,
      ts: now - 240_000 - i * 37_000,
      sessionId: t[3],
      agentId: t[3] === IDS.team && i % 2 ? 'a1' : null,
      kind: 'tool',
      category: t[1],
      toolName: t[0],
      label: t[2],
      state: 'ok',
      durationMs: 300 + ((i * 977) % 9000),
    });
  }
  log.push({
    id: 'l-prompt-1',
    ts: now - 2_000_000,
    sessionId: IDS.waiting,
    agentId: null,
    kind: 'prompt',
    category: null,
    toolName: null,
    label: 'Stripe webhook doğrulamasını ekle',
    state: 'ok',
    durationMs: null,
  });

  return {
    at: now,
    booted: true,
    dayStart: now - 8 * 3_600_000,
    projects,
    sessions,
    log,
    limits: null,
    totals: {
      projects: 3,
      liveSessions: 5,
      waiting: 2,
      runningAgents: 4,
      conflicts: 1,
      slowTools: 1,
      toolsPerMin: 14,
      costTodayUsd: 11.4,
    },
  };
}
