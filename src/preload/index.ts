import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopApi } from '../shared/types'

const api: DesktopApi = {
  openProject: () => ipcRenderer.invoke('project:open'),
  inspectRepository: (path) => ipcRenderer.invoke('repository:inspect', path),
  readDiff: (path, file) => ipcRenderer.invoke('repository:diff', path, file),
}
contextBridge.exposeInMainWorld('desktop', api)
