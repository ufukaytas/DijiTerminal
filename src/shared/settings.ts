// Ayarlar: varsayılanlar, doğrulama, birleştirme
// Saf TS (Node/electron importu yok): main depo da renderer formu da aynı kuralları kullanır.
import { isValidAccelerator, isValidPrefix } from './accelerator';
import { EMBLEMS, SLOW_COLOR, STATUS_COLOR } from './constants';
import type { AppSettings, EmblemKind } from './types';

export const SETTINGS_SCHEMA_VERSION = 1;

export const DEFAULT_SETTINGS: AppSettings = {
  claudeConfigDir: null,
  alwaysOnTop: false,
  launchAtLogin: false,
  notifications: { waiting: true, done: true, slowTool: true, sound: false, redactLabels: false },
  shortcuts: { enabled: true, focusWaiting: 'Control+Alt+W', toggleBoard: 'Control+Alt+D', sessionPrefix: 'Control+Alt' },
  projects: {},
  reducedMotion: 'system',
  renderQuality: 'high',
  menuBar: { enabled: true, hideDock: false },
  terminal: { enabled: true, claudePath: null, fontSize: 13 },
};

export type ProjectSettings = AppSettings['projects'][string];

/**
 * `settings:set` yaması: üst düzey alanlar kısmi, `notifications`/`shortcuts`/`menuBar`/`terminal` derin birleşir,
 * `projects[root] = null` o projenin kaydını siler.
 */
export interface SettingsPatch {
  claudeConfigDir?: string | null;
  alwaysOnTop?: boolean;
  launchAtLogin?: boolean;
  notifications?: Partial<AppSettings['notifications']>;
  shortcuts?: Partial<AppSettings['shortcuts']>;
  projects?: Record<string, Partial<ProjectSettings> | null>;
  reducedMotion?: AppSettings['reducedMotion'];
  renderQuality?: AppSettings['renderQuality'];
  menuBar?: Partial<AppSettings['menuBar']>;
  terminal?: Partial<AppSettings['terminal']>;
}

const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const ALIAS_MAX = 40;
const MOTION = ['system', 'on', 'off'] as const;
const QUALITY = ['high', 'balanced'] as const;
export const FONT_MIN = 11;
export const FONT_MAX = 18;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Mutlak POSIX yolu (Windows desteklenmiyor). */
export const isAbsolutePath = (p: string): boolean => p.startsWith('/') && !p.includes('\0');

export interface ValidationResult {
  value: AppSettings;
  issues: string[];
}

function bool(raw: Record<string, unknown>, key: string, def: boolean, at: string, issues: string[]): boolean {
  const v = raw[key];
  if (v === undefined) return def;
  if (typeof v === 'boolean') return v;
  issues.push(`${at}${key}: açık/kapalı (true/false) olmalı, varsayılan kullanıldı.`);
  return def;
}

function project(root: string, raw: unknown, issues: string[]): ProjectSettings | null {
  if (!isAbsolutePath(root)) {
    issues.push(`projects: "${root}" mutlak bir yol değil, atlandı.`);
    return null;
  }
  if (!isObj(raw)) {
    issues.push(`projects["${root}"]: nesne olmalı, atlandı.`);
    return null;
  }
  const out: ProjectSettings = {};
  for (const k of Object.keys(raw)) {
    if (!['alias', 'color', 'emblem', 'hidden'].includes(k)) issues.push(`projects["${root}"].${k}: bilinmeyen alan atıldı.`);
  }
  const alias = raw['alias'];
  if (alias !== undefined) {
    if (typeof alias === 'string' && alias.trim()) out.alias = alias.trim().slice(0, ALIAS_MAX);
    else if (alias !== '') issues.push(`projects["${root}"].alias: metin olmalı.`);
  }
  const color = raw['color'];
  if (color !== undefined) {
    if (typeof color === 'string' && COLOR_RE.test(color)) out.color = color.toUpperCase();
    else issues.push(`Geçersiz renk değeri: ${String(color)}`);
  }
  const emblem = raw['emblem'];
  if (emblem !== undefined) {
    if (typeof emblem === 'string' && (EMBLEMS as readonly string[]).includes(emblem)) out.emblem = emblem as EmblemKind;
    else issues.push(`Geçersiz amblem: ${String(emblem)}`);
  }
  const hidden = raw['hidden'];
  if (hidden !== undefined) {
    if (typeof hidden === 'boolean') {
      if (hidden) out.hidden = true;
    } else issues.push(`projects["${root}"].hidden: true/false olmalı.`);
  }
  return out;
}

/** Ham değeri (dosya ya da IPC) AppSettings'e çevirir: bilinmeyen alanlar atılır, yanlış tipler varsayılana döner. */
export function validateSettings(raw: unknown): ValidationResult {
  const issues: string[] = [];
  const d = DEFAULT_SETTINGS;
  if (!isObj(raw)) {
    if (raw !== undefined && raw !== null) issues.push('Ayarlar bir nesne olmalı; varsayılanlar kullanıldı.');
    return { value: structuredCloneSafe(d), issues };
  }
  const known = new Set(['schemaVersion', 'claudeConfigDir', 'alwaysOnTop', 'launchAtLogin', 'notifications', 'shortcuts', 'projects', 'reducedMotion', 'renderQuality', 'menuBar', 'terminal']);
  for (const k of Object.keys(raw)) if (!known.has(k)) issues.push(`${k}: bilinmeyen alan atıldı.`);

  let claudeConfigDir: string | null = d.claudeConfigDir;
  const dir = raw['claudeConfigDir'];
  if (dir === null || dir === undefined || dir === '') claudeConfigDir = null;
  else if (typeof dir === 'string' && isAbsolutePath(dir.trim())) claudeConfigDir = dir.trim().replace(/\/+$/, '') || '/';
  else issues.push('claudeConfigDir: mutlak bir klasör yolu olmalı (ör. /Users/ad/.claude).');

  const n = isObj(raw['notifications']) ? raw['notifications'] : {};
  if (raw['notifications'] !== undefined && !isObj(raw['notifications'])) issues.push('notifications: nesne olmalı.');
  const notifications: AppSettings['notifications'] = {
    waiting: bool(n, 'waiting', d.notifications.waiting, 'notifications.', issues),
    done: bool(n, 'done', d.notifications.done, 'notifications.', issues),
    slowTool: bool(n, 'slowTool', d.notifications.slowTool, 'notifications.', issues),
    sound: bool(n, 'sound', d.notifications.sound, 'notifications.', issues),
    redactLabels: bool(n, 'redactLabels', d.notifications.redactLabels, 'notifications.', issues),
  };

  const sc = isObj(raw['shortcuts']) ? raw['shortcuts'] : {};
  const accel = (key: 'focusWaiting' | 'toggleBoard' | 'sessionPrefix'): string => {
    const v = sc[key];
    if (v === undefined) return d.shortcuts[key];
    if (typeof v === 'string' && (key === 'sessionPrefix' ? isValidPrefix(v) : isValidAccelerator(v))) return v;
    issues.push(`shortcuts.${key}: geçersiz kısayol, varsayılan kullanıldı.`);
    return d.shortcuts[key];
  };
  const shortcuts: AppSettings['shortcuts'] = {
    enabled: bool(sc, 'enabled', d.shortcuts.enabled, 'shortcuts.', issues),
    focusWaiting: accel('focusWaiting'),
    toggleBoard: accel('toggleBoard'),
    sessionPrefix: accel('sessionPrefix'),
  };

  const projects: AppSettings['projects'] = {};
  const pr = raw['projects'];
  if (pr !== undefined && !isObj(pr)) issues.push('projects: nesne olmalı.');
  if (isObj(pr)) {
    for (const [root, v] of Object.entries(pr)) {
      const p = project(root, v, issues);
      if (p && Object.keys(p).length > 0) projects[root] = p;
    }
  }

  let reducedMotion = d.reducedMotion;
  const rm = raw['reducedMotion'];
  if (rm !== undefined) {
    if (typeof rm === 'string' && (MOTION as readonly string[]).includes(rm)) reducedMotion = rm as AppSettings['reducedMotion'];
    else issues.push('reducedMotion: system / on / off olmalı.');
  }

  let renderQuality = d.renderQuality;
  const rq = raw['renderQuality'];
  if (rq !== undefined) {
    if (typeof rq === 'string' && (QUALITY as readonly string[]).includes(rq)) renderQuality = rq as AppSettings['renderQuality'];
    else issues.push('renderQuality: high / balanced olmalı.');
  }

  const mb = isObj(raw['menuBar']) ? raw['menuBar'] : {};
  if (raw['menuBar'] !== undefined && !isObj(raw['menuBar'])) issues.push('menuBar: nesne olmalı.');
  const menuBar: AppSettings['menuBar'] = {
    enabled: bool(mb, 'enabled', d.menuBar.enabled, 'menuBar.', issues),
    hideDock: bool(mb, 'hideDock', d.menuBar.hideDock, 'menuBar.', issues),
  };

  const tm = isObj(raw['terminal']) ? raw['terminal'] : {};
  if (raw['terminal'] !== undefined && !isObj(raw['terminal'])) issues.push('terminal: nesne olmalı.');
  let claudePath: string | null = d.terminal.claudePath;
  const cp = tm['claudePath'];
  if (cp === null || cp === undefined || cp === '') claudePath = null;
  else if (typeof cp === 'string' && isAbsolutePath(cp.trim())) claudePath = cp.trim();
  else issues.push('terminal.claudePath: mutlak bir dosya yolu olmalı (ör. /Users/ad/.local/bin/claude).');
  let fontSize = d.terminal.fontSize;
  const fs = tm['fontSize'];
  if (fs !== undefined) {
    if (typeof fs === 'number' && Number.isInteger(fs) && fs >= FONT_MIN && fs <= FONT_MAX) fontSize = fs;
    else issues.push(`terminal.fontSize: ${FONT_MIN}–${FONT_MAX} arası tam sayı olmalı.`);
  }
  const terminal: AppSettings['terminal'] = {
    enabled: bool(tm, 'enabled', d.terminal.enabled, 'terminal.', issues),
    claudePath,
    fontSize,
  };

  return {
    value: {
      claudeConfigDir,
      alwaysOnTop: bool(raw, 'alwaysOnTop', d.alwaysOnTop, '', issues),
      launchAtLogin: bool(raw, 'launchAtLogin', d.launchAtLogin, '', issues),
      notifications,
      shortcuts,
      projects,
      reducedMotion,
      renderQuality,
      menuBar,
      terminal,
    },
    issues,
  };
}

/** Yamayı uygular (doğrulamadan önce). `projects[root] = null` siler; proje alanları da derin birleşir. */
export function mergeSettings(base: AppSettings, patch: SettingsPatch | Partial<AppSettings>): AppSettings {
  const p = patch as SettingsPatch;
  const next: AppSettings = {
    ...base,
    notifications: { ...base.notifications, ...(p.notifications ?? {}) },
    shortcuts: { ...base.shortcuts, ...(p.shortcuts ?? {}) },
    menuBar: { ...base.menuBar, ...(p.menuBar ?? {}) },
    terminal: { ...base.terminal, ...(p.terminal ?? {}) },
    projects: { ...base.projects },
  };
  if ('claudeConfigDir' in p) next.claudeConfigDir = p.claudeConfigDir ?? null;
  if (p.alwaysOnTop !== undefined) next.alwaysOnTop = p.alwaysOnTop;
  if (p.launchAtLogin !== undefined) next.launchAtLogin = p.launchAtLogin;
  if (p.reducedMotion !== undefined) next.reducedMotion = p.reducedMotion;
  if (p.renderQuality !== undefined) next.renderQuality = p.renderQuality;
  if (p.projects) {
    for (const [root, v] of Object.entries(p.projects)) {
      if (v === null) {
        delete next.projects[root];
        continue;
      }
      const merged: Record<string, unknown> = { ...(next.projects[root] ?? {}), ...v };
      // Boş/undefined değer o alanı temizler (ör. takma adı silmek).
      for (const k of Object.keys(merged)) if (merged[k] === undefined || merged[k] === '' || merged[k] === false) delete merged[k];
      if (Object.keys(merged).length === 0) delete next.projects[root];
      else next.projects[root] = merged as ProjectSettings;
    }
  }
  return next;
}

/** Dosya biçimi göçü: schemaVersion yoksa 1 kabul edilir. */
export function migrate(raw: unknown): unknown {
  if (!isObj(raw)) return raw;
  const v = raw['schemaVersion'];
  if (v === undefined || v === 1) return raw;
  return raw; // ileride: v2 → … dönüşümleri
}

/**
 * Proje rengi durum renklerine (çalışıyor/bekliyor/boşta/bitti/yavaş) çok yakın mı? (UI uyarısı)
 * Kategori renkleri bilerek dışarıda: PROJECT_PALETTE'in iki tonu (browser, mcp) zaten onlarla aynı
 * ve kategori rengi yalnızca küçük araç etiketlerinde kullanılıyor.
 */
export function clashesWithStatusColors(hex: string): boolean {
  if (!COLOR_RE.test(hex)) return false;
  const rgb = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const [r, g, b] = rgb(hex);
  const reserved = [...Object.values(STATUS_COLOR), SLOW_COLOR];
  return reserved.some((c) => {
    const [r2, g2, b2] = rgb(c);
    return Math.hypot(r - r2, g - g2, b - b2) < 40;
  });
}

/** Değiştiği bildirilen üst düzey alanlar (main abonelerinin hangisini dinleyeceğine karar vermesi için). */
export function changedKeys(a: AppSettings, b: AppSettings): (keyof AppSettings)[] {
  return (Object.keys(a) as (keyof AppSettings)[]).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

function structuredCloneSafe(s: AppSettings): AppSettings {
  return JSON.parse(JSON.stringify(s)) as AppSettings;
}
