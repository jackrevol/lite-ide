import { contextBridge, ipcRenderer } from 'electron'
import type {
  AgentSession,
  AppUpdateState,
  DesktopApi,
  TerminalEvent,
  StartupSnapshot,
} from '../shared/types'

const api: DesktopApi = {
  platform: process.platform,
  runStartup: (project, workspace, automatic) => ipcRenderer.invoke('startup:run', project, workspace, automatic),
  stopStartup: (workspace) => ipcRenderer.invoke('startup:stop', workspace),
  startupSnapshot: (workspace) => ipcRenderer.invoke('startup:snapshot', workspace),
  onStartup: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, snapshot: StartupSnapshot) => listener(snapshot)
    ipcRenderer.on('startup:event', receive)
    return () => { ipcRenderer.removeListener('startup:event', receive) }
  },
  openTerminal: (input) => ipcRenderer.invoke('terminal:open', input),
  writeTerminal: (id, data) => ipcRenderer.invoke('terminal:write', id, data),
  resizeTerminal: (id, cols, rows) =>
    ipcRenderer.invoke('terminal:resize', id, cols, rows),
  closeTerminal: (id) => ipcRenderer.invoke('terminal:close', id),
  terminalSnapshot: (id) => ipcRenderer.invoke('terminal:snapshot', id),
  onTerminal: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, event: TerminalEvent) =>
      listener(event)
    ipcRenderer.on('terminal:event', handler)
    return () => {
      ipcRenderer.removeListener('terminal:event', handler)
    }
  },
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateProjectSettings: (path, defaults) =>
    ipcRenderer.invoke('settings:project-update', path, defaults),
  resetProjectSettings: (path) =>
    ipcRenderer.invoke('settings:project-reset', path),
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  copyAppInfo: () => ipcRenderer.invoke('app:info-copy'),
  listBranches: (path) => ipcRenderer.invoke('repository:branches', path),
  updateStatus: () => ipcRenderer.invoke('app:update-status'),
  checkUpdate: () => ipcRenderer.invoke('app:update-check'),
  startUpdate: () => ipcRenderer.invoke('app:update-start'),
  downloadUpdate: () => ipcRenderer.invoke('app:update-download'),
  cancelUpdateDownload: () => ipcRenderer.invoke('app:update-cancel'),
  installUpdate: () => ipcRenderer.invoke('app:update-install'),
  onUpdate: (listener) => {
    const receive = (
      _event: Electron.IpcRendererEvent,
      state: AppUpdateState,
    ) => listener(state)
    ipcRenderer.on('app:update', receive)
    return () => {
      ipcRenderer.removeListener('app:update', receive)
    }
  },
  setWindowTheme: (theme) => ipcRenderer.invoke('window:theme', theme),
  listProjects: () => ipcRenderer.invoke('project:list'),
  openProject: () => ipcRenderer.invoke('project:open'),
  chooseCloneDirectory: () => ipcRenderer.invoke('project:clone-directory'),
  defaultCloneDirectory: () =>
    ipcRenderer.invoke('project:clone-default-directory'),
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
  inspectSubagent: (id) => ipcRenderer.invoke('codex:subagent-inspect', id),
  sendSubagentMessage: (id, text) =>
    ipcRenderer.invoke('codex:subagent-send', id, text),
  answerRequest: (id, request, answer) =>
    ipcRenderer.invoke('codex:answer', id, request, answer),
  renameSession: (id, title) => ipcRenderer.invoke('codex:rename', id, title),
  deleteSession: (id) => ipcRenderer.invoke('codex:delete', id),
  loginCodex: () => ipcRenderer.invoke('codex:login'),
  openLink: (url) => ipcRenderer.invoke('link:open', url),
  createWorktree: (path, branch, baseRef) =>
    ipcRenderer.invoke('worktree:create', path, branch, baseRef),
  deleteWorktree: (project, path, options) =>
    ipcRenderer.invoke('worktree:delete', project, path, options),
  inspectWorktreeDeletion: (project, path) =>
    ipcRenderer.invoke('worktree:delete-preview', project, path),
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
