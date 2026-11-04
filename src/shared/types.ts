// Ortak domain tipleri
// Bu dosya saf TypeScript'tir: main, preload ve renderer aynı tipleri paylaşır.
// Alan adları diğer brief'lerde referans alınır; değiştirmeden önce brief'leri güncelleyin.

/** Bir session'ın UI'daki durumu. */
export type SessionStatus = 'busy' | 'waiting' | 'idle' | 'ended';
/** Araçların renk ve ikon kategorisi (constants.ts → categoryOf). */
export type ToolCategory = 'read' | 'search' | 'edit' | 'bash' | 'web' | 'browser' | 'agent' | 'mcp' | 'plan';
/** Session kartında gösterilen uyarı bayrakları. */
export type SessionFlag = 'slow-tool' | 'ctx-80' | 'loop-suspect' | 'conflict';
/** 3B haritadaki proje amblemi. */
export type EmblemKind = 'team' | 'ring' | 'stack' | 'wave' | 'prism' | 'cube';
/** Claude sürecinin çalıştığı terminal. */
export type TerminalApp = 'iterm2' | 'terminal' | 'other' | 'unknown';

/** Sonuçlanmış ya da süren tek bir araç çağrısı. */
export interface ToolCall {
  id: string; // tool_use_id
  sessionId: string;
  agentId: string | null; // null = ana ajan
  name: string; // 'Edit', 'Bash', 'mcp__x__y'
  category: ToolCategory;
  label: string; // kısa, insan okunur özet — en fazla 160 karakter
  file?: string; // read/edit için mutlak yol
  startedAt: number;
  endedAt?: number;
  ok?: boolean;
  durationMs?: number;
  meta?: string; // '200 · 41 KB', '8 sonuç', 'interrupted'
}

/** Bir session'daki ana ajan ya da subagent. */
export interface AgentView {
  id: string; // ana ajan için 'main'
  sessionId: string;
  isMain: boolean;
  name: string;
  agentType: string;
  team: string | null;
  model: string;
  background: boolean;
  running: boolean;
  done: boolean;
  current: ToolCall | null;
  toolCount: number;
  errorCount: number;
  costUsd: number;
  firstTs: number;
  lastTs: number;
  doneAt: number | null;
  loopSuspect: boolean;
}

/** Session'ın neyi beklediği (onay penceresi). */
export interface WaitingInfo {
  tool: string;
  label: string;
  since: number;
}

/** Claude sürecinin terminali. */
export interface TerminalRef {
  app: TerminalApp;
  tty: string | null; // '/dev/ttys004'
  pid: number; // claude sürecinin pid'i
}

/**
 * Arka plan session'ı (07/01): `claude --bg` ya da `/bg` ile başlatılmış, terminali Claude Code'un arka plan
 * servisinde duran session. `claude attach <id>` ile herhangi bir pty'ye bağlanabilir (son bağlanan devralır).
 */
export type BackgroundState = 'running' | 'blocked' | 'done' | 'failed' | 'stopped' | (string & {});
export interface BackgroundInfo {
  /** `claude attach` kimliği (8 hex) — registry'deki `jobId`. */
  id: string;
  /** `claude agents --json` `state`; henüz okunmadıysa null. */
  state: BackgroundState | null;
}

/**
 * Geçmiş tablosu (07/01): haritada olmayan arka plan session'ı. `reason`: closed = kullanıcı kapattı,
 * stopped = `claude stop`, failed = başarısız, old = 24 saatten eski bitmiş.
 */
export interface BackgroundHistoryItem {
  id: string;
  sessionId: string;
  name: string;
  /** Claude'un başlığı ya da son istek (redakte, kısa); bilinmiyorsa boş. */
  title: string;
  cwd: string;
  projectId: string | null;
  state: BackgroundState | null;
  reason: 'closed' | 'stopped' | 'failed' | 'old';
  startedAt: number | null;
  lastTs: number | null;
  /** `claude attach` ile yeniden açılabilir (kimlik + klasör var). */
  restorable: boolean;
}

/** Gömülü terminalin kullanılabilirliği (07/01): ayarlar paneli ve "App'te aç" düğmesi bunu okur. */
export interface TerminalCapability {
  available: boolean;
  reason: 'ok' | 'disabled' | 'not-found' | 'unsupported' | 'demo' | 'error' | 'pending';
  claudePath: string | null;
  claudeVersion: string | null;
  /** Kullanıcıya gösterilecek kısa açıklama (yalnızca reason !== 'ok'). */
  detail: string | null;
}

/** UI'ın gördüğü session. */
export interface SessionView {
  id: string;
  pid: number | null;
  live: boolean;
  name: string;
  title: string;
  lastPrompt: string; // en fazla 220 karakter, redakte edilmiş
  cwd: string;
  projectId: string;
  branch: string | null;
  worktree: string | null;
  model: string;
  effort: string | null;
  status: SessionStatus;
  statusSince: number;
  waitingFor: WaitingInfo | null;
  ctxTokens: number;
  ctxMax: number;
  ctxRatio: number; // 0..1
  costUsd: number; // bugün
  toolCount: number;
  errorCount: number;
  flags: SessionFlag[];
  agents: AgentView[]; // ilk eleman her zaman ana ajan
  terminal: TerminalRef | null;
  /** null → etkileşimli (iTerm2) session; dolu → arka plan session'ı, uygulamada açılabilir (07/01). */
  background: BackgroundInfo | null;
  hotkey: number | null; // 1..9
  startedAt: number;
  lastTs: number;
  cpuPct: number | null;
  memMb: number | null;
}

/** Son 20 dakikada aynı dosyaya birden çok session'ın yazması. */
export interface FileConflict {
  path: string;
  projectId: string;
  sessionIds: string[];
  lastTs: number;
}

/** Bir dosyanın okuma/yazma ısısı. */
export interface FileHeat {
  path: string; // mutlak
  projectId: string;
  reads: number;
  writes: number;
  lastTs: number;
  editors: { sessionId: string; agentId: string | null; ts: number }[];
}

/** Bir git kökü; worktree'ler dahil. */
export interface ProjectView {
  id: string; // git kökünün mutlak yolunun kısa hash'i
  root: string;
  name: string;
  displayPath: string; // '~/Projects/youcms'
  color: string;
  emblem: EmblemKind;
  tag: string | null; // 'agent takımı'
  sessionIds: string[];
  costUsd: number;
  conflicts: FileConflict[];
  hotFiles: FileHeat[]; // en sıcak 8 dosya
}

export type LogKind = 'tool' | 'prompt' | 'say' | 'sys' | 'agent';
export type LogState = 'run' | 'ok' | 'err' | 'wait';

/** session.log satırı. */
export interface LogEntry {
  id: string;
  ts: number;
  sessionId: string;
  agentId: string | null;
  kind: LogKind;
  category: ToolCategory | null;
  toolName: string | null;
  label: string;
  state: LogState;
  durationMs: number | null;
}

/** Kullanım limiti penceresi. */
export interface LimitWindow {
  pct: number;
  resetsAt: number;
}
/** 5 saatlik ve haftalık limitler (statusLine'dan). */
export interface UsageLimits {
  fiveHour: LimitWindow | null;
  week: LimitWindow | null;
  at: number;
}

/** Üst bar sayaçları. */
export interface BoardTotals {
  projects: number;
  liveSessions: number;
  waiting: number;
  runningAgents: number;
  conflicts: number;
  slowTools: number;
  toolsPerMin: number;
  costTodayUsd: number;
}

/** Motorun renderer'a gönderdiği tam durum. */
export interface BoardSnapshot {
  at: number;
  booted: boolean;
  dayStart: number;
  projects: ProjectView[];
  sessions: SessionView[]; // sıralama: waiting → busy → idle → ended, sonra lastTs desc
  log: LogEntry[]; // en yeni önce
  limits: UsageLimits | null;
  totals: BoardTotals;
  /**
   * 02/09 hızlı durum (hook olayları): 'active' okunuyor, 'missing' hook dosyası yok (hook'lar kurulu değil),
   * 'error' okunamıyor, 'off' bu motorda yok (demo). Eski snapshot'larda alan olmayabilir.
   */
  fastStatus?: 'active' | 'missing' | 'error' | 'off';
}

/** 3B efektler ve anlık UI tepkileri için olay akışı. */
export type BoardEvent =
  | { type: 'tool-start'; call: ToolCall }
  | { type: 'tool-end'; call: ToolCall }
  | { type: 'agent-spawn'; sessionId: string; agent: AgentView; parentAgentId: string | null }
  | { type: 'agent-done'; sessionId: string; agentId: string }
  | { type: 'status'; sessionId: string; from: SessionStatus | null; to: SessionStatus; at: number }
  | { type: 'prompt'; sessionId: string; label: string; at: number }
  | {
      type: 'file-touch';
      projectId: string;
      path: string;
      sessionId: string;
      agentId: string | null;
      write: boolean;
      at: number;
    }
  | { type: 'conflict'; conflict: FileConflict };

/** Kullanıcı ayarları (00/04 saklar ve doğrular). */
export interface AppSettings {
  claudeConfigDir: string | null; // null = $CLAUDE_CONFIG_DIR ya da ~/.claude
  alwaysOnTop: boolean;
  launchAtLogin: boolean;
  notifications: { waiting: boolean; done: boolean; slowTool: boolean; sound: boolean; redactLabels: boolean };
  shortcuts: {
    enabled: boolean;
    focusWaiting: string; // Electron accelerator, ör. 'Control+Alt+W'
    toggleBoard: string;
    sessionPrefix: string; // 'Control+Alt' → +1..9
  };
  projects: Record<string, { alias?: string; color?: string; emblem?: EmblemKind; hidden?: boolean }>; // anahtar: git kökü
  reducedMotion: 'system' | 'on' | 'off';
  /** 3B harita çizim kalitesi: 'balanced' Retina'da piksel oranını 1.5'te sınırlar (daha az GPU işi; Mac'te ölçülen RSS'e etkisi yok). */
  renderQuality: 'high' | 'balanced';
  /**
   * Menü çubuğu modu (06/01): `enabled` → menü çubuğu ikonu ve açılır liste; `hideDock` → Dock ikonu gizlenir,
   * uygulama yalnızca menü çubuğundan açılır. `hideDock` yalnızca `enabled` açıkken uygulanır.
   */
  menuBar: { enabled: boolean; hideDock: boolean };
  /**
   * Gömülü terminal (07/01): `enabled` → arka plan session'ları uygulamada açılabilir; `claudePath` null → otomatik
   * bulunur; `fontSize` 11–18.
   */
  terminal: { enabled: boolean; claudePath: string | null; fontSize: number };
}

/** Hook/statusLine kurulum durumu (01/02). */
export interface HookInstallStatus {
  installed: boolean;
  statusLine: 'none' | 'ours' | 'chained' | 'foreign';
  settingsPath: string;
  backupPath: string | null;
}

/** hook-events.jsonl satırı (01/01 yazar, 02/09 okur). */
export interface HookEventLine {
  v: 1;
  ts: number;
  event: string; // Claude Code hook_event_name
  sessionId: string;
  cwd: string;
  tty: string | null;
  claudePid: number;
  tool?: string;
  message?: string; // en fazla 200 karakter
  notificationType?: string;
}

/** Global kısayol komutları (04/03). */
export type ShortcutCommand = 'focusWaiting' | 'toggleBoard' | `session-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;
/**
 * Kayıt sonucu: `conflict` → macOS/başka uygulama kısayolu tutuyor (register false);
 * `duplicate` → aynı accelerator DijiTerminal'in başka bir komutuna atanmış; `invalid` → biçim geçersiz.
 */
export interface ShortcutReportItem {
  command: ShortcutCommand;
  accelerator: string;
  registered: boolean;
  reason?: 'conflict' | 'duplicate' | 'invalid';
}
export interface ShortcutReport {
  enabled: boolean;
  items: ShortcutReportItem[];
}
