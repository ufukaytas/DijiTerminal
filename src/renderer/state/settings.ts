// Ayarlar (00/04): main'deki deponun renderer aynası. İyimser güncelleme, hata gelirse geri alma ve alan hatası.
import { create } from 'zustand';
import type { DijiApi } from '@shared/ipc';
import { mergeSettings, type SettingsPatch } from '@shared/settings';
import { formatAccelerator } from '@shared/accelerator';
import type { AppSettings, HookInstallStatus, ShortcutReport } from '@shared/types';
import { setHotkeyPrefix } from '../lib/format';

export interface SettingsState {
  value: AppSettings | null;
  open: boolean;
  /** Alan anahtarı → hata metni (ör. 'claudeConfigDir', 'project:/path:color'). */
  errors: Record<string, string>;
  hooks: HookInstallStatus | null;
  hookBusy: boolean;
  hookError: string | null;
  /** Global kısayolların kayıt durumu (04/03). */
  shortcutReport: ShortcutReport | null;
  setOpen(open: boolean): void;
  setValue(v: AppSettings): void;
  update(patch: SettingsPatch, field?: string): Promise<boolean>;
  refreshHooks(): Promise<void>;
  installHooks(): Promise<void>;
  uninstallHooks(): Promise<void>;
  refreshShortcuts(): Promise<void>;
}

let api: DijiApi | undefined;

const withoutKey = (o: Record<string, string>, k: string) => {
  const n = { ...o };
  delete n[k];
  return n;
};

export const useSettings = create<SettingsState>()((set, get) => ({
  value: null,
  open: false,
  errors: {},
  hooks: null,
  hookBusy: false,
  hookError: null,
  shortcutReport: null,
  setOpen: (open) => {
    set({ open });
    if (open) {
      void get().refreshHooks();
      void get().refreshShortcuts();
    }
  },
  setValue: (value) => set({ value }),
  async update(patch, field = 'general') {
    const prev = get().value;
    if (!prev || !api) return false;
    set({ value: mergeSettings(prev, patch) });
    let res: Awaited<ReturnType<DijiApi['invoke']>> | null = null;
    try {
      res = await api.invoke('settings:set', patch);
    } catch {
      res = null;
    }
    if (res && res.ok) {
      set((s) => ({ value: res.data as AppSettings, errors: withoutKey(s.errors, field) }));
      return true;
    }
    const message = res && !res.ok ? res.error.message : 'Ayarlar kaydedilemedi.';
    set((s) => ({ value: prev, errors: { ...s.errors, [field]: message } }));
    return false;
  },
  async refreshHooks() {
    if (!api) return;
    try {
      const r = await api.invoke('hooks:status');
      set(r.ok ? { hooks: r.data, hookError: null } : { hookError: r.error.message });
    } catch {
      set({ hookError: 'Hook durumu alınamadı.' });
    }
  },
  async installHooks() {
    await runHook('hooks:install', set);
  },
  async uninstallHooks() {
    await runHook('hooks:uninstall', set);
  },
  async refreshShortcuts() {
    if (!api) return;
    try {
      const r = await api.invoke('shortcuts:status');
      if (r.ok) set({ shortcutReport: r.data });
    } catch {
      /* rapor yoksa panel yalnızca ayarları gösterir */
    }
  },
}));

async function runHook(ch: 'hooks:install' | 'hooks:uninstall', set: (p: Partial<SettingsState>) => void): Promise<void> {
  if (!api) return;
  set({ hookBusy: true, hookError: null });
  try {
    const r = await api.invoke(ch);
    set(r.ok ? { hooks: r.data, hookBusy: false } : { hookBusy: false, hookError: r.error.message });
  } catch {
    set({ hookBusy: false, hookError: 'İşlem başarısız.' });
  }
}

/** `reducedMotion` → kökte data-motion: 'reduce' | 'full'; 'system' → attribute yok (media query). */
export function applyMotion(v: AppSettings['reducedMotion'] | undefined, root: HTMLElement = document.documentElement): void {
  if (v === 'on') root.dataset['motion'] = 'reduce';
  else if (v === 'off') root.dataset['motion'] = 'full';
  else delete root.dataset['motion'];
}

/** Görüntü kalitesi kökte `data-quality` olarak (3B harita piksel oranını buna göre seçer). */
export function applyQuality(v: AppSettings['renderQuality'] | undefined, root: HTMLElement = document.documentElement): void {
  if (v === 'balanced') root.dataset['quality'] = 'balanced';
  else delete root.dataset['quality'];
}

/** Kart/etiketlerdeki session numarası öneki ayardan (04/03): kısayollar kapalıysa numara gösterilmez. */
export function applyHotkeyPrefix(sc: AppSettings['shortcuts'] | undefined): void {
  if (!sc) return;
  setHotkeyPrefix(sc.enabled ? formatAccelerator(sc.sessionPrefix) : null);
}

/** App.tsx'te çağrılır; dönen fonksiyon abonelikleri kaldırır. */
export function initSettingsBridge(
  bridge: DijiApi | undefined = typeof window !== 'undefined' ? window.diji : undefined,
): () => void {
  api = bridge;
  if (!bridge) return () => {};
  let disposed = false;
  const unsubMotion = useSettings.subscribe((s, p) => {
    if (s.value?.reducedMotion !== p.value?.reducedMotion) applyMotion(s.value?.reducedMotion);
    if (s.value?.renderQuality !== p.value?.renderQuality) applyQuality(s.value?.renderQuality);
    if (s.value?.shortcuts !== p.value?.shortcuts) applyHotkeyPrefix(s.value?.shortcuts);
  });
  const offs = [
    bridge.on('settings:changed', (v) => useSettings.getState().setValue(v)),
    bridge.on('shortcuts:report', (r) => useSettings.setState({ shortcutReport: r })),
    bridge.on('ui:openSettings', () => useSettings.getState().setOpen(true)),
  ];
  void (async () => {
    try {
      const r = await bridge.invoke('settings:get');
      if (!disposed && r.ok) useSettings.getState().setValue(r.data);
    } catch {
      /* ayarlar yoksa varsayılanlarla devam; panel "yükleniyor" gösterir */
    }
  })();
  return () => {
    disposed = true;
    unsubMotion();
    for (const off of offs) off();
    api = undefined;
  };
}
