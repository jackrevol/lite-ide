import { contextBridge, ipcRenderer } from 'electron'
import type { AgentSession, DesktopApi } from '../shared/types'

const api: DesktopApi = {
  platform: process.platform,
  setWindowTheme: (theme) => ipcRenderer.invoke('window:theme', theme),
  listProjects: () => ipcRenderer.invoke('project:list'),
  openProject: () => ipcRenderer.invoke('project:open'),
  chooseCloneDirectory: () => ipcRenderer.invoke('project:clone-directory'),
  cloneProject: (url, parent, name) =>
    ipcRenderer.invoke('project:clone', url, parent, name),
  inspectRepository: (path) => ipcRenderer.invoke('repository:inspect', path),
  readDiff: (path, file) => ipcRenderer.invoke('repository:diff', path, file),
  codexStatus: () => ipcRenderer.invoke('codex:status'),
  codexUsage: () => ipcRenderer.invoke('codex:usage'),
  onCodexUsageChanged: (listener) => {
    const receive = () => listener()
    ipcRenderer.on('codex:usage-changed', receive)
    return () => {
      ipcRenderer.removeListener('codex:usage-changed', receive)
    }
  },
  listSessions: () => ipcRenderer.invoke('codex:sessions'),
  sendMessage: (input) => ipcRenderer.invoke('codex:send', input),
  interruptSession: (id) => ipcRenderer.invoke('codex:interrupt', id),
  answerRequest: (id, request, answer) =>
    ipcRenderer.invoke('codex:answer', id, request, answer),
  renameSession: (id, title) => ipcRenderer.invoke('codex:rename', id, title),
  deleteSession: (id) => ipcRenderer.invoke('codex:delete', id),
  loginCodex: () => ipcRenderer.invoke('codex:login'),
  openLink: (url) => ipcRenderer.invoke('link:open', url),
  createWorktree: (path, branch) =>
    ipcRenderer.invoke('worktree:create', path, branch),
  onSession: (listener) => {
    const receive = (
      _event: Electron.IpcRendererEvent,
      session: AgentSession,
    ) => listener(session)
    ipcRenderer.on('codex:session', receive)
    return () => {
      ipcRenderer.removeListener('codex:session', receive)
    }
  },
  onCodexDisconnect: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, reason: string) =>
      listener(reason)
    ipcRenderer.on('codex:disconnect', receive)
    return () => {
      ipcRenderer.removeListener('codex:disconnect', receive)
    }
  },
}
contextBridge.exposeInMainWorld('desktop', api)
