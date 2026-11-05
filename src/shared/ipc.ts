// Tipli IPC kontratı
import type {
  AppSettings,
  BackgroundHistoryItem,
  BoardEvent,
  BoardSnapshot,
  HookInstallStatus,
  ShortcutReport,
  TerminalApp,
  TerminalCapability,
} from './types';
import type { SettingsPatch } from './settings';

export type IpcErrorCode = 'BAD_INPUT' | 'NOT_FOUND' | 'NOT_IMPLEMENTED' | 'PERMISSION' | 'INTERNAL';
export interface IpcError {
  code: IpcErrorCode;
  message: string;
}
/** Renderer'ın try/catch'e mahkum kalmaması için tüm invoke'lar bu sonucu döner. */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcError };

export const ok = <T>(data: T): IpcResult<T> => ({ ok: true, data });
export const fail = (code: IpcErrorCode, message: string): IpcResult<never> => ({ ok: false, error: { code, message } });

/** Toast eylemleri: renderer yalnızca kimliği geri gönderir; açılacak adres main'de sabittir. */
export type ToastActionId = 'open-automation-settings' | 'open-notification-settings';
export interface ToastAction {
  id: ToastActionId;
  label: string;
}
export const TOAST_ACTION_IDS: readonly ToastActionId[] = ['open-automation-settings', 'open-notification-settings'];

/**
 * Menü çubuğu açılır listesinin (06/01) main'den istediği eylemler. `showOnMap` ve `openInApp` (07/01) session kimliği ister.
 * Renderer yalnızca komut adını gönderir; ne yapılacağı main'de sabittir.
 */
export type TrayCommand = 'close' | 'openBoard' | 'openSettings' | 'quit' | 'showOnMap' | 'openInApp';
export const TRAY_COMMANDS: readonly TrayCommand[] = ['close', 'openBoard', 'openSettings', 'quit', 'showOnMap', 'openInApp'];

/**
 * 3B haritanın çizim döngüsü ölçümü (05/02): renderer ~2 sn'de bir gönderir, main yalnızca ölçüm açıkken
 * (DIJI_PERF=1) kullanır. Yalnızca sayı içerir.
 */
export interface RendererPerfSample {
  /** Moda göre çizilen kare sayısı (aktif ≈60 fps, ortam 15 fps, boşta 4 fps). */
  frames: { active: number; ambient: number; idle: number };
  /** Moda göre geçen süre (ms); `stopped` = sayfa gizli / bağlam kayıp. */
  ms: { active: number; ambient: number; idle: number; stopped: number };
  frameMsAvg: number;
  frameMsMax: number;
  /** three.js renderer.info: son karedeki çizim çağrısı, bellekteki geometri ve texture sayısı. */
  calls: number;
  geometries: number;
  textures: number;
  /** GPU'da olup sahnede ya da paylaşılan önbellekte olmayan geometriler (sızıntı ölçüsü; eski renderer'da yok). */
  orphanGeometries?: number;
  jsHeapMb: number | null;
}

/** renderer → main istek/cevap kanalları. */
export interface IpcInvokeMap {
  'board:getSnapshot': { args: []; result: IpcResult<BoardSnapshot> };
  'action:focusTerminal': { args: [sessionId: string]; result: IpcResult<{ app: TerminalApp }> };
  'action:revealProject': { args: [projectId: string]; result: IpcResult<null> };
  'settings:get': { args: []; result: IpcResult<AppSettings> };
  /** Yama: derin birleşir; `projects[root] = null` kaydı siler (00/04). */
  'settings:set': { args: [patch: SettingsPatch]; result: IpcResult<AppSettings> };
  'settings:pickDirectory': { args: []; result: IpcResult<string | null> };
  'hooks:status': { args: []; result: IpcResult<HookInstallStatus> };
  'hooks:install': { args: []; result: IpcResult<HookInstallStatus> };
  'hooks:uninstall': { args: []; result: IpcResult<HookInstallStatus> };
  'window:setAlwaysOnTop': { args: [on: boolean]; result: IpcResult<boolean> };
  /** Toast'taki eylem düğmesi (04/01, 04/02): main sabit bir sistem ayarı sayfasını açar. */
  'app:toastAction': { args: [id: ToastActionId]; result: IpcResult<null> };
  /** Global kısayolların kayıt durumu (04/03): ayarlar panelinde kırmızı işaret için. */
  'shortcuts:status': { args: []; result: IpcResult<ShortcutReport> };
  /** Çizim döngüsü ölçümü (05/02). `false` → ölçüm kapalı, renderer göndermeyi bırakır. */
  'perf:renderer': { args: [sample: RendererPerfSample]; result: IpcResult<boolean> };
  /** Menü çubuğu açılır listesi (06/01): kapat, panoyu aç, ayarlar, çıkış, haritada göster. */
  'tray:command': { args: [cmd: TrayCommand, sessionId?: string]; result: IpcResult<null> };
  /** Gömülü terminal (07/01): kullanılabilirlik ve yeniden deneme (claude yolu değişince). */
  'terminal:capability': { args: []; result: IpcResult<TerminalCapability> };
  'terminal:retry': { args: []; result: IpcResult<TerminalCapability> };
  /** Arka plan session'ını uygulamada açar; aynı session için açık sekme varsa onu döndürür (`reused`). */
  'term:open': { args: [sessionId: string, cols: number, rows: number]; result: IpcResult<TermOpenResult> };
  /** Kullanıcının xterm girdisi (≤ 64 KB). Uygulama kendiliğinden yazmaz. */
  'term:write': { args: [termId: string, data: string]; result: IpcResult<null> };
  'term:resize': { args: [termId: string, cols: number, rows: number]; result: IpcResult<null> };
  /** Yalnızca uygulamanın attach istemcisini kapatır; session çalışmaya devam eder. */
  'term:close': { args: [termId: string]; result: IpcResult<null> };
  /** Sekmeye dönüldü: session'ı bu sekmenin boyutuyla yeniden çizdir (başka terminal de bağlıysa). */
  'term:redraw': { args: [termId: string]; result: IpcResult<null> };
  /** Bilinen bir proje kökünde `claude --bg [görev]` başlatır. */
  'session:newBackground': { args: [cwd: string, task: string | null]; result: IpcResult<{ bgId: string }> };
  /** "Yeni oturum" için klasör seçme penceresi; seçilen klasör 10 dk boyunca `session:newBackground`'a izinli. */
  'session:pickProjectDir': { args: []; result: IpcResult<string | null> };
  /** "Session'ı kapat": çalışıyorsa `claude stop <id>`, sonra haritadan kaldırılır (kalıcı); sekmesi de kapanır. */
  'session:stopBackground': { args: [sessionId: string]; result: IpcResult<{ termId: string | null }> };
  /** Geçmiş tablosu: haritada olmayan arka plan session'ları (liste önce tazelenir). */
  'session:history': { args: []; result: IpcResult<BackgroundHistoryItem[]> };
  /** Geçmişten yeniden aktif et (haritaya döner); renderer ardından `term:open` ile açar. */
  'session:restoreBackground': { args: [bgId: string]; result: IpcResult<{ sessionId: string }> };
  /** 09/01: yalnızca şema içeren uyumluluk raporunu panoya yazar. */
  'compat:copyReport': { args: []; result: IpcResult<null> };
  /** 09/01: raporla önceden doldurulmuş GitHub issue'yu tarayıcıda açar (rapor ayrıca panoya yazılır). */
  'compat:openIssue': { args: []; result: IpcResult<{ truncated: boolean }> };
}

/** `term:open` sonucu. */
export interface TermOpenResult {
  termId: string;
  sessionId: string;
  /** Aynı session için zaten açık bir sekme vardı. */
  reused: boolean;
}

/** Attach istemcisinin neden kapandığı (07/01). */
export type TermExitReason = 'closed' | 'not-found' | 'taken-over' | 'exited' | 'spawn-failed';

/** main → renderer olay kanalları. */
export interface IpcEventMap {
  'board:snapshot': BoardSnapshot;
  'board:events': BoardEvent[];
  'app:toast': { level: 'info' | 'warn' | 'error'; message: string; action?: ToastAction };
  'ui:selectSession': { sessionId: string };
  'settings:changed': AppSettings;
  /** Menüden Ayarlar… (⌘,): renderer ayarlar panelini açar (00/04). */
  'ui:openSettings': null;
  /** Kısayollar yeniden kaydedildi (04/03). */
  'shortcuts:report': ShortcutReport;
  /** Gömülü terminal akışı (07/01): yalnızca ana pencereye, birleştirilmiş parçalar. */
  'term:data': { termId: string; data: string };
  'term:exit': { termId: string; reason: TermExitReason; code: number | null };
  'terminal:capability': TerminalCapability;
  /** Menü çubuğundan "App'te aç": renderer sekmeyi kendi boyutuyla açar. */
  'ui:openInApp': { sessionId: string };
  /** Uygulama menüsündeki Terminal komutları (⌘J, ⇧⌘J, ⇧⌘W, ⇧⌘[ / ⇧⌘]). */
  'ui:terminalCommand': TerminalCommand;
}

/** Menüden gelen terminal paneli komutları (07/01). */
export type TerminalCommand = 'toggle' | 'toggleLayout' | 'closeTab' | 'nextTab' | 'prevTab';

export type InvokeChannel = keyof IpcInvokeMap;
export type EventChannel = keyof IpcEventMap;

export const IPC_CHANNELS = {
  invoke: [
    'board:getSnapshot',
    'action:focusTerminal',
    'action:revealProject',
    'settings:get',
    'settings:set',
    'settings:pickDirectory',
    'hooks:status',
    'hooks:install',
    'hooks:uninstall',
    'window:setAlwaysOnTop',
    'app:toastAction',
    'shortcuts:status',
    'perf:renderer',
    'tray:command',
    'terminal:capability',
    'terminal:retry',
    'term:open',
    'term:write',
    'term:resize',
    'term:close',
    'term:redraw',
    'session:newBackground',
    'session:pickProjectDir',
    'session:stopBackground',
    'session:history',
    'session:restoreBackground',
    'compat:copyReport',
    'compat:openIssue',
  ] as const satisfies readonly InvokeChannel[],
  events: [
    'board:snapshot',
    'board:events',
    'app:toast',
    'ui:selectSession',
    'settings:changed',
    'ui:openSettings',
    'shortcuts:report',
    'term:data',
    'term:exit',
    'terminal:capability',
    'ui:openInApp',
    'ui:terminalCommand',
  ] as const satisfies readonly EventChannel[],
};

/** Preload'un window.diji olarak açtığı API. */
export interface DijiApi {
  invoke<K extends InvokeChannel>(channel: K, ...args: IpcInvokeMap[K]['args']): Promise<IpcInvokeMap[K]['result']>;
  on<K extends EventChannel>(channel: K, cb: (payload: IpcEventMap[K]) => void): () => void;
}

/** Session kimliği biçimi (UUID). IPC girdilerini doğrulamak için. */
export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Arka plan session kimliği (`claude attach <id>`, registry `jobId`) — 07/01. */
export const BG_ID_RE = /^[0-9a-f]{8}$/i;
/** Uygulamanın terminal sekmesi kimliği. */
export const TERM_ID_RE = /^t-[0-9a-f]{8}$/;
/** Terminal girdi/boyut sınırları (07/01). */
export const TERM_WRITE_MAX = 64 * 1024;
export const TERM_DIM_MIN = 10;
export const TERM_DIM_MAX = 500;
export const BG_TASK_MAX = 2000;
