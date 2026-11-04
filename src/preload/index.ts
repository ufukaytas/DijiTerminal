// Preload — renderer'a yalnızca beyaz listedeki kanalları tipli olarak açar (00/02).
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC_CHANNELS, type DijiApi, type EventChannel, type InvokeChannel } from '@shared/ipc';

const invokeAllowed = new Set<string>(IPC_CHANNELS.invoke);
const eventAllowed = new Set<string>(IPC_CHANNELS.events);

const api: DijiApi = {
  invoke(channel: InvokeChannel, ...args: unknown[]) {
    if (!invokeAllowed.has(channel)) return Promise.reject(new Error(`İzin verilmeyen IPC kanalı: ${String(channel)}`));
    return ipcRenderer.invoke(channel, ...args);
  },
  on(channel: EventChannel, cb: (payload: never) => void) {
    if (!eventAllowed.has(channel)) throw new Error(`İzin verilmeyen IPC olayı: ${String(channel)}`);
    const listener = (_e: IpcRendererEvent, payload: unknown) => cb(payload as never);
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },
} as DijiApi;

contextBridge.exposeInMainWorld('diji', api);
