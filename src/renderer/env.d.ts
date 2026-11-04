/// <reference types="vite/client" />
import type { DijiApi } from '@shared/ipc';

declare global {
  /** package.json sürümü; electron.vite.config.ts ve vitest.config.mts `define` ile verir. */
  const __APP_VERSION__: string;
  interface Window {
    /** Preload'un açtığı tipli IPC API'si; testlerde ve tarayıcıda yoktur. */
    diji?: DijiApi;
  }
}

export {};
