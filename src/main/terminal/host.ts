// Gömülü terminal ↔ IPC köprüsü
// Handler'lar her girdiyi doğrular; renderer yalnızca session kimliği gönderir, attach kimliği ve klasör motordan gelir.
// Electron importu yok (pencere ve diyalog bağımlılık olarak gelir) → Vitest'te test edilebilir.
import {
  BG_ID_RE,
  fail,
  ok,
  SESSION_ID_RE,
  TERM_DIM_MAX,
  TERM_DIM_MIN,
  TERM_ID_RE,
  TERM_WRITE_MAX,
  type IpcEventMap,
} from '@shared/ipc';
import type { AppSettings, TerminalCapability } from '@shared/types';
import type { ClaudeCli, CliExec } from '../engine/claudeCli';
import { realExec } from '../engine/claudeCli';
import type { BoardEngine } from '../engine/index';
import type { IpcHandlers } from '../ipc';
import { startBackground } from './newSession';
import { PtyManager, type PtySpawn } from './ptyManager';

type TerminalChannels =
  | 'terminal:capability'
  | 'terminal:retry'
  | 'term:open'
  | 'term:write'
  | 'term:resize'
  | 'term:close'
  | 'term:redraw'
  | 'session:newBackground'
  | 'session:pickProjectDir'
  | 'session:stopBackground'
  | 'session:history'
  | 'session:restoreBackground';

export interface TerminalHostOptions {
  cli: ClaudeCli;
  engine: () => BoardEngine | null;
  settings: () => AppSettings;
  send: <K extends keyof IpcEventMap>(ch: K, payload: IpcEventMap[K]) => void;
  demo: boolean;
  spawn: PtySpawn;
  exec?: CliExec;
  /** Klasör seçme penceresi (iptal → null). */
  pickDirectory: () => Promise<string | null>;
  now?: () => number;
  maxOpen?: number;
}

export interface TerminalHost {
  handlers: Pick<IpcHandlers, TerminalChannels>;
  capability(): TerminalCapability;
  /** Ana pencere görünürlüğü (gizliyken akış tamponlanır). */
  setVisible(v: boolean): void;
  /** Pencere kapandı ya da uygulama çıkıyor: bütün attach istemcileri kapanır (session'lar yaşar). */
  closeAll(): void;
  /** Ayar değişti (claudePath, enabled, claudeConfigDir): çözümü tazele ve yayınla. */
  settingsChanged(): void;
  /** İlk çözüm (açılışta, arka planda). */
  warmUp(): void;
  openCount(): number;
}

const PICK_TTL_MS = 10 * 60_000;

const int = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const dim = (v: unknown): v is number => int(v) && v >= TERM_DIM_MIN && v <= TERM_DIM_MAX;

export function createTerminalHost(o: TerminalHostOptions): TerminalHost {
  const now = o.now ?? Date.now;
  const exec = o.exec ?? realExec;
  const picked = new Map<string, number>();

  const stillBackground = (sid: string): boolean => o.engine()?.backgroundTarget?.(sid) != null;
  const pty = new PtyManager({
    spawn: o.spawn,
    ...(o.maxOpen ? { maxOpen: o.maxOpen } : {}),
    stillBackground,
    onData: (termId, data) => o.send('term:data', { termId, data }),
    onExit: (termId, reason, code) => {
      o.send('term:exit', { termId, reason, code });
      if (reason === 'not-found' || reason === 'exited') void o.engine()?.refreshBackground?.();
    },
  });

  const capability = (): TerminalCapability => {
    if (o.demo)
      return {
        available: false,
        reason: 'demo',
        claudePath: null,
        claudeVersion: null,
        detail: 'Demo modunda gömülü terminal kullanılamaz.',
      };
    return o.cli.capability(o.settings().terminal.enabled);
  };
  const publish = (): void => o.send('terminal:capability', capability());

  /** Kullanılabilir CLI (özellik kapalıysa / demo ise null). */
  const ready = async () => {
    if (o.demo || !o.settings().terminal.enabled) return null;
    const r = await o.cli.resolve();
    return r.ok ? r.cli : null;
  };

  const allowedCwd = (cwd: string): boolean => {
    if (Object.prototype.hasOwnProperty.call(o.settings().projects, cwd)) return true;
    const snap = o.engine()?.getSnapshot();
    if (snap?.projects.some((p) => p.root === cwd)) return true;
    const t = picked.get(cwd);
    return t !== undefined && now() - t <= PICK_TTL_MS;
  };

  const handlers: Pick<IpcHandlers, TerminalChannels> = {
    'terminal:capability': async () => {
      if (!o.demo && o.settings().terminal.enabled && !o.cli.current()) await o.cli.resolve();
      return ok(capability());
    },
    'terminal:retry': async () => {
      o.cli.invalidate();
      if (!o.demo) await o.cli.resolve();
      publish();
      return ok(capability());
    },
    'term:open': async (sessionId: unknown, cols: unknown, rows: unknown) => {
      if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId))
        return fail('BAD_INPUT', 'Geçersiz session kimliği.');
      if (!dim(cols) || !dim(rows)) return fail('BAD_INPUT', 'Geçersiz terminal boyutu.');
      const cli = await ready();
      if (!cli) {
        const c = capability();
        return fail('NOT_IMPLEMENTED', c.detail ?? 'Gömülü terminal kullanılamıyor.');
      }
      const target = o.engine()?.backgroundTarget?.(sessionId) ?? null;
      if (!target || !BG_ID_RE.test(target.bgId)) {
        return fail(
          'NOT_FOUND',
          "Bu session arka planda değil. Uygulamada açmak için session'da /bg yazın ya da Yeni oturum ile başlatın.",
        );
      }
      const r = await pty.open({
        sessionId,
        bgId: target.bgId,
        cwd: target.cwd || process.env['HOME'] || '/',
        cols,
        rows,
        claudePath: cli.path,
        env: cli.env,
      });
      if (!r.ok) {
        if (r.error === 'limit') return fail('BAD_INPUT', r.message);
        return fail('INTERNAL', 'Terminal başlatılamadı. Uygulamayı yeniden kurmayı deneyin.');
      }
      return ok({ termId: r.termId, sessionId, reused: r.reused });
    },
    'term:write': async (termId: unknown, data: unknown) => {
      if (typeof termId !== 'string' || !TERM_ID_RE.test(termId))
        return fail('BAD_INPUT', 'Geçersiz terminal kimliği.');
      if (typeof data !== 'string' || data.length > TERM_WRITE_MAX) return fail('BAD_INPUT', 'Geçersiz girdi.');
      return pty.write(termId, data) ? ok(null) : fail('NOT_FOUND', 'Terminal kapalı.');
    },
    'term:resize': async (termId: unknown, cols: unknown, rows: unknown) => {
      if (typeof termId !== 'string' || !TERM_ID_RE.test(termId))
        return fail('BAD_INPUT', 'Geçersiz terminal kimliği.');
      if (!dim(cols) || !dim(rows)) return fail('BAD_INPUT', 'Geçersiz terminal boyutu.');
      return pty.resize(termId, cols, rows) ? ok(null) : fail('NOT_FOUND', 'Terminal kapalı.');
    },
    'term:redraw': async (termId: unknown) => {
      if (typeof termId !== 'string' || !TERM_ID_RE.test(termId))
        return fail('BAD_INPUT', 'Geçersiz terminal kimliği.');
      return pty.redraw(termId) ? ok(null) : fail('NOT_FOUND', 'Terminal kapalı.');
    },
    'term:close': async (termId: unknown) => {
      if (typeof termId !== 'string' || !TERM_ID_RE.test(termId))
        return fail('BAD_INPUT', 'Geçersiz terminal kimliği.');
      pty.close(termId);
      return ok(null);
    },
    'session:newBackground': async (cwd: unknown, task: unknown) => {
      const cli = await ready();
      if (!cli) return fail('NOT_IMPLEMENTED', capability().detail ?? 'Gömülü terminal kullanılamıyor.');
      const r = await startBackground(cwd, task, { cli, exec, allowedCwd });
      if (!r.ok) return fail(r.code, r.message);
      void o.engine()?.refreshBackground?.();
      return ok({ bgId: r.bgId });
    },
    'session:stopBackground': async (sessionId: unknown) => {
      if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId))
        return fail('BAD_INPUT', 'Geçersiz session kimliği.');
      const cli = await ready();
      if (!cli) return fail('NOT_IMPLEMENTED', capability().detail ?? 'Gömülü terminal kullanılamıyor.');
      const target = o.engine()?.backgroundTarget?.(sessionId) ?? null;
      if (!target || !BG_ID_RE.test(target.bgId)) return fail('NOT_FOUND', 'Bu session arka planda değil.');
      // Önce uygulamanın attach istemcisi kapanır (session'ı durdurmaz). İşçi çalışıyorsa `claude stop`; bitmiş/uyuyan
      // session'da stop bir şey değiştirmez (Mac'te görüldü: state `done` kalır). Her durumda haritadan kaldırılır.
      // `claude rm` kullanılmaz: session'ı ve worktree'sini siler, geri alınamaz.
      const termId = pty.tabOf(sessionId);
      if (termId) pty.close(termId);
      if (target.running) {
        const r = await exec(cli.path, ['stop', target.bgId], { timeoutMs: 15_000, env: cli.env });
        if (!r.ok) {
          console.warn(`[terminal] claude stop başarısız (kod ${String(r.code)})`);
          void o.engine()?.refreshBackground?.();
          return fail('INTERNAL', 'Session durdurulamadı. Terminalde: claude stop ' + target.bgId);
        }
      }
      o.engine()?.dismissBackground?.(target.bgId);
      void o.engine()?.refreshBackground?.();
      return ok({ termId });
    },
    'session:history': async () => {
      const eng = o.engine();
      if (o.demo || !eng?.backgroundHistory) return ok([]);
      if (o.settings().terminal.enabled) await eng.refreshBackground?.();
      return ok(eng.backgroundHistory());
    },
    'session:restoreBackground': async (bgId: unknown) => {
      if (typeof bgId !== 'string' || !BG_ID_RE.test(bgId)) return fail('BAD_INPUT', 'Geçersiz session kimliği.');
      const sid = o.engine()?.restoreBackground?.(bgId.toLowerCase()) ?? null;
      if (!sid) return fail('NOT_FOUND', 'Session artık listede yok (claude rm ile silinmiş olabilir).');
      return ok({ sessionId: sid });
    },
    'session:pickProjectDir': async () => {
      const dir = await o.pickDirectory();
      if (!dir) return ok(null);
      const clean = dir.replace(/\/+$/, '') || '/';
      picked.set(clean, now());
      return ok(clean);
    },
  };

  return {
    handlers,
    capability,
    setVisible: (v) => pty.setVisible(v),
    closeAll: () => pty.closeAll(),
    settingsChanged: () => {
      o.cli.invalidate();
      if (!o.demo && o.settings().terminal.enabled) void o.cli.resolve().then(publish);
      else publish();
    },
    warmUp: () => {
      if (o.demo || !o.settings().terminal.enabled) return;
      void o.cli.resolve().then(publish);
    },
    openCount: () => pty.openCount(),
  };
}
