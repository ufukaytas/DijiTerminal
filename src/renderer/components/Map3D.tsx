// 3B harita bileşeni (03/05–03/07). three.js ve sahne kodu yalnızca buradan yüklenir; MapView bunu
// React.lazy ile ayrı bir chunk olarak açar (05/02: ana bundle'ı küçük tutmak, liste görünümünde three yüklenmez).
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { CATEGORY_COLOR, STATUS_COLOR } from '@shared/constants';
import { shellColor } from '../lib/robotColor';
import { LiveEffects } from '../map3d/effects';
import { MapInteraction } from '../map3d/interaction';
import { tipContent } from '../map3d/robotLogic';
import { MapScene, type PickData } from '../map3d/scene';
import { activateSession } from '../state/actions';
import { useBoard } from '../state/board';
import { connectScene, firstSessionOfProject, hasWebGL, startPerfReporting } from './mapLink';
import { EmptyState, Loading } from './map/SessionGrid';
import { useReducedMotion } from './Shell';

const RESTART_AFTER_MS = 5000;
const TIP_TICK_MS = 1000;

/**
 * Robot ipucu kartı (03/08): ad, çip, durum, proje · session · model, şimdiki araç + süre, araç sayısı,
 * maliyet, ana ajanda ctx. Metinler yalnızca textContent ile yazılır (log içeriği HTML olarak yorumlanmaz).
 * Ajan bulunamazsa false döner (kart gizlenir).
 */
export function renderTip(box: HTMLElement, sessionId: string, agentId: string, now = Date.now()): boolean {
  const { snapshot } = useBoard.getState();
  const s = snapshot.sessions.find((x) => x.id === sessionId);
  const a = s?.agents.find((x) => x.id === agentId);
  if (!s || !a) return false;
  const p = snapshot.projects.find((x) => x.id === s.projectId);
  const tip = tipContent(a, s, p?.name ?? '', now);
  const mk = (tag: string, cls: string, text?: string) => {
    const e = document.createElement(tag);
    e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const head = mk('div', 'tip-h');
  const sw = mk('i', 'swatch');
  sw.style.background = shellColor(a, p?.color ?? '#5EA0FF');
  const chip = mk('span', 'tchip', tip.chip.label);
  chip.style.background = tip.chip.bg;
  chip.style.color = tip.chip.fg;
  head.append(sw, mk('b', 'tip-n', tip.name), chip, mk('span', `tip-st st-${tip.state}`, tip.stateWord));
  box.replaceChildren(
    head,
    mk('div', 'tip-w', tip.where),
    mk('div', 'tip-now', tip.now),
    mk('div', 'tip-s', tip.stats),
    mk('div', 'tip-k', tip.hint),
  );
  return true;
}

const LEGEND: [string, string][] = [
  ['okuma/arama', CATEGORY_COLOR.read],
  ['düzenleme', CATEGORY_COLOR.edit],
  ['bash', CATEGORY_COLOR.bash],
  ['web', CATEGORY_COLOR.web],
  ['onay bekliyor', STATUS_COLOR.waiting],
];

export default function Map3D({ onFail }: { onFail(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const ixRef = useRef<MapInteraction | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const booted = useBoard((s) => s.snapshot.booted);
  // Haritada yaşayan session yoksa boş durum (sona erenler haritadan kalkar, bkz. lib/mapScope).
  const empty = useBoard((s) => !s.snapshot.sessions.some((x) => x.status !== 'ended'));
  const [lost, setLost] = useState(false);
  const [restartable, setRestartable] = useState(false);
  const [gen, setGen] = useState(0);
  const [hintDim, setHintDim] = useState(false);

  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    if (!hasWebGL()) {
      onFail();
      return;
    }
    let restartTimer: ReturnType<typeof setTimeout> | null = null;
    let link: ReturnType<typeof connectScene> | null = null;
    // Hover'daki robot ve ipucu kartı; kart saniyede bir tazelenir (araç süresi).
    let hovered: { sessionId: string; agentId: string; x: number; y: number } | null = null;
    let tipTimer: ReturnType<typeof setInterval> | null = null;
    const tipBox = tipRef.current;
    const placeTip = () => {
      const box = tipBox;
      if (!box) return;
      if (!hovered || !renderTip(box, hovered.sessionId, hovered.agentId)) {
        box.hidden = true;
        return;
      }
      const r = host.getBoundingClientRect();
      const x = hovered.x - r.left;
      const y = hovered.y - r.top;
      box.hidden = false;
      // İmlecin sağ altında; kenara taşarsa sola/üste geçer.
      const w = box.offsetWidth;
      const h = box.offsetHeight;
      box.style.left = `${x + 14 + w > r.width ? Math.max(4, x - 14 - w) : x + 14}px`;
      box.style.top = `${y + 14 + h > r.height ? Math.max(4, y - 14 - h) : y + 14}px`;
    };
    const onHover = (p: PickData | null, x: number, y: number) => {
      const robot =
        p?.kind === 'agent' && p.sessionId && p.agentId ? { sessionId: p.sessionId, agentId: p.agentId } : null;
      scene.setHover(robot?.sessionId ?? null, robot?.agentId ?? null);
      hovered = robot ? { ...robot, x, y } : null;
      placeTip();
      if (hovered && !tipTimer) tipTimer = setInterval(placeTip, TIP_TICK_MS);
      else if (!hovered && tipTimer) {
        clearInterval(tipTimer);
        tipTimer = null;
      }
    };
    const debug = new URLSearchParams(window.location.search).get('debug') === '1';
    const scene = new MapScene({
      reducedMotion: reduced ? 'on' : 'off',
      debug,
      onSelectSession: (id) => link?.selectFromMap(id),
      onActivateSession: (id) => void activateSession(id),
      onContextLost: () => {
        setLost(true);
        restartTimer = setTimeout(() => setRestartable(true), RESTART_AFTER_MS);
      },
      onContextRestored: () => {
        if (restartTimer) clearTimeout(restartTimer);
        setLost(false);
        setRestartable(false);
      },
    });
    try {
      scene.mount(host);
    } catch (e) {
      console.error('[map] 3B görünüm açılamadı, listeye geçiliyor:', e);
      scene.dispose();
      onFail();
      return;
    }
    scene.setEffects(new LiveEffects(scene)); // 03/06: parçacıklar, nabız, ısı
    const ix = new MapInteraction(scene, {
      onSelect: (id, _src, agentId) => link?.selectFromMap(id, agentId),
      firstSessionOfProject,
      onActivate: (id) => void activateSession(id),
      onHover,
      isHidden: () => document.hidden,
    });
    scene.setInteraction(ix);
    ixRef.current = ix;
    link = connectScene(scene, ix);
    const stopPerf = startPerfReporting(scene); // 05/02: yalnızca DIJI_PERF=1 ölçümünde sürer
    return () => {
      if (restartTimer) clearTimeout(restartTimer);
      if (tipTimer) clearInterval(tipTimer);
      if (tipBox) tipBox.hidden = true;
      stopPerf();
      link?.dispose();
      ixRef.current = null;
      scene.dispose();
    };
  }, [reduced, gen, onFail]);

  const restart = useCallback(() => {
    setLost(false);
    setRestartable(false);
    setGen((g) => g + 1);
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return; // etiket düğmelerinde Enter/Tab kendi işini yapar
    if (ixRef.current?.handleKey(e.key)) e.preventDefault();
  };

  const dimHint = () => {
    if (hintDim) return;
    setTimeout(() => setHintDim(true), 10_000);
  };

  return (
    <div
      className="map3d"
      ref={ref}
      tabIndex={0}
      aria-label="Proje haritası"
      onKeyDown={onKeyDown}
      onPointerDown={dimHint}
    >
      <div className={hintDim ? 'hint dim' : 'hint'}>
        sürükle: döndür · sağ tık: kaydır · tekerlek: yakınlaş · tıkla: seç · çift tıkla: aç
      </div>
      <div className="map-tip" ref={tipRef} hidden role="tooltip" />
      {!booted && (
        <div className="map-over">
          <Loading />
        </div>
      )}
      {booted && empty && (
        <div className="map-over">
          <EmptyState />
        </div>
      )}
      {lost && (
        <div className="map-over" role="status">
          <div className="center-state">
            {restartable ? (
              <button type="button" className="btn" onClick={restart}>
                3B görünümü yeniden başlat
              </button>
            ) : (
              <p>3B görünüm yeniden başlatılıyor…</p>
            )}
          </div>
        </div>
      )}
      <div className="legend" aria-hidden="true">
        {LEGEND.map(([l, c]) => (
          <span key={l}>
            <i style={{ background: c }} />
            {l}
          </span>
        ))}
      </div>
    </div>
  );
}
