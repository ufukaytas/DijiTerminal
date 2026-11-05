// "Bu oturumda gizle" (09/01): gizlenen uyumluluk sinyalleri yalnızca bu pencere oturumu boyunca hatırlanır.
import { create } from 'zustand';
import type { CompatSignalId } from '@shared/compat';

interface CompatUiState {
  hidden: ReadonlySet<CompatSignalId>;
  hide(ids: readonly CompatSignalId[]): void;
}

export const useCompatUi = create<CompatUiState>()((set) => ({
  hidden: new Set(),
  hide: (ids) => set((s) => ({ hidden: new Set([...s.hidden, ...ids]) })),
}));
