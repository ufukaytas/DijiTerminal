// Tip imzaları: hooks/lib/installer.mjs
// HookInstallStatus, src/shared/types.ts'teki tanımla yapısal olarak aynıdır (00/02); Faz 2'de
// tests/hooks/installer-types.test.ts ikisinin uyumunu derleme zamanında doğrular.

export interface HookInstallStatus {
  installed: boolean;
  statusLine: 'none' | 'ours' | 'chained' | 'foreign';
  settingsPath: string;
  backupPath: string | null;
}

export interface InstallOptions {
  configDir?: string | null;
  dataDir?: string;
  sourceDir: string;
  statusLine?: 'auto' | 'skip';
  dryRun?: boolean;
}

export interface ChainRecord {
  command: string;
  padding?: number;
  original?: Record<string, unknown>;
}

export interface PlanResult {
  next: Record<string, unknown>;
  changes: string[];
  statusLineMode: 'none' | 'ours' | 'chained' | 'foreign';
  chain: ChainRecord | null;
}

export declare const HOOK_EVENTS: readonly [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'Notification', 'Stop', 'SubagentStop', 'SessionEnd',
];

export declare class InstallError extends Error {
  code: 'INVALID_JSON' | 'NOT_WRITABLE' | 'SOURCE_MISSING';
  constructor(code: InstallError['code'], message: string);
}

export declare function resolveSettingsPath(o?: { configDir?: string | null }): string;
export declare function resolveDataDir(o?: { dataDir?: string }): string;
export declare function shellQuote(s: string): string;
export declare function isOurs(entry: unknown): boolean;
export declare function readSettings(file: string): { exists: boolean; raw: string | null; json: Record<string, unknown> };
export declare function plan(
  json: Record<string, unknown>,
  o: { hookCommand: string; statusCommand: string; statusLine: 'auto' | 'skip'; existingChain?: boolean },
): PlanResult;
export declare function planUninstall(
  json: Record<string, unknown>,
  o?: { chain?: ChainRecord | null },
): { next: Record<string, unknown>; changes: string[] };
export declare function status(o?: { configDir?: string | null; dataDir?: string }): HookInstallStatus;
export declare function install(o: InstallOptions): Promise<{ status: HookInstallStatus; changes: string[] }>;
export declare function uninstall(o: InstallOptions): Promise<{ status: HookInstallStatus; changes: string[] }>;
