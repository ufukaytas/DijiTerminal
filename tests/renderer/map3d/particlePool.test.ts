// ParticlePool (03/06): kapasite, onArrive, kuyruk, dispose — renderer'sız three sahnesi.
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { arcControl, easeInOutQuad, HEADS, ParticlePool } from '@renderer/map3d/particles';

const A = new THREE.Vector3(0, 0, 0);
const B = new THREE.Vector3(10, 0, 0);

describe('ParticlePool', () => {
  it('kapasite × 3 sprite önceden oluşturulur, hepsi gizli', () => {
    const scene = new THREE.Scene();
    const pool = new ParticlePool(scene, 4);
    expect(pool.sprites()).toHaveLength(4 * HEADS);
    expect(pool.sprites().every((s) => !s.visible)).toBe(true);
    expect(pool.liveCount).toBe(0);
  });

  it("t ≥ 1'de tek onArrive; kuyruk varınca slot serbest", () => {
    const pool = new ParticlePool(new THREE.Scene(), 2);
    const arrive = vi.fn();
    pool.spawn({ from: A, to: B, color: '#C98BFF', durationMs: 1000, onArrive: arrive });
    pool.update(0.5);
    expect(arrive).not.toHaveBeenCalled();
    expect(pool.liveCount).toBe(1);
    pool.update(0.5);
    expect(arrive).toHaveBeenCalledTimes(1);
    pool.update(0.1);
    expect(arrive).toHaveBeenCalledTimes(1);
    expect(pool.liveCount).toBe(1); // kuyruk hâlâ uçuyor
    pool.update(0.1);
    expect(pool.liveCount).toBe(0);
    expect(pool.sprites().every((s) => !s.visible)).toBe(true);
  });

  it('baş Bezier üzerinde, kuyruk geriden gelir; yay yukarı kavisli', () => {
    const pool = new ParticlePool(new THREE.Scene(), 1);
    pool.spawn({ from: A, to: B, color: '#fff', durationMs: 1000 });
    pool.update(0.5);
    const [head, t1, t2] = pool.sprites() as THREE.Sprite[];
    expect(head!.visible && t1!.visible && t2!.visible).toBe(true);
    expect(head!.position.x).toBeGreaterThan(t1!.position.x);
    expect(t1!.position.x).toBeGreaterThan(t2!.position.x);
    expect(head!.position.y).toBeGreaterThan(1);
    const c = arcControl(A, B, new THREE.Vector3());
    expect(c.toArray()).toEqual([5, 1.4 + 10 * 0.18, 0]);
    expect(easeInOutQuad(0)).toBe(0);
    expect(easeInOutQuad(1)).toBe(1);
    expect(easeInOutQuad(0.5)).toBe(0.5);
  });

  it('kapasite aşımında en eski geri alınır ve onArrive çağrılmaz', () => {
    const pool = new ParticlePool(new THREE.Scene(), 2);
    const first = vi.fn();
    const second = vi.fn();
    const third = vi.fn();
    pool.spawn({ from: A, to: B, color: '#fff', durationMs: 1000, onArrive: first });
    pool.spawn({ from: A, to: B, color: '#fff', durationMs: 1000, onArrive: second });
    pool.spawn({ from: A, to: B, color: '#fff', durationMs: 1000, onArrive: third });
    expect(pool.liveCount).toBe(2);
    pool.update(2);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(third).toHaveBeenCalledTimes(1);
  });

  it('spawn sırasında yeni nesne üretilmez (sprite ve eğri havuzdan)', () => {
    const pool = new ParticlePool(new THREE.Scene(), 3);
    const before = pool.sprites().slice();
    for (let i = 0; i < 20; i++) pool.spawn({ from: A, to: B, color: i % 2 ? '#fff' : '#000', durationMs: 500 });
    pool.update(0.3);
    expect(pool.sprites()).toEqual(before);
  });

  it("clear onArrive çağırmaz; dispose sprite'ları sahneden çıkarır", () => {
    const scene = new THREE.Scene();
    const pool = new ParticlePool(scene, 2);
    const arrive = vi.fn();
    pool.spawn({ from: A, to: B, color: '#fff', durationMs: 100, onArrive: arrive });
    pool.clear();
    pool.update(1);
    expect(arrive).not.toHaveBeenCalled();
    let sprites = 0;
    scene.traverse((o) => {
      if ((o as THREE.Sprite).isSprite) sprites++;
    });
    expect(sprites).toBe(2 * HEADS);
    const mats = pool.sprites().map((s) => s.material);
    const spies = mats.map((m) => vi.spyOn(m, 'dispose'));
    pool.dispose();
    sprites = 0;
    scene.traverse((o) => {
      if ((o as THREE.Sprite).isSprite) sprites++;
    });
    expect(sprites).toBe(0);
    expect(spies.every((s) => s.mock.calls.length === 1)).toBe(true);
  });
});
