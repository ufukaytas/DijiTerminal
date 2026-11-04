// MapScene (03/05): React'tan bağımsız, imperative 3B harita. Snapshot'tan keyed diff ile güncellenir.
// 06 (efektler) setEffects, 07 (etkileşim) setInteraction ile aynı çizim döngüsüne bağlanır.
// Çizim döngüsü (05/02): RenderLoop — aktif 60 fps, yavaş animasyonda 15 fps, boşta 4 fps, gizliyken durur.
import * as THREE from 'three';
import type { AppSettings, BoardEvent, BoardSnapshot, SessionView } from '@shared/types';
import { PickRegistry, type PickData, type PickKind, type SceneEnv } from './env';
import { disposeShared, disposeTree, glowTexture, orphanGeometries } from './geometries';
import { createLabelRenderer } from './labels';
import { gridExtent, gridLayout, type GridExtent } from './layout';
import { ProjectNode } from './platform';
import { mapScope } from '../lib/mapScope';
import { currentQuality, pixelRatioFor, watchQuality } from './quality';
import { resolveReducedMotion } from './reducedMotion';
import { CAMERA_FOV, HOME_BASE } from './camera';
import { DEMAND_NONE, RenderLoop, type Demand, type LoopMode, type LoopStats } from './renderLoop';
import { WEB_CENTER, WebGlobe } from './web';

export type { PickData, PickKind };

export interface MapSceneOptions {
  onSelectSession(sessionId: string): void;
  /** Etikete çift tıklama — terminali öne getir (04/01). */
  onActivateSession?(sessionId: string): void;
  onContextLost?(): void;
  onContextRestored?(): void;
  /** Web küresinin rozetine tıklandı (kamera küreye yaklaşır). */
  onFocusWeb?(): void;
  reducedMotion?: AppSettings['reducedMotion'];
  /** `?debug=1` gibi: köşede fps / draw call / kaynak sayıları. */
  debug?: boolean;
}

export interface SceneAnchors {
  agentPos(sessionId: string, agentId: string | null): THREE.Vector3 | null;
  filePos(projectId: string, path: string): THREE.Vector3 | null;
  shellPos(projectId: string): THREE.Vector3 | null;
  /** Web isteklerinin hedefi: web küresinin alt yüzeyi. */
  haloPos(): THREE.Vector3;
  /** Web küresinin merkezi (kamera odağı). */
  webCenter(): THREE.Vector3;
  sessionTop(sessionId: string): THREE.Vector3 | null;
  sessionBase(sessionId: string): THREE.Vector3 | null;
  projectCenter(projectId: string): THREE.Vector3 | null;
}

export interface SceneEffects {
  handle(events: BoardEvent[]): void;
  /** Döngünün bir sonraki kare için hız ihtiyacı (05/02). */
  demand?(): Demand;
  dispose(): void;
}
export interface SceneInteraction {
  focusProject(id: string | 'all'): void;
  focusSession(id: string): void;
  focusWeb?(): void;
  onResize?(aspect: number): void;
  onGridChanged?(extent: GridExtent): void;
  demand?(): Demand;
  dispose(): void;
}

/** Renderer'ın bench'e (05/02) bildirdiği periyodik ölçüm. */
export interface MapPerfSample extends LoopStats {
  calls: number;
  geometries: number;
  textures: number;
  /** GPU'da olup sahnede ya da paylaşılan önbellekte olmayan geometriler (sızıntı ölçüsü). */
  orphanGeometries: number;
}

const LABEL_TICK_MS = 500;

export class MapScene {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.1, 320);
  readonly anchors: SceneAnchors;
  readonly reducedMotion: boolean;
  private renderer: THREE.WebGLRenderer | null = null;
  private labels: ReturnType<typeof createLabelRenderer> | null = null;
  private host: HTMLElement | null = null;
  private readonly picks = new PickRegistry();
  private env: SceneEnv | null = null;
  private readonly projects = new Map<string, ProjectNode>();
  /** Kararlı proje sırası: ilk görülme sırası, yeni proje sona. */
  private order: string[] = [];
  private last: BoardSnapshot | null = null;
  private selected: string | null = null;
  private web: WebGlobe | null = null;
  /** Hover'daki robot (etiket ve baloncuk gösterimi). */
  private hover: { sessionId: string; agentId: string } | null = null;
  private hooks = new Set<(t: number, dt: number) => void>();
  private updateHooks = new Set<(s: BoardSnapshot) => void>();
  private restoreHooks = new Set<() => void>();
  private debugInfo: (() => string) | null = null;
  private loop: RenderLoop | null = null;
  private lastLabelTick = 0;
  private lost = false;
  private effects: SceneEffects | null = null;
  private interaction: SceneInteraction | null = null;
  private ro: ResizeObserver | null = null;
  private dprQuery: MediaQueryList | null = null;
  private extentKey = '';
  private debugEl: HTMLElement | null = null;
  private frames = 0;
  private fpsAt = 0;
  private readonly cleanups: (() => void)[] = [];

  constructor(private readonly opts: MapSceneOptions) {
    this.reducedMotion = resolveReducedMotion(opts.reducedMotion ?? 'system');
    this.camera.position.set(HOME_BASE.pos.x, HOME_BASE.pos.y, HOME_BASE.pos.z);
    this.camera.lookAt(HOME_BASE.target.x, HOME_BASE.target.y, HOME_BASE.target.z);
    this.anchors = {
      agentPos: (sid, aid) => this.sessionNode(sid)?.worldPos(aid) ?? null,
      filePos: (pid, path) => this.projects.get(pid)?.fileWorld(path) ?? null,
      shellPos: (pid) => this.projects.get(pid)?.shellWorld() ?? null,
      haloPos: () => this.web?.surfaceTarget() ?? WEB_CENTER.clone(),
      webCenter: () => this.web?.center() ?? WEB_CENTER.clone(),
      sessionTop: (sid) => this.sessionNode(sid)?.topWorld() ?? null,
      sessionBase: (sid) => this.sessionNode(sid)?.baseWorld() ?? null,
      projectCenter: (pid) => this.projects.get(pid)?.centerWorld() ?? null,
    };
  }

  get pickables(): THREE.Object3D[] {
    return this.picks.list;
  }

  get domElement(): HTMLCanvasElement {
    if (!this.renderer) throw new Error('MapScene mount edilmedi');
    return this.renderer.domElement;
  }

  /** Grid'in kapladığı alan (kamera ev konumu). */
  get extent(): GridExtent {
    return gridExtent(this.order.length);
  }

  get isMounted(): boolean {
    return this.renderer !== null;
  }

  /** WebGL yoksa hata fırlatır; MapView 2B listeye düşer. */
  mount(el: HTMLElement): void {
    this.host = el;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(pixelRatioFor(window.devicePixelRatio || 1, currentQuality()));
    renderer.setClearColor(0x0b0e13, 1);
    renderer.domElement.className = 'map-canvas';
    el.appendChild(renderer.domElement);
    this.renderer = renderer;
    this.labels = createLabelRenderer(el);
    this.loop = new RenderLoop((t, dt, mode) => this.frame(t, dt, mode));

    this.env = {
      createCanvas: (w, h) => {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        return c;
      },
      maxAnisotropy: renderer.capabilities.getMaxAnisotropy(),
      reducedMotion: this.reducedMotion,
      glow: glowTexture((w, h) => {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        return c;
      }),
      picks: this.picks,
      now: () => Date.now(),
      fontsReady: fontsReady(),
      onSessionClick: (id) => {
        this.opts.onSelectSession(id);
        this.interaction?.focusSession(id);
      },
      onSessionDblClick: (id) => this.opts.onActivateSession?.(id),
    };

    this.buildStatic();
    this.setupResize(el);
    this.setupContextLoss(renderer.domElement);

    // Sayfa gizli (pencere gizli/simge durumunda/örtülü): hiç kare yok.
    const onVis = () => this.loop?.setStopped('hidden', document.hidden);
    document.addEventListener('visibilitychange', onVis);
    this.cleanups.push(() => document.removeEventListener('visibilitychange', onVis));

    if (this.opts.debug) {
      this.debugEl = el.appendChild(document.createElement('div'));
      this.debugEl.className = 'map-debug';
    }
    onVis();
    this.loop.requestFrame();
  }

  private buildStatic(): void {
    const s = this.scene;
    s.fog = new THREE.Fog(0x0b0e13, 70, 150);
    s.add(new THREE.AmbientLight(0xb8c4dc, 0.45));
    // Robot gövdeleri için gökyüzü/zemin ışığı ve arkadan hafif bir kenar ışığı (03/08).
    s.add(new THREE.HemisphereLight(0xdfe8ff, 0x1a1f2a, 0.55));
    const sun = new THREE.DirectionalLight(0xffffff, 1.1);
    sun.position.set(-12, 30, 18);
    const rim = new THREE.DirectionalLight(0x9ec8ff, 0.6);
    rim.position.set(14, 10, -20);
    s.add(sun, rim);
    const grid = new THREE.GridHelper(80, 40, 0x1a2030, 0x141a24);
    grid.position.y = 0.001;
    s.add(grid);

    const env = this.env!;
    const q = currentQuality();
    this.web = new WebGlobe(
      env,
      () => {
        this.opts.onFocusWeb?.();
        this.interaction?.focusWeb?.();
      },
      q,
      pixelRatioFor(window.devicePixelRatio || 1, q),
    );
    s.add(this.web.group);
  }

  private setupResize(host: HTMLElement): void {
    const resize = () => {
      if (!this.renderer || !this.labels) return;
      const r = host.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width));
      const h = Math.max(1, Math.round(r.height));
      this.renderer.setSize(w, h, false);
      this.labels.setSize(w, h);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.interaction?.onResize?.(this.camera.aspect);
      // Boyut değişince tuval temizlenir: seyrek moddaysa bir sonraki kareyi beklemeden çiz.
      if (this.loop?.mode !== 'active') this.renderOnce();
      this.loop?.requestFrame();
    };
    this.ro = new ResizeObserver(resize);
    this.ro.observe(host);
    resize();

    // Retina ↔ harici monitör arasında taşınınca piksel oranı değişir.
    const watchDpr = () => {
      this.dprQuery?.removeEventListener('change', onDpr);
      this.dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      this.dprQuery.addEventListener('change', onDpr);
    };
    const onDpr = () => {
      const pr = pixelRatioFor(window.devicePixelRatio || 1, currentQuality());
      this.renderer?.setPixelRatio(pr);
      this.web?.setQuality(currentQuality(), pr);
      resize();
      watchDpr();
    };
    if (typeof window.matchMedia === 'function') watchDpr();
    this.cleanups.push(() => this.dprQuery?.removeEventListener('change', onDpr));
    // Ayarlardaki görüntü kalitesi (Yüksek / Dengeli) değişince piksel oranını yeniden kur.
    this.cleanups.push(
      watchQuality((q) => {
        const pr = pixelRatioFor(window.devicePixelRatio || 1, q);
        this.renderer?.setPixelRatio(pr);
        // Dengeli: web küresinde yarı nokta (05/02 GPU işi).
        this.web?.setQuality(q, pr);
        resize();
      }),
    );
  }

  private setupContextLoss(canvas: HTMLCanvasElement): void {
    const lost = (e: Event) => {
      e.preventDefault();
      this.lost = true;
      this.loop?.setStopped('lost', true);
      this.opts.onContextLost?.();
    };
    const restored = () => {
      this.lost = false;
      // GPU kaynakları gitti: düğümleri son snapshot'tan yeniden kur.
      for (const n of this.projects.values()) n.dispose();
      this.projects.clear();
      this.order = [];
      this.web?.reset();
      for (const cb of this.restoreHooks) cb();
      if (this.last) this.update(this.last);
      this.loop?.setStopped('lost', false);
      this.opts.onContextRestored?.();
    };
    canvas.addEventListener('webglcontextlost', lost);
    canvas.addEventListener('webglcontextrestored', restored);
    this.cleanups.push(() => {
      canvas.removeEventListener('webglcontextlost', lost);
      canvas.removeEventListener('webglcontextrestored', restored);
    });
  }

  update(snapshot: BoardSnapshot): void {
    this.last = snapshot;
    const env = this.env;
    if (!env) return;
    const nowMs = performance.now();
    const now = env.now();
    if (!snapshot.booted) return;
    // Sona eren session'lar ve yaşayan session'ı kalmayan projeler haritadan hemen kalkar (lib/mapScope).
    const scope = mapScope(snapshot);

    const live = new Set(scope.projects.map((p) => p.id));
    for (const [id, n] of this.projects) {
      if (!live.has(id)) {
        n.dispose();
        this.projects.delete(id);
      }
    }
    this.order = this.order.filter((id) => live.has(id));
    for (const p of scope.projects) if (!this.order.includes(p.id)) this.order.push(p.id);

    const byId = new Map<string, SessionView>(scope.sessions.map((s) => [s.id, s]));
    const slots = gridLayout(this.order.length);
    const byProject = new Map(scope.projects.map((p) => [p.id, p]));
    this.order.forEach((id, i) => {
      const p = byProject.get(id)!;
      let n = this.projects.get(id);
      if (!n) {
        n = new ProjectNode(id, env);
        this.projects.set(id, n);
        this.scene.add(n.group);
      }
      n.place(slots[i]!.x, slots[i]!.z, nowMs);
      n.sync(p, byId, nowMs, now);
    });
    this.applySelection();

    const ext = this.extent;
    const key = `${ext.w}x${ext.d}:${ext.n}`; // proje sayısı değişince ev konumu yeniden sığdırılır
    if (key !== this.extentKey) {
      this.extentKey = key;
      this.interaction?.onGridChanged?.(ext);
    }
    this.web?.sync(snapshot, now);
    for (const cb of this.updateHooks) cb(snapshot);
    this.loop?.requestFrame();
  }

  handleEvents(events: BoardEvent[]): void {
    this.effects?.handle(events);
    if (events.length) this.loop?.requestFrame();
  }

  select(sessionId: string | null): void {
    this.selected = sessionId;
    this.applySelection();
    this.loop?.requestFrame();
  }

  /** Döngüyü uyandır: bir sonraki ekran yenilemesinde çiz (etkileşim, klavye). */
  requestFrame(): void {
    this.loop?.requestFrame();
  }

  /** Döngünün o anki modu (test, debug). */
  get loopMode(): LoopMode {
    return this.loop?.mode ?? 'stopped';
  }

  /** Son çağrıdan bu yana döngü istatistikleri + three sayaçları (05/02 bench). */
  perfSample(): MapPerfSample | null {
    if (!this.loop || !this.renderer) return null;
    const i = this.renderer.info;
    return {
      ...this.loop.takeStats(),
      calls: i.render.calls,
      geometries: i.memory.geometries,
      textures: i.memory.textures,
      orphanGeometries: orphanGeometries(this.scene, i.memory.geometries),
    };
  }

  private applySelection(): void {
    for (const p of this.projects.values()) {
      for (const [id, s] of p.sessions) s.setSelected(id === this.selected);
      p.setHover(this.hover?.sessionId ?? null, this.hover?.agentId ?? null);
    }
  }

  /** Hover'daki robot: isim etiketi ve araç baloncuğu görünür (03/08). */
  setHover(sessionId: string | null, agentId: string | null): void {
    const next = sessionId && agentId ? { sessionId, agentId } : null;
    if (next?.sessionId === this.hover?.sessionId && next?.agentId === this.hover?.agentId) return;
    this.hover = next;
    for (const p of this.projects.values()) p.setHover(next?.sessionId ?? null, next?.agentId ?? null);
    this.loop?.requestFrame();
  }

  focusProject(projectId: string | 'all'): void {
    this.interaction?.focusProject(projectId);
  }

  focusSession(sessionId: string): void {
    this.interaction?.focusSession(sessionId);
  }

  setEffects(fx: SceneEffects): void {
    this.effects?.dispose();
    this.effects = fx;
    this.loop?.requestFrame();
  }

  setInteraction(ix: SceneInteraction): void {
    this.interaction?.dispose();
    this.interaction = ix;
    ix.onResize?.(this.camera.aspect);
    ix.onGridChanged?.(this.extent);
    this.loop?.requestFrame();
  }

  onFrame(cb: (t: number, dt: number) => void): () => void {
    this.hooks.add(cb);
    return () => {
      this.hooks.delete(cb);
    };
  }

  /** Snapshot uygulandıktan sonra (06: sürekli efekt girdileri). */
  onUpdate(cb: (s: BoardSnapshot) => void): () => void {
    this.updateHooks.add(cb);
    return () => {
      this.updateHooks.delete(cb);
    };
  }

  /** WebGL bağlamı geri geldi, düğümler yeniden kurulmadan hemen önce (06: havuzu boşalt). */
  onRestore(cb: () => void): () => void {
    this.restoreHooks.add(cb);
    return () => {
      this.restoreHooks.delete(cb);
    };
  }

  /** `?debug=1` satırına eklenecek metin (06: parçacık / kuyruk). */
  setDebugInfo(fn: (() => string) | null): void {
    this.debugInfo = fn;
  }

  get lastSnapshot(): BoardSnapshot | null {
    return this.last;
  }

  /** Paylaşılan glow texture (mount sonrası). */
  get glow(): THREE.Texture | null {
    return this.env?.glow ?? null;
  }

  projectNode(id: string): ProjectNode | undefined {
    return this.projects.get(id);
  }

  projectNodes(): Iterable<ProjectNode> {
    return this.projects.values();
  }

  sessionNodeById(sessionId: string) {
    return this.sessionNode(sessionId);
  }

  /** Web küresi (06: ısı ve dalga). */
  webGlobe(): WebGlobe | null {
    return this.web;
  }

  /** Bir session'ın düğümü (görünüyorsa). */
  private sessionNode(sessionId: string) {
    for (const p of this.projects.values()) {
      const s = p.sessions.get(sessionId);
      if (s) return s;
    }
    return null;
  }

  /** Bir session'ın projesi (gösterilmese bile; 07 için). */
  projectOfSession(sessionId: string): string | null {
    return this.last?.sessions.find((s) => s.id === sessionId)?.projectId ?? null;
  }

  /**
   * Bir kare: geçişler, efektler, etkileşim, etiketler ve çizim. Dönüş: bir sonraki kare için hız ihtiyacı.
   * `mode` bu kareyi planlayan mod; boştayken dekoratif dönme/salınım (amblem, halo) ilerlemez.
   */
  private frame(t: number, dt: number, mode: Exclude<LoopMode, 'stopped'>): Demand {
    const decor = mode !== 'idle';
    let d: Demand = DEMAND_NONE;
    const view = { camera: this.camera.position, halo: this.anchors.haloPos() };
    for (const p of this.projects.values()) d = Math.max(d, p.step(t, dt, decor, view)) as Demand;
    if (this.web) d = Math.max(d, this.web.step(dt, decor, this.camera.position)) as Demand;
    for (const cb of this.hooks) cb(t, dt);
    if (t - this.lastLabelTick >= LABEL_TICK_MS) {
      this.lastLabelTick = t;
      const now = Date.now();
      for (const p of this.projects.values()) p.tickLabels(now);
      this.updateDebug(t);
    }
    this.renderOnce();
    this.frames++;
    const fx = this.effects?.demand?.() ?? DEMAND_NONE;
    const ix = this.interaction?.demand?.() ?? DEMAND_NONE;
    return Math.max(d, fx, ix) as Demand;
  }

  private renderOnce(): void {
    if (!this.renderer || !this.labels || this.lost) return;
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }

  private updateDebug(t: number): void {
    if (!this.debugEl || !this.renderer) return;
    const secs = (t - this.fpsAt) / 1000;
    const fps = secs > 0 ? Math.round(this.frames / secs) : 0;
    this.frames = 0;
    this.fpsAt = t;
    const i = this.renderer.info;
    const extra = this.debugInfo ? ` · ${this.debugInfo()}` : '';
    this.debugEl.textContent = `${fps} fps · ${this.loop?.mode ?? '—'} · ${i.render.calls} draw · geo ${i.memory.geometries} · tex ${i.memory.textures} · pick ${this.picks.size}${extra}`;
  }

  /** Testler ve dev overlay için kaynak sayıları. */
  stats(): { projects: number; sessions: number; picks: number; geometries: number; textures: number } {
    let sessions = 0;
    for (const p of this.projects.values()) sessions += p.sessions.size;
    const m = this.renderer?.info.memory;
    return {
      projects: this.projects.size,
      sessions,
      picks: this.picks.size,
      geometries: m?.geometries ?? 0,
      textures: m?.textures ?? 0,
    };
  }

  dispose(): void {
    this.loop?.dispose();
    this.loop = null;
    this.effects?.dispose();
    this.effects = null;
    this.interaction?.dispose();
    this.interaction = null;
    this.hooks.clear();
    this.updateHooks.clear();
    this.restoreHooks.clear();
    this.debugInfo = null;
    for (const c of this.cleanups.splice(0)) c();
    this.ro?.disconnect();
    this.web?.dispose();
    this.web = null;
    for (const n of this.projects.values()) n.dispose();
    this.projects.clear();
    for (const c of [...this.scene.children]) disposeTree(c); // ızgara, halo, ışıklar
    this.scene.clear();
    disposeShared();
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.forceContextLoss();
      this.renderer.domElement.remove();
      this.renderer = null;
    }
    this.labels?.domElement.remove();
    this.labels = null;
    this.debugEl?.remove();
    this.host = null;
    this.env = null;
  }
}

function fontsReady(): Promise<unknown> {
  if (typeof document === 'undefined' || !document.fonts) return Promise.resolve();
  return Promise.all([
    document.fonts.load("600 168px 'IBM Plex Sans'"),
    document.fonts.load("400 50px 'IBM Plex Mono'"),
    document.fonts.load("500 54px 'IBM Plex Mono'"),
    document.fonts.load("600 46px 'IBM Plex Mono'"),
  ]);
}
