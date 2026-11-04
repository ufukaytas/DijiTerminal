// Orta sütun (03/05, 03/06, 03/07): 3B harita. MapScene React dışında çizer; 3B kısım (Map3D.tsx) ayrı bir
// chunk olarak tembel yüklenir (05/02). WebGL yoksa, chunk yüklenemezse ya da kullanıcı "liste"yi seçtiyse
// Sprint 2'nin 2B görünümü gösterilir.
import { lazy, Suspense, useCallback, useEffect, useState, type ComponentType } from 'react';
import { hasWebGL } from './mapLink';
import { Loading, SessionGrid } from './map/SessionGrid';

export { connectScene, firstSessionOfProject, hasWebGL } from './mapLink';

export type MapMode = '3d' | 'list';
const MODE_KEY = 'diji.mapMode';

function readMode(): MapMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'list' ? 'list' : '3d';
  } catch {
    return '3d';
  }
}
function writeMode(m: MapMode): void {
  try {
    localStorage.setItem(MODE_KEY, m);
  } catch {
    /* depolama kapalı: tercih yalnızca bu oturumda */
  }
}

type Map3DProps = { onFail(): void };

/** Chunk yüklenemezse (bozuk paket vb.) listeye düşürür. */
function LoadFailed({ onFail }: Map3DProps) {
  useEffect(() => {
    onFail();
  }, [onFail]);
  return null;
}

const Map3D = lazy<ComponentType<Map3DProps>>(() =>
  import('./Map3D').catch((e: unknown) => {
    console.error('[map] 3B harita yüklenemedi, listeye geçiliyor:', e);
    return { default: LoadFailed };
  }),
);

export function MapView() {
  const [mode, setMode] = useState<MapMode>(readMode);
  // WebGL hiç yoksa 3B chunk'ını yüklemeye bile çalışma.
  const [failed, setFailed] = useState(() => !hasWebGL());
  const onFail = useCallback(() => setFailed(true), []);
  const choose = (m: MapMode) => {
    setMode(m);
    writeMode(m);
  };
  const show3d = mode === '3d' && !failed;
  return (
    <div className="mapview">
      {show3d ? (
        <Suspense
          fallback={
            <div className="map3d">
              <div className="map-over">
                <Loading />
              </div>
            </div>
          }
        >
          <Map3D onFail={onFail} />
        </Suspense>
      ) : (
        <SessionGrid />
      )}
      <div className="map-mode" role="group" aria-label="Harita görünümü">
        <button
          type="button"
          aria-pressed={show3d}
          disabled={failed}
          onClick={() => choose('3d')}
          title={failed ? 'WebGL kullanılamıyor' : undefined}
        >
          3B
        </button>
        <button type="button" aria-pressed={!show3d} onClick={() => choose('list')}>
          liste
        </button>
      </div>
    </div>
  );
}
