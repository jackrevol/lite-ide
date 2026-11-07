export interface Project {
  path: string
  name: string
}

export interface Worktree {
  path: string
  branch: string
}

export type TerminalKind = 'codex' | 'shell'
export interface DeleteTaskOptions {
  discardChanges?: boolean
  localOnly?: boolean
}
export interface WorktreeDeletionPreview {
  localOnly: boolean
  branch: string | null
  totalChanges: number
}
export interface TerminalOpen {
  taskId: string
  workspace: string
  kind: TerminalKind
  cols: number
  rows: number
  model?: string
  effort?: string
  prompt?: string
  threadId?: string
}
export interface TerminalSnapshot {
  taskId: string
  generation: string
  workspace: string
  kind: TerminalKind
  running: boolean
  output: string
  sequence: number
  cols: number
  rows: number
  exitCode?: number
}
export type TerminalEvent =
  | {
      taskId: string
      generation: string
      sequence: number
      type: 'data'
      data: string
    }
  | {
      taskId: string
      generation: string
      sequence: number
      type: 'exit'
      exitCode: number
    }

export interface ChangedFile {
  path: string
  status: string
}

export interface RepositorySnapshot {
  isGitRepository: boolean
  worktrees: Worktree[]
  changes: ChangedFile[]
  totalChanges: number
}

export interface DesktopApi {
  platform: string
  runStartup(projectPath: string, workspace: string, automatic?: boolean): Promise<StartupSnapshot | null>
  stopStartup(workspace: string): Promise<void>
  startupSnapshot(workspace: string): Promise<StartupSnapshot | null>
  onStartup(listener: (snapshot: StartupSnapshot) => void): () => void
  openTerminal(input: TerminalOpen): Promise<TerminalSnapshot>
  writeTerminal(taskId: string, data: string): Promise<void>
  resizeTerminal(taskId: string, cols: number, rows: number): Promise<void>
  closeTerminal(taskId: string): Promise<void>
  terminalSnapshot(taskId: string): Promise<TerminalSnapshot | null>
  onTerminal(listener: (event: TerminalEvent) => void): () => void
  getSettings(): Promise<AppSettings>
  updateProjectSettings(
    projectPath: string,
    defaults: ProjectDefaults,
  ): Promise<AppSettings>
  resetProjectSettings(projectPath: string): Promise<AppSettings>
  getAppInfo(): Promise<AppInfo>
  copyAppInfo(): Promise<void>
  listBranches(projectPath: string): Promise<string[]>
  updateStatus(): Promise<AppUpdateState>
  checkUpdate(): Promise<AppUpdateState>
  startUpdate(): Promise<AppUpdateState>
  downloadUpdate(): Promise<AppUpdateState>
  cancelUpdateDownload(): Promise<void>
  installUpdate(): Promise<AppUpdateState>
  onUpdate(listener: (state: AppUpdateState) => void): () => void
  setWindowTheme(theme: 'light' | 'dark'): Promise<void>
  listProjects(): Promise<Project[]>
  openProject(): Promise<Project | null>
  chooseCloneDirectory(): Promise<string | null>
  defaultCloneDirectory(): Promise<string>
  cloneProject(url: string, parent: string, name: string): Promise<Project>
  inspectRepository(projectPath: string): Promise<RepositorySnapshot>
  inspectWorktreeDeletion(
    projectPath: string,
    target: string,
  ): Promise<WorktreeDeletionPreview>
  readDiff(projectPath: string, filePath: string): Promise<string>
  codexStatus(): Promise<CodexStatus>
  codexUsage(): Promise<CodexUsage>
  onCodexUsageChanged(listener: () => void): () => void
  listSessions(): Promise<AgentSession[]>
  sendMessage(input: SendMessage): Promise<void>
  interruptSession(sessionId: string): Promise<void>
  inspectSubagent(sessionId: string): Promise<void>
  sendSubagentMessage(sessionId: string, text: string): Promise<void>
  answerRequest(
    sessionId: string,
    requestId: string,
    answer: RequestAnswer,
  ): Promise<void>
  onSession(listener: (session: AgentSession) => void): () => void
  onCodexDisconnect(listener: (reason: string) => void): () => void
  renameSession(sessionId: string, title: string): Promise<void>
  deleteSession(sessionId: string): Promise<void>
  loginCodex(): Promise<void>
  openLink(url: string): Promise<void>
  createWorktree(
    projectPath: string,
    branch: string,
    baseRef?: string,
  ): Promise<Worktree>
  deleteWorktree(
    projectPath: string,
    worktreePath: string,
    options?: DeleteTaskOptions,
  ): Promise<{ warning?: string }>
}

export interface ProjectDefaults {
  baseRef: string
  model: string
  effort: string
  startupScript?: string
  startupAutoRun?: boolean
}
export interface StartupSnapshot {
  workspace: string
  status: 'running' | 'completed' | 'failed' | 'stopped'
  output: string
  startedAt: number
  revision: number
  exitCode?: number
  error?: string
}
export interface AppSettings {
  schemaVersion: 1
  projects: Record<string, ProjectDefaults>
}
export interface AppInfo {
  name: string
  version: string
  buildTime: string | null
  repositoryUrl: string
  commit: string | null
  dirty: boolean | null
  platform: string
  arch: string
  electronVersion: string
  nodeVersion: string
  packaged: boolean
}

export interface AppUpdateState {
  status:
    | 'idle'
    | 'checking'
    | 'current'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'installing'
    | 'error'
  currentVersion: string
  version?: string
  progress?: number
  error?: string
  canInstall: boolean
}

export type AgentStatus =
  'idle' | 'running' | 'waiting' | 'completed' | 'interrupted' | 'failed'
export interface AgentMessage {
  id: string
  kind: 'user' | 'assistant' | 'command' | 'files' | 'reasoning' | 'tool'
  text: string
  detail?: string
  status?: string
}
export interface AgentRequest {
  id: string
  kind: 'approval' | 'questions'
  title: string
  detail: string
  questions?: {
    id: string
    question: string
    options?: { label: string; description: string }[]
  }[]
}
export interface AgentSession {
  id: string
  workspace: string
  title: string
  threadId?: string
  turnId?: string
  status: AgentStatus
  messages: AgentMessage[]
  requests: AgentRequest[]
  error?: string
  updatedAt: number
  parentSessionId?: string
  nickname?: string
  role?: string
  model?: string
  task?: string
  observationError?: string
  canAcceptDirectInput?: boolean
  closed?: boolean
}
export interface CodexModel {
  id: string
  name: string
  efforts: string[]
  defaultEffort: string
  isDefault: boolean
}
export interface CodexStatus {
  connected: boolean
  authenticated: boolean
  models: CodexModel[]
  error?: string
}
export interface CodexUsageWindow {
  usedPercent: number
  windowDurationMins: number | null
  resetsAt: number | null
}
export interface CodexUsageLimit {
  limitId: string | null
  limitName: string | null
  planType: string | null
  primary: CodexUsageWindow | null
  secondary: CodexUsageWindow | null
}
export interface CodexUsage {
  rateLimits: CodexUsageLimit
  rateLimitsByLimitId: Record<string, CodexUsageLimit> | null
  rateLimitResetCredits?: {
    availableCount: number
    credits:
      | {
          id: string
          status: string
          grantedAt: number
          expiresAt: number | null
          title: string | null
        }[]
      | null
  } | null
}
export interface SendMessage {
  sessionId: string
  workspace: string
  text: string
  model?: string
  effort?: string
  title?: string
}
export interface RequestAnswer {
  approved?: boolean
  answers?: Record<string, string>
}
