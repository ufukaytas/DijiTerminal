// Ayar deposu
// userData/settings.json: doğrulanır, atomik yazılır (tmp + rename, 0600), dışarıdan düzenlenirse yeniden yüklenir.
// Electron importu yok: dizin dışarıdan verilir, testler geçici klasörle çalışır.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fail, ok, type IpcResult } from '@shared/ipc';
import { mergeSettings, migrate, SETTINGS_SCHEMA_VERSION, validateSettings, type SettingsPatch } from '@shared/settings';
import type { AppSettings } from '@shared/types';

export const SETTINGS_FILE = 'settings.json';
const RELOAD_DEBOUNCE_MS = 300;

export type ChangeListener = (next: AppSettings, prev: AppSettings) => void;

export interface SettingsStoreOptions {
  /** userData */
  dir: string;
  /** false → fs.watch kurulmaz (testler elle `reloadFromDisk` çağırır). */
  watch?: boolean;
  /** claudeConfigDir doğrulaması için (testlerde sahte). */
  dirExists?: (p: string) => boolean;
  now?: () => number;
}

export type LoadOutcome = 'created' | 'loaded' | 'corrupt';

const sha = (s: string) => createHash('sha1').update(s).digest('hex');

function defaultDirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export class SettingsStore {
  readonly file: string;
  private readonly dir: string;
  private readonly useWatch: boolean;
  private readonly dirExists: (p: string) => boolean;
  private readonly now: () => number;
  private value: AppSettings;
  private listeners = new Set<ChangeListener>();
  private lastWrittenHash: string | null = null;
  private watcher: fs.FSWatcher | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  /** Son yüklemenin sonucu (bozuk dosya → toast). */
  outcome: LoadOutcome = 'loaded';
  /** Bozuk dosyanın taşındığı yer. */
  corruptBackup: string | null = null;
  /** Yükleme sırasında atılan/düzeltilen alanlar. */
  issues: string[] = [];

  constructor(opts: SettingsStoreOptions) {
    this.dir = opts.dir;
    this.file = path.join(opts.dir, SETTINGS_FILE);
    this.useWatch = opts.watch ?? true;
    this.dirExists = opts.dirExists ?? defaultDirExists;
    this.now = opts.now ?? Date.now;
    this.value = validateSettings(undefined).value;
  }

  /** Dosyayı okur; yoksa varsayılanları yazar; bozuksa yedekler ve varsayılana döner. */
  load(): AppSettings {
    let raw: string | null = null;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[settings] okunamadı:', e);
    }
    if (raw === null) {
      this.outcome = 'created';
      this.value = validateSettings(undefined).value;
      this.write(this.value);
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = undefined;
      }
      if (parsed === undefined || typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        this.outcome = 'corrupt';
        this.corruptBackup = path.join(this.dir, `settings.corrupt-${this.now()}.json`);
        try {
          fs.renameSync(this.file, this.corruptBackup);
        } catch (e) {
          console.error('[settings] bozuk dosya yedeklenemedi:', e);
          this.corruptBackup = null;
        }
        this.value = validateSettings(undefined).value;
        this.write(this.value);
      } else {
        const r = validateSettings(migrate(parsed));
        this.outcome = 'loaded';
        this.issues = r.issues;
        this.value = r.value;
        this.lastWrittenHash = sha(raw);
      }
    }
    this.startWatch();
    return this.get();
  }

  get(): AppSettings {
    return JSON.parse(JSON.stringify(this.value)) as AppSettings;
  }

  /** Yamayı doğrular, birleştirir, yazar ve abonelere yayar. Senkron: iki hızlı yama sırayla uygulanır. */
  set(patch: SettingsPatch): IpcResult<AppSettings> {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return fail('BAD_INPUT', 'Geçersiz ayar.');
    const merged = mergeSettings(this.value, patch);
    const { value, issues } = validateSettings(merged);
    if (issues.length > 0) return fail('BAD_INPUT', issues[0] ?? 'Geçersiz ayar.');
    if (patch.claudeConfigDir && value.claudeConfigDir && !this.dirExists(value.claudeConfigDir)) {
      return fail('BAD_INPUT', 'Bu klasör bulunamadı.');
    }
    const prev = this.value;
    if (JSON.stringify(prev) === JSON.stringify(value)) return ok(this.get());
    try {
      this.write(value);
    } catch (e) {
      console.error('[settings] yazılamadı:', e);
      return fail('INTERNAL', 'Ayarlar kaydedilemedi.');
    }
    this.value = value;
    this.notify(value, prev);
    return ok(this.get());
  }

  onChange(cb: ChangeListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Dosya dışarıdan değişti: yeniden oku. Kendi yazımımız ya da bozuk ara kayıt yok sayılır. */
  reloadFromDisk(): boolean {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return false;
    }
    if (sha(raw) === this.lastWrittenHash) return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Editör yarım kaydetmiş olabilir: bellekteki değer korunur, sonraki kayıtta tekrar denenir.
      return false;
    }
    const { value } = validateSettings(migrate(parsed));
    this.lastWrittenHash = sha(raw);
    const prev = this.value;
    if (JSON.stringify(prev) === JSON.stringify(value)) return false;
    this.value = value;
    this.notify(value, prev);
    return true;
  }

  dispose(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = null;
    this.listeners.clear();
  }

  private notify(next: AppSettings, prev: AppSettings): void {
    for (const cb of this.listeners) {
      try {
        cb(JSON.parse(JSON.stringify(next)) as AppSettings, prev);
      } catch (e) {
        console.error('[settings] dinleyici hatası:', e);
      }
    }
  }

  private write(v: AppSettings): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const text = JSON.stringify({ schemaVersion: SETTINGS_SCHEMA_VERSION, ...v }, null, 2) + '\n';
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      /* izin değiştirilemezse yazım yine geçerli */
    }
    this.lastWrittenHash = sha(text);
  }

  private startWatch(): void {
    if (!this.useWatch || this.watcher) return;
    try {
      this.watcher = fs.watch(this.dir, { persistent: false }, (_ev, f) => {
        if (f && String(f) !== SETTINGS_FILE) return;
        if (this.reloadTimer) clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => {
          this.reloadTimer = null;
          this.reloadFromDisk();
        }, RELOAD_DEBOUNCE_MS);
        this.reloadTimer.unref?.();
      });
      this.watcher.on('error', () => undefined);
    } catch (e) {
      console.error('[settings] izlenemiyor:', e);
    }
  }
}
