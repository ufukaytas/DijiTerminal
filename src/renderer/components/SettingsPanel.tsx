// Ayarlar paneli (00/04): ⌘, ya da üst bardaki dişliyle sağdan açılır.
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { acceleratorFromKey, formatAccelerator, SHORTCUT_PRESETS } from '@shared/accelerator';
import { EMBLEMS, PROJECT_PALETTE } from '@shared/constants';
import { clashesWithStatusColors, FONT_MAX, FONT_MIN, type ProjectSettings } from '@shared/settings';
import type { AppSettings, EmblemKind, ShortcutReport } from '@shared/types';
import { useBoard, useProjects } from '../state/board';
import { useSettings } from '../state/settings';
import { useTerminals } from '../state/terminals';

const EMBLEM_LABEL: Record<EmblemKind, string> = {
  team: 'Takım',
  ring: 'Halka',
  stack: 'Yığın',
  wave: 'Dalga',
  prism: 'Prizma',
  cube: 'Küp',
};

const MOTION: { value: AppSettings['reducedMotion']; label: string }[] = [
  { value: 'system', label: 'Sistem' },
  { value: 'on', label: 'Azalt' },
  { value: 'off', label: 'Normal' },
];

const QUALITY: { value: AppSettings['renderQuality']; label: string }[] = [
  { value: 'high', label: 'Yüksek' },
  { value: 'balanced', label: 'Dengeli' },
];

const FAST_TEXT: Record<string, string> = {
  active: 'açık — onay beklemeleri anında görünür',
  missing: 'kapalı (hook kurulu değil)',
  error: 'kapalı (hook olay dosyası okunamıyor)',
  off: 'demo modunda yok',
};

const STATUS_LINE_TEXT: Record<string, string> = {
  none: 'yok',
  ours: 'DijiTerminal',
  chained: 'zincirlenmiş (önceki status line korunuyor)',
  foreign: 'sizin (DijiTerminal dokunmadı)',
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="set-sec">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Check({
  id,
  label,
  checked,
  onChange,
  hint,
  disabled,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange(v: boolean): void;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <div className={disabled ? 'set-row is-disabled' : 'set-row'}>
      <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <label htmlFor={id}>
        {label}
        {hint && <span className="set-hint">{hint}</span>}
      </label>
    </div>
  );
}

function FieldError({ field }: { field: string }) {
  const err = useSettings((s) => s.errors[field]);
  return err ? (
    <p className="set-err" role="alert">
      {err}
    </p>
  ) : null;
}

function ClaudeDir({ value }: { value: AppSettings }) {
  const update = useSettings((s) => s.update);
  // Taslak, kayıtlı değer değişince (başka yerden, ya da hata sonrası geri alma) kendiliğinden sıfırlanır.
  const src = value.claudeConfigDir ?? '';
  const [d, setD] = useState({ src, v: src });
  const draft = d.src === src ? d.v : src;
  const setDraft = (v: string) => setD({ src, v });
  const commit = (v: string) => {
    const next = v.trim() || null;
    if (next === value.claudeConfigDir) return;
    void update({ claudeConfigDir: next }, 'claudeConfigDir');
  };
  const pick = async () => {
    const r = await window.diji?.invoke('settings:pickDirectory');
    if (r && r.ok && r.data) {
      setDraft(r.data);
      commit(r.data);
    }
  };
  return (
    <div className="set-field">
      <label htmlFor="set-claude-dir">Claude klasörü</label>
      <div className="set-inline">
        <input
          id="set-claude-dir"
          type="text"
          spellCheck={false}
          placeholder="Varsayılan: ~/.claude"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && commit((e.target as HTMLInputElement).value)}
        />
        <button type="button" className="btn" onClick={() => void pick()}>
          Seç…
        </button>
      </div>
      <span className="set-hint">Boş bırakılırsa CLAUDE_CONFIG_DIR ya da ~/.claude kullanılır. Değişince pano yeniden yüklenir.</span>
      <FieldError field="claudeConfigDir" />
    </div>
  );
}

/** 07/01: gömülü terminal — aç/kapat, claude yolu, yazı boyutu, durum satırı. */
function TerminalSection({ value }: { value: AppSettings }) {
  const update = useSettings((s) => s.update);
  const cap = useTerminals((s) => s.capability);
  const [busy, setBusy] = useState(false);
  const src = value.terminal.claudePath ?? '';
  const [d, setD] = useState({ src, v: src });
  const draft = d.src === src ? d.v : src;
  const commit = (v: string) => {
    const next = v.trim() || null;
    if (next === value.terminal.claudePath) return;
    void update({ terminal: { claudePath: next } }, 'terminal');
  };
  const retry = async () => {
    const api = window.diji;
    if (!api || busy) return;
    setBusy(true);
    try {
      const r = await api.invoke('terminal:retry');
      if (r.ok) useTerminals.getState().setCapability(r.data);
    } finally {
      setBusy(false);
    }
  };
  const status = !value.terminal.enabled
    ? 'Kapalı'
    : !cap || cap.reason === 'pending'
      ? 'claude aranıyor…'
      : cap.available
        ? `claude ${cap.claudeVersion ?? ''} · ${cap.claudePath ?? ''}`
        : (cap.detail ?? 'Kullanılamıyor');
  return (
    <Section title="Gömülü terminal">
      <Check
        id="set-term-on"
        label="Arka plan session'larını uygulamada aç"
        hint="claude --bg ya da /bg ile başlatılan session'lar; iTerm2 session'ları iTerm2'de kalır"
        checked={value.terminal.enabled}
        onChange={(v) => void update({ terminal: { enabled: v } }, 'terminal')}
      />
      <div className="set-field">
        <label htmlFor="set-claude-path">claude yolu</label>
        <div className="set-inline">
          <input
            id="set-claude-path"
            type="text"
            spellCheck={false}
            placeholder={cap?.claudePath && !value.terminal.claudePath ? `Otomatik: ${cap.claudePath}` : 'Otomatik bulunur'}
            value={draft}
            onChange={(e) => setD({ src, v: e.target.value })}
            onBlur={(e) => commit(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && commit((e.target as HTMLInputElement).value)}
          />
          <button type="button" className="btn" onClick={() => void retry()} disabled={busy || !value.terminal.enabled} aria-busy={busy || undefined}>
            Yeniden dene
          </button>
        </div>
        <span className={cap && !cap.available && value.terminal.enabled && cap.reason !== 'pending' ? 'set-hint err' : 'set-hint'}>{status}</span>
      </div>
      <div className="set-field">
        <label htmlFor="set-term-font">Yazı boyutu</label>
        <input
          id="set-term-font"
          type="number"
          min={FONT_MIN}
          max={FONT_MAX}
          value={value.terminal.fontSize}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isInteger(n) && n >= FONT_MIN && n <= FONT_MAX) void update({ terminal: { fontSize: n } }, 'terminal');
          }}
        />
      </div>
      <FieldError field="terminal" />
    </Section>
  );
}

type ShortcutKey = 'focusWaiting' | 'toggleBoard' | 'sessionPrefix';

const SHORTCUT_ROWS: { key: ShortcutKey; label: string }[] = [
  { key: 'focusWaiting', label: 'Bekleyene git' },
  { key: 'toggleBoard', label: 'Panoyu göster/gizle' },
  { key: 'sessionPrefix', label: "Session 1–9'a git" },
];

/** Rapor: bu ayar satırı kaydedilemediyse neden (session öneki için 9 komuttan biri yeterli). */
function shortcutProblem(report: ShortcutReport | null, key: ShortcutKey): string | null {
  if (!report || !report.enabled) return null;
  const items = key === 'sessionPrefix' ? report.items.filter((i) => i.command.startsWith('session-')) : report.items.filter((i) => i.command === key);
  const bad = items.find((i) => !i.registered);
  if (!bad) return null;
  if (bad.reason === 'duplicate') return 'başka bir DijiTerminal kısayoluyla aynı';
  if (bad.reason === 'invalid') return 'geçersiz kısayol';
  return `${formatAccelerator(bad.accelerator)} başka bir uygulama tarafından kullanılıyor`;
}

/** Odaklanınca tuş kombinasyonunu kaydeden alan. Esc vazgeçer; önek alanı yalnızca değiştiricileri alır. */
function ShortcutField({ id, value, prefixOnly, onChange }: { id: string; value: string; prefixOnly: boolean; onChange(v: string): void }) {
  const [recording, setRecording] = useState(false);
  const onKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      setRecording(false);
      return;
    }
    const acc = acceleratorFromKey(e);
    if (!acc) return; // yalnızca değiştirici basıldı ya da desteklenmeyen tuş: beklemeye devam
    setRecording(false);
    onChange(prefixOnly ? acc.split('+').slice(0, -1).join('+') : acc);
  };
  const shown = prefixOnly ? `${formatAccelerator(value)}1 … ${formatAccelerator(value)}9` : formatAccelerator(value);
  return (
    <button
      id={id}
      type="button"
      className={recording ? 'set-key rec' : 'set-key'}
      onClick={() => setRecording((r) => !r)}
      onKeyDown={onKeyDown}
      onBlur={() => setRecording(false)}
      aria-label={recording ? 'Yeni kısayola basın, vazgeçmek için Esc' : `Kısayol ${shown}, değiştirmek için tıklayın`}
    >
      {recording ? (prefixOnly ? 'Değiştiriciler + bir rakam…' : 'Tuşlara basın…') : shown}
    </button>
  );
}

function Shortcuts({ value }: { value: AppSettings }) {
  const update = useSettings((s) => s.update);
  const report = useSettings((s) => s.shortcutReport);
  const sc = value.shortcuts;
  const commandSet = sc.sessionPrefix.includes('Command') || sc.toggleBoard.startsWith('Command');
  const set = (patch: Partial<AppSettings['shortcuts']>) => void update({ shortcuts: patch }, 'shortcuts');
  return (
    <Section title="Kısayollar">
      <Check id="set-sc-on" label="Global kısayollar" hint="uygulama arka plandayken de çalışır" checked={sc.enabled} onChange={(v) => set({ enabled: v })} />
      {sc.enabled && (
        <>
          <div className="set-keys">
            {SHORTCUT_ROWS.map((r) => {
              const problem = shortcutProblem(report, r.key);
              return (
                <div key={r.key} className="set-key-row">
                  <label htmlFor={`set-sc-${r.key}`}>{r.label}</label>
                  <ShortcutField id={`set-sc-${r.key}`} value={sc[r.key]} prefixOnly={r.key === 'sessionPrefix'} onChange={(v) => set({ [r.key]: v })} />
                  {problem && (
                    <p className="set-err" role="alert">
                      {problem}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
          <div className="set-inline">
            <button type="button" className="btn" onClick={() => set({ ...SHORTCUT_PRESETS.default })}>
              Varsayılan (⌃⌥)
            </button>
            <button type="button" className="btn" onClick={() => set({ ...SHORTCUT_PRESETS.command })}>
              Alternatif (⌘)
            </button>
          </div>
          {commandSet && <p className="set-warn">Bu set iTerm2'nin ⌘⌥1–9 ve ⌘⇧D kısayollarını devre dışı bırakır.</p>}
        </>
      )}
      <FieldError field="shortcuts" />
    </Section>
  );
}

function Hooks() {
  const hooks = useSettings((s) => s.hooks);
  const busy = useSettings((s) => s.hookBusy);
  const error = useSettings((s) => s.hookError);
  const install = useSettings((s) => s.installHooks);
  const uninstall = useSettings((s) => s.uninstallHooks);
  const fast = useBoard((s) => s.snapshot.fastStatus);
  const limits = useBoard((s) => s.snapshot.limits);
  const [confirm, setConfirm] = useState<'install' | 'uninstall' | null>(null);

  return (
    <Section title="Hook'lar">
      <dl className="set-dl">
        <dt>Hızlı durum</dt>
        <dd>{fast ? FAST_TEXT[fast] : '—'}</dd>
        <dt>Hook'lar</dt>
        <dd>{hooks ? (hooks.installed ? 'kurulu' : 'kurulu değil') : '—'}</dd>
        <dt>Status line</dt>
        <dd>{hooks ? STATUS_LINE_TEXT[hooks.statusLine] : '—'}</dd>
        <dt>Limitler</dt>
        <dd>{limits ? 'status line\'dan geliyor' : 'veri yok — kullanım limitleri için status line kurulumu gerekli'}</dd>
        {hooks && (
          <>
            <dt>Ayar dosyası</dt>
            <dd className="mono">{hooks.settingsPath}</dd>
          </>
        )}
      </dl>
      {confirm ? (
        <div className="set-confirm" role="group" aria-label="Onay">
          <p>
            {confirm === 'install'
              ? 'Claude ayar dosyasına DijiTerminal hook\'ları eklenecek. Mevcut dosyanın yedeği alınır; başka ayarlarınıza dokunulmaz.'
              : 'DijiTerminal hook\'ları Claude ayar dosyasından kaldırılacak. Önceki status line\'ınız geri yüklenir.'}
          </p>
          <div className="set-inline">
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={() => {
                setConfirm(null);
                void (confirm === 'install' ? install() : uninstall());
              }}
            >
              Onayla
            </button>
            <button type="button" className="btn" onClick={() => setConfirm(null)}>
              Vazgeç
            </button>
          </div>
        </div>
      ) : (
        <div className="set-inline">
          <button type="button" className="btn" disabled={busy || hooks?.installed === true} onClick={() => setConfirm('install')}>
            Kur
          </button>
          <button type="button" className="btn" disabled={busy || hooks?.installed !== true} onClick={() => setConfirm('uninstall')}>
            Kaldır
          </button>
        </div>
      )}
      {error && (
        <p className="set-err" role="alert">
          {error}
        </p>
      )}
    </Section>
  );
}

interface ProjectRowData {
  root: string;
  name: string;
  displayPath: string;
  color: string | null;
  emblem: EmblemKind | null;
}

function ProjectRow({ p, conf }: { p: ProjectRowData; conf: AppSettings['projects'][string] | undefined }) {
  const update = useSettings((s) => s.update);
  const field = `project:${p.root}`;
  const src = conf?.alias ?? '';
  const [d, setD] = useState({ src, v: src });
  const alias = d.src === src ? d.v : src;
  const setAlias = (v: string) => setD({ src, v });
  const color = conf?.color ?? p.color ?? PROJECT_PALETTE[0] ?? '#A5B4FC';
  const patch = (v: Partial<ProjectSettings>) => void update({ projects: { [p.root]: v } }, field);
  const hidden = conf?.hidden === true;
  const idBase = `set-p-${encodeURIComponent(p.root)}`;

  return (
    <li className={hidden ? 'set-proj hidden' : 'set-proj'}>
      <div className="set-proj-head">
        <i className="dot" style={{ background: color }} aria-hidden="true" />
        <b>{p.name}</b>
        <span className="dim mono">{p.displayPath}</span>
        {hidden && <span className="chip">gizli</span>}
      </div>
      <div className="set-grid">
        <label htmlFor={`${idBase}-alias`}>Takma ad</label>
        <input
          id={`${idBase}-alias`}
          type="text"
          value={alias}
          maxLength={40}
          placeholder={p.name}
          onChange={(e) => setAlias(e.target.value)}
          onBlur={() => alias !== (conf?.alias ?? '') && patch({ alias })}
          onKeyDown={(e) => e.key === 'Enter' && alias !== (conf?.alias ?? '') && patch({ alias })}
        />
        <span id={`${idBase}-color-l`}>Renk</span>
        <div className="set-swatches" role="group" aria-labelledby={`${idBase}-color-l`}>
          {PROJECT_PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              className="swatch"
              style={{ background: c }}
              aria-label={`Renk ${c}`}
              aria-pressed={color.toUpperCase() === c.toUpperCase()}
              onClick={() => patch({ color: c })}
            />
          ))}
          <input type="color" aria-label="Özel renk" value={color.toLowerCase()} onChange={(e) => patch({ color: e.target.value })} />
        </div>
        {clashesWithStatusColors(color) && <p className="set-warn">Bu renk durum renkleriyle karışabilir.</p>}
        <label htmlFor={`${idBase}-emblem`}>Amblem</label>
        <select id={`${idBase}-emblem`} value={conf?.emblem ?? p.emblem ?? ''} onChange={(e) => patch({ emblem: e.target.value as EmblemKind })}>
          {EMBLEMS.map((e) => (
            <option key={e} value={e}>
              {EMBLEM_LABEL[e]}
            </option>
          ))}
        </select>
        <span />
        <div className="set-inline">
          <input id={`${idBase}-hide`} type="checkbox" checked={hidden} onChange={(e) => patch({ hidden: e.target.checked })} />
          <label htmlFor={`${idBase}-hide`}>Haritada gizle</label>
          {conf && (
            <button type="button" className="btn link" onClick={() => void update({ projects: { [p.root]: null } }, field)}>
              Sıfırla
            </button>
          )}
        </div>
      </div>
      <FieldError field={field} />
    </li>
  );
}

function Projects({ value }: { value: AppSettings }) {
  const projects = useProjects();
  const rows: ProjectRowData[] = projects.map((p) => ({ root: p.root, name: p.name, displayPath: p.displayPath, color: p.color, emblem: p.emblem }));
  // Gizli projeler snapshot'ta yok; ayarlardaki kayıtlarıyla listede kalırlar.
  for (const root of Object.keys(value.projects)) {
    if (!rows.some((r) => r.root === root)) {
      rows.push({ root, name: value.projects[root]?.alias || root.split('/').pop() || root, displayPath: root, color: null, emblem: null });
    }
  }
  return (
    <Section title="Projeler">
      {rows.length === 0 ? (
        <p className="dim">Henüz proje yok.</p>
      ) : (
        <ul className="set-projects">
          {rows.map((r) => (
            <ProjectRow key={r.root} p={r} conf={value.projects[r.root]} />
          ))}
        </ul>
      )}
    </Section>
  );
}

export function SettingsPanel() {
  const open = useSettings((s) => s.open);
  const setOpen = useSettings((s) => s.setOpen);
  const value = useSettings((s) => s.value);
  const update = useSettings((s) => s.update);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLElement>('button, input, select')?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  if (!open) return null;
  const n = value?.notifications;
  return (
    <div className="set-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <aside className="set-panel" role="dialog" aria-modal="true" aria-labelledby="set-title" ref={ref}>
        <header className="set-head">
          <h2 id="set-title">Ayarlar</h2>
          <button type="button" className="toast-x" aria-label="Kapat" onClick={() => setOpen(false)}>
            ×
          </button>
        </header>
        {!value || !n ? (
          <p className="dim">Ayarlar yükleniyor…</p>
        ) : (
          <div className="set-body">
            <Section title="Genel">
              <ClaudeDir value={value} />
              <Check id="set-top" label="Üstte tut" hint="⌥⌘T" checked={value.alwaysOnTop} onChange={(v) => void update({ alwaysOnTop: v })} />
              <Check
                id="set-login"
                label="Girişte başlat"
                hint="Mac açılınca arka planda çalışır; yalnızca paketli uygulamada"
                checked={value.launchAtLogin}
                onChange={(v) => void update({ launchAtLogin: v })}
              />
              <fieldset className="set-radio">
                <legend>Hareket</legend>
                {MOTION.map((m) => (
                  <label key={m.value}>
                    <input
                      type="radio"
                      name="set-motion"
                      value={m.value}
                      checked={value.reducedMotion === m.value}
                      onChange={() => void update({ reducedMotion: m.value })}
                    />
                    {m.label}
                  </label>
                ))}
              </fieldset>
              <fieldset className="set-radio">
                <legend>Görüntü kalitesi</legend>
                {QUALITY.map((q) => (
                  <label key={q.value}>
                    <input
                      type="radio"
                      name="set-quality"
                      value={q.value}
                      checked={value.renderQuality === q.value}
                      onChange={() => void update({ renderQuality: q.value })}
                    />
                    {q.label}
                  </label>
                ))}
              </fieldset>
              <p className="set-note">Dengeli: Retina ekranda 3B harita daha düşük çözünürlükte çizilir; GPU daha az çalışır (pil), küçük yazılar biraz yumuşar.</p>
              <FieldError field="general" />
            </Section>
            <Section title="Menü çubuğu">
              <Check
                id="set-mb-on"
                label="Menü çubuğunda göster"
                hint="Bekleyen sayısı ve session listesi; tek ekranla çalışırken pano kapalıyken de"
                checked={value.menuBar.enabled}
                onChange={(v) => void update({ menuBar: { enabled: v } })}
              />
              <Check
                id="set-mb-dock"
                label="Dock ikonunu gizle"
                hint={value.menuBar.enabled ? 'Uygulama yalnızca menü çubuğundan açılır; çıkış menü çubuğu listesinde' : 'Önce menü çubuğunu açın'}
                checked={value.menuBar.enabled && value.menuBar.hideDock}
                disabled={!value.menuBar.enabled}
                onChange={(v) => void update({ menuBar: { hideDock: v } })}
              />
            </Section>
            <TerminalSection value={value} />
            <Section title="Bildirimler">
              <Check id="set-n-wait" label="Onay bekleyince" checked={n.waiting} onChange={(v) => void update({ notifications: { waiting: v } })} />
              <Check id="set-n-done" label="Görev bitince" checked={n.done} onChange={(v) => void update({ notifications: { done: v } })} />
              <Check id="set-n-slow" label="Yavaş araç (3 dk+)" checked={n.slowTool} onChange={(v) => void update({ notifications: { slowTool: v } })} />
              <Check id="set-n-sound" label="Ses" checked={n.sound} onChange={(v) => void update({ notifications: { sound: v } })} />
              <Check
                id="set-n-redact"
                label="Bildirimde komut ayrıntısını gizle"
                hint="ekran paylaşırken"
                checked={n.redactLabels}
                onChange={(v) => void update({ notifications: { redactLabels: v } })}
              />
            </Section>
            <Shortcuts value={value} />
            <Hooks />
            <Projects value={value} />
          </div>
        )}
      </aside>
    </div>
  );
}
