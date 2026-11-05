// Menü çubuğu açılır listesi (06/01): özet, session listesi (bekleyenler üstte), kullanım limitleri, eylemler.
// Yalnızca 2B bileşenler; three.js bu giriş noktasına girmez. Veri ana pencereyle aynı store'dan (03/01).
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { STATUS_COLOR } from '@shared/constants';
import type { DijiApi, TrayCommand } from '@shared/ipc';
import { focusLabel } from '@shared/terminalApp';
import type { UsageLimits } from '@shared/types';
import { AgentNow } from '../components/AgentNow';
import { useNow } from '../hooks/useNow';
import { fmtHotkey } from '../lib/format';
import { limitsView } from '../lib/limits';
import { useBoard } from '../state/board';
import { initBoardBridge } from '../state/bridge';
import { initSettingsBridge } from '../state/settings';
import { popoverModel, type PopoverRow } from './model';

const STATUS_LABEL = { waiting: 'onay bekliyor', busy: 'çalışıyor', idle: 'boşta', ended: 'sona erdi' } as const;
const ERROR_MS = 4000;

type Command = (cmd: TrayCommand, sessionId?: string) => void;

const Row = memo(function Row({
  row,
  onFocus,
  onMap,
}: {
  row: PopoverRow;
  onFocus: (id: string) => void;
  onMap: (id: string) => void;
}) {
  const s = row.session;
  const main = s.agents[0];
  const name = s.name || s.title || s.id.slice(0, 8);
  const key = fmtHotkey(s.hotkey);
  return (
    <li className={`pv-row st-${s.status}`}>
      <button
        type="button"
        className="pv-main"
        onClick={() => onFocus(s.id)}
        title={s.background ? 'Uygulamada aç (arka plan session\'ı)' : focusLabel(s.terminal?.app)}
      >
        <span className="pv-line">
          <span className="pv-dot" style={{ background: STATUS_COLOR[s.status] }} aria-label={STATUS_LABEL[s.status]} />
          <span className="pv-name">{name}</span>
          {row.project && (
            <span className="pv-proj" style={{ color: row.project.color }}>
              {row.project.name}
            </span>
          )}
          {s.background && <span className="pv-bg">ARKA PLAN</span>}
          {key && <span className="pv-key">{key}</span>}
        </span>
        {main && <AgentNow agent={main} session={s} />}
      </button>
      <button
        type="button"
        className="pv-map"
        onClick={() => onMap(s.id)}
        title="Haritada göster"
        aria-label={`${name}: haritada göster`}
      >
        ⌖
      </button>
    </li>
  );
});

function Limits({ limits }: { limits: UsageLimits | null }) {
  const now = useNow(1000);
  const v = limitsView(limits, now);
  if (!v) return null;
  return (
    <div className={v.stale ? 'pv-limits stale' : 'pv-limits'} aria-label="Kullanım limitleri" title={v.updatedLabel}>
      {v.items.map((it) => (
        <div key={it.key} className={`pv-limit l-${it.level}`} title={it.title}>
          <span className="pv-limit-label">{it.label}</span>
          <span className="pv-limit-bar" aria-hidden="true">
            <i style={{ width: `${it.pct}%` }} />
          </span>
          <span className="pv-limit-pct">{it.reset ? 'sıfır' : `%${it.pct}`}</span>
          {it.resetsLabel && <span className="pv-limit-reset">{it.resetsLabel}</span>}
        </div>
      ))}
    </div>
  );
}

export function PopoverApp({
  api = typeof window !== 'undefined' ? window.diji : undefined,
}: {
  api?: DijiApi | undefined;
}) {
  useEffect(() => initBoardBridge(api), [api]);
  useEffect(() => initSettingsBridge(api), [api]);
  const snapshot = useBoard((s) => s.snapshot);
  const connection = useBoard((s) => s.connection);
  const model = useMemo(() => popoverModel(snapshot), [snapshot]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), ERROR_MS);
    return () => clearTimeout(t);
  }, [error]);

  const command: Command = useCallback(
    (cmd, sessionId) => {
      if (!api) return;
      void (sessionId ? api.invoke('tray:command', cmd, sessionId) : api.invoke('tray:command', cmd)).catch(
        () => undefined,
      );
    },
    [api],
  );

  const focusSession = useCallback(
    async (id: string) => {
      if (!api) return;
      // 07/01: arka plan session'ı ana pencerede gömülü terminalde açılır.
      if (snapshot.sessions.find((x) => x.id === id)?.background) {
        command('openInApp', id);
        return;
      }
      try {
        const r = await api.invoke('action:focusTerminal', id);
        if (r.ok) command('close');
        else setError(r.error.message);
      } catch {
        setError('Terminal sekmesine geçilemedi.');
      }
    },
    [api, command, snapshot.sessions],
  );
  const showOnMap = useCallback((id: string) => command('showOnMap', id), [command]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') command('close');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [command]);

  const tone = model.waiting > 0 ? 'wait' : model.busy > 0 ? 'busy' : 'idle';
  return (
    <div className="pv">
      <header className="pv-head">
        <span className="pv-title">DijiTerminal</span>
        <span className={`pv-summary t-${tone}`}>
          {connection === 'error' ? 'Motora bağlanılamadı' : model.summary}
        </span>
      </header>
      {model.rows.length > 0 ? (
        <ul className="pv-list" aria-label="Session'lar">
          {model.rows.map((row) => (
            <Row key={row.session.id} row={row} onFocus={(id) => void focusSession(id)} onMap={showOnMap} />
          ))}
        </ul>
      ) : (
        <div className="pv-empty">
          {snapshot.booted
            ? "Claude Code'da açık session yok. Yeni bir session başlatınca burada görünür."
            : "Session'lar okunuyor…"}
        </div>
      )}
      {error && (
        <div className="pv-error" role="alert">
          {error}
        </div>
      )}
      <Limits limits={snapshot.limits} />
      <footer className="pv-foot">
        <button type="button" onClick={() => command('openBoard')}>
          Panoyu aç
        </button>
        <button type="button" onClick={() => command('openSettings')}>
          Ayarlar
        </button>
        <button type="button" className="pv-quit" onClick={() => command('quit')}>
          Çıkış
        </button>
      </footer>
    </div>
  );
}
