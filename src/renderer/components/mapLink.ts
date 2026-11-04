// MapScene ↔ store bağlantısı ve yardımcılar (03/07). Bu dosya three.js'i yalnızca tip olarak görür;
// ana bundle'da kalır, 3B harita (Map3D.tsx) ayrı chunk olarak yüklenir (05/02).
import type { DijiApi, RendererPerfSample } from '@shared/ipc';
import type { MapInteraction } from '../map3d/interaction';
import type { MapPerfSample, MapScene } from '../map3d/scene';
import { subscribeEvents, useBoard } from '../state/board';

/** Tarayıcıda WebGL API'si var mı (jsdom'da yok; o zaman denemeden listeye düşülür). */
export function hasWebGL(): boolean {
  return typeof window !== 'undefined' && ('WebGL2RenderingContext' in window || 'WebGLRenderingContext' in window);
}

/** Projenin ilk session'ı: bekleyen → çalışan → boşta. */
export function firstSessionOfProject(projectId: string): string | null {
  const { snapshot } = useBoard.getState();
  const p = snapshot.projects.find((x) => x.id === projectId);
  if (!p) return null;
  const ss = p.sessionIds.map((id) => snapshot.sessions.find((s) => s.id === id)).filter((s) => s !== undefined);
  for (const st of ['waiting', 'busy', 'idle'] as const) {
    const hit = ss.find((s) => s.status === st);
    if (hit) return hit.id;
  }
  return ss[0]?.id ?? null;
}

/**
 * MapScene'i store'a bağlar. Seçim döngüsü: haritadan gelen seçim store'a yazılır ama kamerayı
 * ikinci kez uçurmaz; snapshot ile birlikte gelen otomatik seçim de uçurmaz (açılışta ev konumu kalır).
 * Aynı anda hem seçim hem proje odağı değişirse (Bekleyene git) session odağı kazanır.
 */
export function connectScene(
  scene: Pick<MapScene, 'update' | 'select' | 'handleEvents'>,
  ix: Pick<MapInteraction, 'focusSession' | 'focusProject'>,
) {
  let source: 'map' | null = null;
  let want: { session?: string; project?: string | 'all' } | null = null;
  let disposed = false;

  const flush = () => {
    const w = want;
    want = null;
    if (!w || disposed) return;
    if (w.session) ix.focusSession(w.session);
    else if (w.project !== undefined) ix.focusProject(w.project);
  };
  const schedule = (patch: { session?: string; project?: string | 'all' }) => {
    const first = want === null;
    want = { ...(want ?? {}), ...patch };
    if (first) queueMicrotask(flush);
  };

  const st = useBoard.getState();
  scene.update(st.snapshot);
  scene.select(st.selectedSessionId);

  const offs = [
    useBoard.subscribe((s, prev) => {
      if (s.snapshot !== prev.snapshot) scene.update(s.snapshot);
      if (s.selectedSessionId !== prev.selectedSessionId) {
        scene.select(s.selectedSessionId);
        const auto = s.snapshot !== prev.snapshot; // setSnapshot içindeki otomatik seçim
        if (source !== 'map' && !auto && s.selectedSessionId) schedule({ session: s.selectedSessionId });
        source = null;
      }
      if (s.focusProjectId !== prev.focusProjectId) schedule({ project: s.focusProjectId });
    }),
    subscribeEvents((e) => scene.handleEvents(e)),
  ];

  return {
    /** Haritada yapılan seçim: store'a yaz, kamerayı ikinci kez uçurma. */
    selectFromMap(id: string, agentId?: string) {
      source = 'map';
      useBoard.getState().select(id, agentId);
      source = null;
    },
    dispose() {
      disposed = true;
      for (const off of offs) off();
    },
  };
}

export const PERF_REPORT_MS = 2000;

/**
 * Çizim döngüsü ölçümünü main'e gönderir (05/02 bench). Main ölçüm kapalıysa `false` döner; o zaman
 * gönderim durur (normal kullanımda yalnızca ilk 2 sn'de bir IPC çağrısı olur).
 */
export function startPerfReporting(
  scene: { perfSample(): MapPerfSample | null },
  api: Pick<DijiApi, 'invoke'> | undefined = typeof window !== 'undefined' ? window.diji : undefined,
  heapMb: () => number | null = () => {
    const m = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    return m ? Math.round((m.usedJSHeapSize / 1048576) * 10) / 10 : null;
  },
): () => void {
  if (!api) return () => {};
  let stopped = false;
  const timer = setInterval(() => {
    const s = scene.perfSample();
    if (!s || stopped) return;
    const sample: RendererPerfSample = { ...s, jsHeapMb: heapMb() };
    api.invoke('perf:renderer', sample).then(
      (r) => {
        if (!r.ok || r.data === false) stop();
      },
      () => stop(),
    );
  }, PERF_REPORT_MS);
  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };
  return stop;
}
