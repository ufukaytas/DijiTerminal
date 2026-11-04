// Motor ↔ Electron köprüsü — 02/07 Prompt 5 ve 05/01 (DIJI_DEMO).
// Motoru (SessionEngine ya da DemoEngine) kurar, 'board:getSnapshot' handler'ını verir,
// snapshot ve olay çıktısını pencereye yayar. Throttle/batch motorun içindedir (1 sn / 120 ms);
// burada yalnızca iletim yapılır. electron yalnızca bu katmanda import edilir; motor saf Node kalır.
import { app, powerMonitor, type BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fail, ok } from '@shared/ipc';
import type { AppSettings } from '@shared/types';
import type { BoardEngine } from './engine/index';
import { SessionEngine } from './engine/index';
import { DemoEngine } from './engine/demo';
import { AgentsPoller } from './engine/agents';
import type { ClaudeCli } from './engine/claudeCli';
import { ProcessInspector } from './engine/process';
import { broadcast, type IpcHandlers } from './ipc';

export interface EngineHostOptions {
  getWindow: () => BrowserWindow | null;
  /** true → DemoEngine (dosya okumaz). Varsayılan: process.env.DIJI_DEMO === '1'. */
  demo?: boolean;
  /** Ayardaki claudeConfigDir (00/04); null → DIJI_CLAUDE_DIR → CLAUDE_CONFIG_DIR → ~/.claude */
  configDir?: string | null;
  /** Canlı ayarlar (00/04): proje renkleri/amblemleri/gizleme. */
  settings?: () => AppSettings;
  /** 07/01: claude CLI çözücü; verilirse arka plan session'larının state'i `claude agents --json`'dan okunur. */
  cli?: ClaudeCli;
}

export interface EngineHost {
  readonly engine: BoardEngine;
  readonly demo: boolean;
  /** registerIpc'ye birleştirilecek handler'lar. */
  readonly handlers: Pick<IpcHandlers, 'board:getSnapshot'>;
  start(): Promise<void>;
  dispose(): Promise<void>;
}

/** Gömülü terminal kapalıysa ya da claude bulunamadıysa poller CLI çağırmaz (07/01). */
function agentsPoller(cli: ClaudeCli, settings: (() => AppSettings) | undefined): AgentsPoller {
  return new AgentsPoller({
    cli: async () => {
      if (settings && !settings().terminal.enabled) return null;
      const r = await cli.resolve();
      return r.ok ? r.cli : null;
    },
  });
}

/** 07/01: kullanıcının kapattığı arka plan session kimlikleri (userData). Yalnızca 8 hex kimlikler; içerik yok. */
const DISMISSED_FILE = 'dismissed-background.json';

export function loadDismissed(dir: string): string[] {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dir, DISMISSED_FILE), 'utf8')) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && /^[0-9a-f]{8}$/i.test(x)) : [];
  } catch {
    return [];
  }
}

export function saveDismissed(dir: string, ids: string[]): void {
  const file = path.join(dir, DISMISSED_FILE);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ids), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function createEngineHost(opts: EngineHostOptions): EngineHost {
  const demo = opts.demo ?? process.env['DIJI_DEMO'] === '1';
  const dataDir = app.getPath('userData');
  const engine: BoardEngine = demo
    ? new DemoEngine()
    : new SessionEngine({
        configDir: opts.configDir ?? null,
        appDataDir: app.getPath('userData'),
        // 02/09: Faz 1 hook betiğiyle aynı klasör (DIJI_DATA_DIR ile değiştirilebilir).
        hookEventsPath: path.join(process.env['DIJI_DATA_DIR'] || app.getPath('userData'), 'hook-events.jsonl'),
        inspector: new ProcessInspector(), // 02/06: tty + terminal uygulaması (04/01 sekmeye gitme)
        ...(opts.settings ? { settings: opts.settings } : {}),
        ...(opts.cli ? { agents: agentsPoller(opts.cli, opts.settings) } : {}),
        dismissedBackground: loadDismissed(dataDir),
        onDismissedChange: (ids) => saveDismissed(dataDir, ids),
      });

  const unsubs: (() => void)[] = [];
  // Görünmeyen pencereye ne olay akışı ne snapshot gönderilir (05/02): renderer'da efektler ve çizim zaten durur,
  // IPC serileştirmesi ve renderer CPU'su boşa gider. Bildirimler ve Dock rozeti motoru main içinde dinler (04/02).
  // Pencere görünür olunca motor (setTempo('normal')) hemen taze bir snapshot yayınlar.
  const visibleWindow = (): BrowserWindow | null => {
    const w = opts.getWindow();
    return w && !w.isDestroyed() && w.isVisible() && !w.isMinimized() ? w : null;
  };
  unsubs.push(engine.onSnapshot((s) => broadcast(visibleWindow(), 'board:snapshot', s)));
  unsubs.push(engine.onEvents((e) => broadcast(visibleWindow(), 'board:events', e)));

  const onResume = (): void => engine.resume();
  powerMonitor.on('resume', onResume);

  let started: Promise<void> | null = null;

  return {
    engine,
    demo,
    handlers: {
      'board:getSnapshot': async () => {
        try {
          return ok(engine.getSnapshot());
        } catch (e) {
          console.error('[engine-host] getSnapshot:', e);
          return fail('INTERNAL', 'Pano durumu alınamadı.');
        }
      },
    },
    start() {
      started ??= engine.start().catch((e: unknown) => {
        console.error('[engine-host] motor başlatılamadı:', e);
      });
      return started;
    },
    async dispose() {
      powerMonitor.removeListener('resume', onResume);
      for (const u of unsubs.splice(0)) u();
      await engine.stop();
    },
  };
}
