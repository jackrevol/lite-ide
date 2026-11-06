export interface Project {
  path: string
  name: string
}

export interface Worktree {
  path: string
  branch: string
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
  updateStatus(): Promise<AppUpdateState>
  checkUpdate(): Promise<AppUpdateState>
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
  readDiff(projectPath: string, filePath: string): Promise<string>
  codexStatus(): Promise<CodexStatus>
  codexUsage(): Promise<CodexUsage>
  onCodexUsageChanged(listener: () => void): () => void
  listSessions(): Promise<AgentSession[]>
  sendMessage(input: SendMessage): Promise<void>
  interruptSession(sessionId: string): Promise<void>
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
  createWorktree(projectPath: string, branch: string): Promise<Worktree>
  deleteWorktree(
    projectPath: string,
    worktreePath: string,
  ): Promise<{ warning?: string }>
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
  | 'idle'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'interrupted'
  | 'failed'
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
