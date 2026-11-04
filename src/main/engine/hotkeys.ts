// Yapışkan session numaraları (04/03 Bölüm 4) — saf, electron importu yok.
// Bir canlı session numarasını canlı kaldığı sürece korur; yeni canlı session en küçük boş numarayı (1..9) alır;
// 9 dolu ise numarasız kalır. supersedes ile devam eden session (resume/compact) eski numarayı devralır.

export const MAX_HOTKEY = 9;

export interface HotkeyCandidate {
  id: string;
  startedAt: number;
  /** Bu session'ın devam ettirdiği (supersede ettiği) eski session. */
  supersedes?: string | null;
}

export class HotkeyPool {
  private map = new Map<string, number>();

  /** Canlı session listesinden numara tablosu üretir. O(n log n) — yalnızca yeni gelenler sıralanır. */
  assign(live: HotkeyCandidate[]): Map<string, number> {
    const liveIds = new Set(live.map((s) => s.id));
    // Devralma: eski session canlı değilse numarası devam eden session'a geçer.
    for (const s of live) {
      if (this.map.has(s.id) || !s.supersedes) continue;
      const n = this.map.get(s.supersedes);
      if (n !== undefined && !liveIds.has(s.supersedes)) {
        this.map.delete(s.supersedes);
        this.map.set(s.id, n);
      }
    }
    for (const id of [...this.map.keys()]) if (!liveIds.has(id)) this.map.delete(id);

    const used = new Set(this.map.values());
    const fresh = live.filter((s) => !this.map.has(s.id)).sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
    let n = 1;
    for (const s of fresh) {
      while (used.has(n) && n <= MAX_HOTKEY) n++;
      if (n > MAX_HOTKEY) break;
      this.map.set(s.id, n);
      used.add(n);
    }
    return new Map(this.map);
  }

  get(id: string): number | null {
    return this.map.get(id) ?? null;
  }

  delete(id: string): void {
    this.map.delete(id);
  }

  reset(): void {
    this.map.clear();
  }
}
