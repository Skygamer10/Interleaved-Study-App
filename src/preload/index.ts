// Typed, minimal bridge. The renderer can only call whitelisted methods; the API key never crosses it.
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { API_METHODS, type ApiEvent, type Bridge } from '../shared/api'

const api: Record<string, unknown> = {}
for (const m of API_METHODS) api[m] = (...args: unknown[]) => ipcRenderer.invoke('api', m, ...args)

api.on = (event: ApiEvent, cb: (payload: unknown) => void): (() => void) => {
  const listener = (_e: Electron.IpcRendererEvent, payload: unknown): void => cb(payload)
  ipcRenderer.on(`ev:${event}`, listener)
  return () => ipcRenderer.removeListener(`ev:${event}`, listener)
}
api.pathForFile = (file: File): string => webUtils.getPathForFile(file)

contextBridge.exposeInMainWorld('api', api as unknown as Bridge)
