// Dosya küpleri (03/05 Prompt 9): platformun arka kenarında en sıcak 5 dosya, çakışanlar önce.
import * as THREE from 'three';
import { SLOW_COLOR } from '@shared/constants';
import type { FileConflict, FileHeat } from '@shared/types';
import { disposeTree, geo } from './geometries';
import { CSS2DObject, el, labelObject } from './labels';
import { FILE_Z, fileSlots } from './layout';

const FILE_Y = 0.58;

export class FileNode {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  readonly label: CSS2DObject;
  private readonly labelEl: HTMLDivElement;
  /** 0..1 ısı; 06 dokunuşlarda 1'e çeker ve söndürür. */
  heat = 0;
  conflict = false;
  private flashTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly path: string) {
    this.mesh = new THREE.Mesh(
      geo('fileCube'),
      new THREE.MeshStandardMaterial({ color: 0x1d2330, emissive: 0x000000, emissiveIntensity: 0 }),
    );
    this.labelEl = el('div', 'flabel');
    this.label = labelObject(this.labelEl, 0.5, 1);
  }

  setConflict(on: boolean): void {
    if (on === this.conflict && this.labelEl.textContent) return;
    this.conflict = on;
    const m = this.mesh.material;
    m.color.set(on ? 0x3a1a1a : 0x1d2330);
    m.emissive.set(on ? SLOW_COLOR : 0x000000);
    m.emissiveIntensity = on ? 0.5 : 0;
    this.labelEl.textContent = on ? `ÇAKIŞMA · ${this.path}` : (this.path.split('/').pop() ?? this.path);
    this.labelEl.classList.toggle('conflict', on);
    this.labelEl.title = this.path;
  }

  setPosition(x: number): void {
    this.mesh.position.set(x, FILE_Y, FILE_Z);
    this.label.position.set(x, FILE_Y + 0.45, FILE_Z);
  }

  /** Etiketi kısa süre göster (çakışan dosyanın etiketi zaten sürekli görünür). */
  flashLabel(ms = 2600): void {
    if (this.conflict) return;
    this.labelEl.classList.add('on');
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      this.labelEl.classList.remove('on');
      this.flashTimer = null;
    }, ms);
  }

  dispose(): void {
    if (this.flashTimer) clearTimeout(this.flashTimer);
    disposeTree(this.mesh);
    this.label.removeFromParent(); // CSS2D: GPU kaynağı yok, DOM'dan kalkar
  }
}

export class FileRow {
  readonly group = new THREE.Group();
  readonly nodes = new Map<string, FileNode>();
  private key = '';

  sync(files: readonly FileHeat[], conflicts: readonly FileConflict[]): void {
    const slots = fileSlots(files, conflicts);
    const key = JSON.stringify(slots);
    if (key === this.key) return;
    this.key = key;
    const keep = new Set(slots.map((s) => s.path));
    for (const [p, n] of this.nodes) {
      if (!keep.has(p)) {
        n.dispose();
        this.nodes.delete(p);
      }
    }
    for (const s of slots) {
      let n = this.nodes.get(s.path);
      if (!n) {
        n = new FileNode(s.path);
        this.nodes.set(s.path, n);
        this.group.add(n.mesh, n.label);
      }
      n.setPosition(s.x);
      n.setConflict(s.conflict);
    }
  }

  /** Platform yerelinde dosya konumu; gösterilmiyorsa null. */
  localPos(path: string): THREE.Vector3 | null {
    const n = this.nodes.get(path);
    return n ? n.mesh.position.clone() : null;
  }

  dispose(): void {
    for (const n of this.nodes.values()) n.dispose();
    this.nodes.clear();
    this.group.removeFromParent();
  }
}
