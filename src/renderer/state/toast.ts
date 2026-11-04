// Kısa bildirimler (03/01): en fazla 3 tane, 3.2 sn sonra kaybolur.
import { create } from 'zustand';
import type { ToastAction } from '@shared/ipc';

export type ToastLevel = 'info' | 'warn' | 'error';
export interface Toast {
  id: number;
  level: ToastLevel;
  message: string;
  /** Main'in önerdiği eylem (ör. Sistem Ayarları'nı aç); tıklanınca 'app:toastAction' çağrılır. */
  action?: ToastAction;
}

export const TOAST_MS = 3200;
/** Eylem düğmeli toast'a tıklamak için daha uzun süre. */
export const ACTION_TOAST_MS = 10_000;
const MAX = 3;

interface ToastState {
  toasts: Toast[];
  dismiss(id: number): void;
}

let nextId = 1;

export const useToasts = create<ToastState>()((set) => ({
  toasts: [],
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export function pushToast(level: ToastLevel, message: string, action?: ToastAction): void {
  const id = nextId++;
  const toast: Toast = action ? { id, level, message, action } : { id, level, message };
  useToasts.setState((s) => ({ toasts: [...s.toasts, toast].slice(-MAX) }));
  setTimeout(() => useToasts.getState().dismiss(id), action ? ACTION_TOAST_MS : TOAST_MS);
}
