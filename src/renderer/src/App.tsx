import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowDown,
  Check,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  GitBranch,
  GitCompareArrows,
  LoaderCircle,
  Moon,
  MoreHorizontal,
  PanelRight,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Square,
  Sun,
  Terminal,
  Trash2,
  X,
} from 'lucide-react'
import { Button } from './components/ui/button'
import { ProjectDialog } from './components/ProjectDialog'
import { SidebarActionMenu } from './components/SidebarActionMenu'
import { WorkspacePanels } from './components/WorkspacePanels'
import { TaskTabs } from './components/TaskTabs'
import { TaskTerminal } from './components/TaskTerminal'
import { ChangedFilesTree } from './components/ChangedFilesTree'
import { StartupPanel } from './components/StartupPanel'
import { DiffView } from './components/DiffView'
import { SessionTab } from './components/SessionTab'
import { ProcessPanel } from './components/ProcessPanel'
import { workspaceSessions } from './lib/workspace-sessions'
import { AppUpdateButton } from './components/AppUpdateButton'
import { NewTaskDialog } from './components/NewTaskDialog'
import { SettingsDialog, projectSettingsKey } from './components/SettingsDialog'
import { CodexUsagePanel } from './components/CodexUsagePanel'
import {
  loadWorkspace,
  storageKey,
  type WorkspaceTask,
} from './lib/workspace-state'
import type {
  AgentSession,
  CodexStatus,
  Project,
  ProjectDefaults,
  RepositorySnapshot,
  TerminalSnapshot,
  StartupSnapshot,
  WorktreeDeletionPreview,
} from '../../shared/types'

const emptyRepository: RepositorySnapshot = {
  isGitRepository: false,
  worktrees: [],
  changes: [],
  totalChanges: 0,
}
const errorText = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause)
const sameRepository = (a: RepositorySnapshot, b: RepositorySnapshot) =>
  JSON.stringify(a) === JSON.stringify(b)
const samePath = (a: string, b: string) => {
  const normalize = (path: string) =>
    (window.desktop.platform === 'win32'
      ? path.toLowerCase()
      : path
    ).replaceAll('\\', '/')
  return normalize(a) === normalize(b)
}
export function App() {
  const [state, setState] = useState(loadWorkspace)
  const [projects, setProjects] = useState<Project[]>([])
  const [repositories, setRepositories] = useState<
    Record<string, RepositorySnapshot>
  >({})
  const [repository, setRepository] = useState(emptyRepository)
  const [ready, setReady] = useState(false)
  const [loading, setLoading] = useState(false)
  const [opening, setOpening] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [error, setError] = useState('')
  const [connection, setConnection] = useState<CodexStatus>({
    connected: false,
    authenticated: false,
    models: [],
  })
  const [connecting, setConnecting] = useState(true)
  const [showChanges, setShowChanges] = useState(true)
  const [theme, setTheme] = useState(
    () => localStorage.getItem('lite-ide.theme') ?? 'dark',
  )
  const [diffTabs, setDiffTabs] = useState<{ id: string; taskId: string; path: string; workspace: string; project: string }[]>([])
  const [activeDiffId, setActiveDiffId] = useState('')
  const [selectedFiles, setSelectedFiles] = useState<Record<string, string>>({})
  const activeDiff = diffTabs.find((tab) => tab.id === activeDiffId)
  const [startupSnapshots, setStartupSnapshots] = useState<Record<string, StartupSnapshot | null>>({})
  const [mountedTasks, setMountedTasks] = useState<string[]>([])
  const [diffCache, setDiffCache] = useState<Record<string, string>>({})
  const diff = activeDiff ? diffCache[activeDiff.id] ?? '' : ''
  const diffLoading = !!activeDiff && !Object.hasOwn(diffCache, activeDiff.id)
  const [fileQuery, setFileQuery] = useState('')
  const [search, setSearch] = useState('')
  const [collapsed, setCollapsed] = useState<string[]>([])
  const [newTaskProject, setNewTaskProject] = useState<Project | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [settingsProject, setSettingsProject] = useState('')
  const [defaults, setDefaults] = useState<ProjectDefaults>({
    baseRef: 'HEAD',
    model: '',
    effort: '',
  })
  const [target, setTarget] = useState<{
    task: WorkspaceTask
    action: 'rename' | 'delete'
  } | null>(null)
  const [name, setName] = useState('')
  const [managing, setManaging] = useState(false)
  const [deletionChanges, setDeletionChanges] = useState<number | null>(null)
  const [deletionPreview, setDeletionPreview] =
    useState<WorktreeDeletionPreview | null>(null)
  const [managementError, setManagementError] = useState('')
  const [terminals, setTerminals] = useState<Record<string, TerminalSnapshot>>(
    {},
  )
  const openingTask = useRef(false)
  const autoStartTasks = useRef(new Map<string, string>())
  const startupStateRef = useRef<Record<string, StartupSnapshot | null>>({})
  const repositoryDirectory = useRef('')
  const managementRequest = useRef(0)
  const searchDialog = useRef<HTMLDialogElement>(null)
  const taskDialog = useRef<HTMLDialogElement>(null)
  const current = state.tasks.find((task) => task.id === state.taskId)
  const project = projects.find((item) => item.path === state.project)
  const selectedFile = current ? selectedFiles[current.path] ?? '' : ''
  const currentStartup = current ? startupSnapshots[current.path] : null
  const startupChecked = !!current && Object.hasOwn(startupSnapshots, current.path)
  const startupBlocked = !!currentStartup && currentStartup.status !== 'completed'

  const receiveStartup = useCallback((snapshot: StartupSnapshot | null, workspace: string) => {
    const existing = startupStateRef.current[workspace]
    if (existing && (!snapshot || existing.startedAt > snapshot.startedAt || (existing.startedAt === snapshot.startedAt && existing.revision > snapshot.revision))) return
    startupStateRef.current = { ...startupStateRef.current, [workspace]: snapshot }
    setStartupSnapshots(startupStateRef.current)
    const taskId = autoStartTasks.current.get(workspace)
    if (taskId && (!snapshot || snapshot.status === 'completed')) {
      autoStartTasks.current.delete(workspace)
      setMountedTasks((previous) => previous.includes(taskId) ? previous : [...previous, taskId])
    }
  }, [])
  useEffect(() => window.desktop.onStartup((snapshot) => receiveStartup(snapshot, snapshot.workspace)), [receiveStartup])
  useEffect(() => {
    if (!current || !ready) return
    let disposed = false
    void window.desktop.startupSnapshot(current.path).then((snapshot) => {
      if (!disposed) receiveStartup(snapshot, current.path)
    }).catch((cause) => { if (!disposed) setError(errorText(cause)) })
    return () => { disposed = true }
  }, [current?.path, ready])
  const [sessions, setSessions] = useState<Record<string, AgentSession>>({})
  const [sessionError, setSessionError] = useState('')
  const [selectedTabs, setSelectedTabs] = useState<Record<string, string>>({})
  const [sessionDrafts, setSessionDrafts] = useState<Record<string, string>>({})
  const visibleSessions = workspaceSessions(Object.values(sessions), current?.path ?? '', window.desktop.platform)
  const selectedSession = visibleSessions.find((session) => `session-${session.id}` === selectedTabs[current?.id ?? ''])
  const selectedTab = activeDiffId || (selectedSession ? `session-${selectedSession.id}` : current?.id)
  useEffect(() => {
    if (current && ready && startupChecked && !startupBlocked && !activeDiff && !selectedSession)
      setMountedTasks((previous) => previous.includes(current.id) ? previous : [...previous, current.id])
  }, [current?.id, ready, startupChecked, startupBlocked, selectedTab])

  useEffect(() => window.desktop.onSession((session) => {
    setSessions((previous) => ({ ...previous, [session.id]: session }))
  }), [])
  useEffect(() => {
    const activate = (target: import('../../shared/types').NotificationTarget) => {
      const task = state.tasks.find((item) => item.id === target.taskId || samePath(item.path, target.workspace))
      if (!task) return
      setActiveDiffId('')
      setSelectedTabs((tabs) => ({ ...tabs, [task.id]: target.sessionId ? `session-${target.sessionId}` : task.id }))
      setState((previous) => ({ ...previous, project: task.project, taskId: task.id }))
      setShowSettings(false)
    }
    const unsubscribe = window.desktop.onNotificationClick(activate)
    if (ready) void window.desktop.takePendingNotification().then((target) => { if (target) activate(target) }).catch(() => {})
    return unsubscribe
  }, [ready, state.tasks])
  useEffect(() => window.desktop.onTerminal((event) => {
    if (event.type !== 'exit') return
    setTerminals((previous) => {
      const terminal = previous[event.taskId]
      if (!terminal || terminal.generation !== event.generation) return previous
      return { ...previous, [event.taskId]: { ...terminal, running: false, exitCode: event.exitCode } }
    })
  }), [])
  useEffect(() => {
    if (!ready || !current) return
    let disposed = false
    let pending = false
    setSessionError('')
    const inspect = async () => {
      if (pending) return
      pending = true
      try {
        const found = await window.desktop.listSessions(current.path)
        if (!disposed) {
          setSessions((previous) => {
            const next = { ...previous }
            for (const session of found) {
              if (!next[session.id] || next[session.id].updatedAt <= session.updatedAt) next[session.id] = session
            }
            return next
          })
          setSessionError('')
        }
      } catch (cause) {
        if (!disposed) setSessionError(errorText(cause))
      } finally { pending = false }
    }
    void inspect()
    const timer = setInterval(() => { if (!document.hidden) void inspect() }, 4000)
    return () => { disposed = true; clearInterval(timer) }
  }, [ready, current?.path])

  const reconnect = useCallback(async () => {
    setConnecting(true)
    try {
      setConnection(await window.desktop.codexStatus())
    } catch (cause) {
      setConnection({
        connected: false,
        authenticated: false,
        models: [],
        error: errorText(cause),
      })
    } finally {
      setConnecting(false)
    }
  }, [])
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    localStorage.setItem('lite-ide.theme', theme)
    void window.desktop
      .setWindowTheme(theme === 'dark' ? 'dark' : 'light')
      .catch((cause) => setError(errorText(cause)))
  }, [theme])
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(state))
    } catch {
      setError('작업 목록을 저장하지 못했습니다. 저장 공간을 확인해 주세요.')
    }
  }, [state])
  useEffect(() => {
    let disposed = false
    void Promise.all([
      window.desktop.listProjects(),
      window.desktop.listSessions(),
    ])
      .then(async ([opened, legacy]) => {
        const snapshots = await Promise.all(
          opened.map(
            async (item) =>
              [
                item.path,
                await window.desktop
                  .inspectRepository(item.path)
                  .catch(() => emptyRepository),
              ] as const,
          ),
        )
        if (disposed) return
        setProjects(opened)
        setSessions((previous) => ({ ...Object.fromEntries(legacy.map((session) => [session.id, session])), ...previous }))
        setRepositories(Object.fromEntries(snapshots))
        setState((previous) => {
          const tasks = previous.tasks
            .filter((task) =>
              opened.some((item) => samePath(item.path, task.project)),
            )
            .map((task) => ({
              ...task,
              branch: snapshots
                .find(([path]) => samePath(path, task.project))?.[1]
                .worktrees.find((tree) => samePath(tree.path, task.path))?.branch
                ?? task.branch,
              threadId:
                task.threadId ??
                legacy.find(
                  (session) =>
                    !session.parentSessionId &&
                    samePath(session.workspace, task.path),
                )?.threadId,
            }))
          return {
            tasks,
            project:
              opened.find((item) => samePath(item.path, previous.project))
                ?.path ??
              opened[0]?.path ??
              '',
            taskId: tasks.some((task) => task.id === previous.taskId)
              ? previous.taskId
              : '',
          }
        })
        setReady(true)
      })
      .catch((cause) => {
        if (!disposed) {
          setError(errorText(cause))
          setReady(true)
        }
      })
    void reconnect()
    return () => {
      disposed = true
    }
  }, [reconnect])
  useEffect(() => {
    const directory = current?.path || project?.path
    if (!ready || !directory) {
      setRepository(emptyRepository)
      repositoryDirectory.current = ''
      return
    }
    let disposed = false
    // 배경 갱신 중에는 기존 트리와 선택·접힘·스크롤을 그대로 유지합니다.
    if (repositoryDirectory.current !== directory) {
      repositoryDirectory.current = directory
      setLoading(true)
    }
    void window.desktop
      .inspectRepository(directory)
      .then((snapshot) => {
        if (disposed) return
        const next = current ? snapshot : emptyRepository
        setRepository((previous) => sameRepository(previous, next) ? previous : next)
        if (snapshot.isGitRepository)
          setState((previous) => {
            let changed = false
            const tasks = previous.tasks.map((task) => {
              const tree = snapshot.worktrees.find((tree) => samePath(tree.path, task.path))
              if (!tree || task.branch === tree.branch) return task
              changed = true
              return { ...task, branch: tree.branch }
            })
            return changed ? { ...previous, tasks } : previous
          })
        if (project)
          setRepositories((previous) => {
            // 손상된 작업 경로의 빈 결과로 프로젝트 Worktree 목록을 덮어쓰지 않습니다.
            const next = snapshot.isGitRepository ? snapshot : previous[project.path] ?? emptyRepository
            return previous[project.path] && sameRepository(previous[project.path], next)
              ? previous : { ...previous, [project.path]: next }
          })
      })
      .catch((cause) => {
        if (!disposed) setError(errorText(cause))
      })
      .finally(() => {
        if (!disposed) setLoading(false)
      })
    const timer = setInterval(() => setRefresh((value) => value + 1), 10000)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [ready, current?.path, project?.path, refresh])
  useEffect(() => {
    if (!activeDiff) return
    let disposed = false
    void window.desktop
      .readDiff(activeDiff.workspace, activeDiff.path)
      .then((value) => {
        if (!disposed) {
          setDiffCache((previous) => previous[activeDiff.id] === value ? previous : { ...previous, [activeDiff.id]: value })
        }
      })
      .catch((cause) => {
        if (!disposed) {
          const message = errorText(cause)
          setDiffCache((previous) => previous[activeDiff.id] === message ? previous : { ...previous, [activeDiff.id]: message })
        }
      })
    return () => {
      disposed = true
    }
  }, [activeDiffId, refresh])

  function selectTask(task: WorkspaceTask) {
    setActiveDiffId('')
    setState((previous) => ({
      ...previous,
      project: task.project,
      taskId: task.id,
    }))
  }
  function openDiff(path: string) {
    if (!current) return
    const id = `diff:${current.id}:${path}`
    setDiffTabs((previous) => previous.some((tab) => tab.id === id) ? previous : [...previous, { id, taskId: current.id, path, workspace: current.path, project: current.project }])
    setActiveDiffId(id)
    setSelectedFiles((previous) => ({ ...previous, [current.path]: path }))
  }
  function closeDiff(id: string) {
    setDiffTabs((previous) => previous.filter((tab) => tab.id !== id))
    if (activeDiffId === id) {
      setActiveDiffId('')
      if (current) setSelectedTabs((previous) => ({ ...previous, [current.id]: current.id }))
    }
  }
  function openTaskTerminal(task: WorkspaceTask, kind: 'codex' | 'shell') {
    selectTask(task)
    setSelectedTabs((previous) => ({ ...previous, [task.id]: task.id }))
    setState((previous) => ({ ...previous, tasks: previous.tasks.map((item) => item.id === task.id ? { ...item, terminalKind: kind } : item) }))
  }
  async function runTaskStartup(task: WorkspaceTask) {
    selectTask(task)
    setSelectedTabs((previous) => ({ ...previous, [task.id]: task.id }))
    autoStartTasks.current.set(task.path, task.id)
    try {
      const snapshot = await window.desktop.runStartup(task.project, task.path)
      if (snapshot) receiveStartup(snapshot, task.path)
      else {
        autoStartTasks.current.delete(task.path)
        setError('프로젝트 설정에서 Startup 스크립트 파일의 상대 경로를 입력하고 저장해 주세요.')
      }
    } catch (cause) {
      autoStartTasks.current.delete(task.path)
      setError(errorText(cause))
    }
  }
  async function openProject() {
    setOpening(true)
  }
  function projectOpened(opened: Project) {
    setActiveDiffId('')
    setProjects((previous) =>
      previous.some((item) => samePath(item.path, opened.path))
        ? previous
        : [...previous, opened],
    )
    setState((previous) => ({ ...previous, project: opened.path, taskId: '' }))
  }
  const openNewTask = useCallback(async (item: Project) => {
    if (openingTask.current) return
    openingTask.current = true
    try {
      const settings = await window.desktop.getSettings()
      setDefaults(
        settings.projects[projectSettingsKey(item.path)] ?? {
          baseRef: 'HEAD',
          model: '',
          effort: '',
        },
      )
      setNewTaskProject(item)
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      openingTask.current = false
    }
  }, [])
  function manageBaseBranch(item: Project) {
    setSettingsProject(item.path)
    setShowSettings(true)
  }
  async function createTask(task: WorkspaceTask) {
    setActiveDiffId('')
    autoStartTasks.current.set(task.path, task.id)
    setState((previous) => ({
      tasks: previous.tasks.some((item) => item.id === task.id)
        ? previous.tasks
        : [...previous.tasks, task],
      project: task.project,
      taskId: task.id,
    }))
    setRefresh((value) => value + 1)
    const snapshot = await window.desktop.startupSnapshot(task.path)
    receiveStartup(snapshot, task.path)
  }
  const addTask = useCallback(
    async (requested?: Project) => {
      const item =
        requested ??
        projects.find((entry) => entry.path === state.project) ??
        projects[0]
      if (!item) {
        setOpening(true)
        return
      }
      await openNewTask(item)
    },
    [projects, state.project, openNewTask],
  )
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (
        !(event.ctrlKey || event.metaKey) ||
        event.isComposing ||
        document.querySelector('dialog[open]')
      )
        return
      const key = event.key.toLowerCase()
      if (key === ',') {
        event.preventDefault()
        setShowSettings(true)
      }
      if (key === 'k') {
        event.preventDefault()
        setSearch('')
        searchDialog.current?.showModal()
      }
      if (key === 'n') {
        event.preventDefault()
        void addTask()
      }
      if (key === 'b' && event.shiftKey) {
        event.preventDefault()
        setShowChanges((value) => !value)
      }
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [addTask])
  function manageTask(task: WorkspaceTask, action: 'rename' | 'delete') {
    const request = ++managementRequest.current
    setTarget({ task, action })
    setName(task.name)
    setManagementError('')
    setDeletionChanges(null)
    setDeletionPreview(null)
    taskDialog.current?.showModal()
    if (action === 'delete')
      void window.desktop
        .inspectWorktreeDeletion(task.project, task.path)
        .then((preview) => {
          if (request === managementRequest.current) {
            setDeletionChanges(preview.totalChanges)
            setDeletionPreview(preview)
          }
        })
        .catch((cause) => {
          if (request === managementRequest.current)
            setManagementError(errorText(cause))
        })
  }
  async function saveTask() {
    if (
      !target ||
      managing ||
      (target.action === 'delete' && deletionChanges === null)
    )
      return
    setManaging(true)
    setManagementError('')
    try {
      if (target.action === 'rename') {
        if (!name.trim()) return
        setState((previous) => ({
          ...previous,
          tasks: previous.tasks.map((task) =>
            task.id === target.task.id ? { ...task, name: name.trim() } : task,
          ),
        }))
      } else {
        const result = await window.desktop.deleteWorktree(
          target.task.project,
          target.task.path,
          { discardChanges: true, localOnly: deletionPreview?.localOnly === true },
        )
        if (result.warning) setError(result.warning)
        setDiffTabs((previous) => previous.filter((tab) => tab.taskId !== target.task.id))
        if (activeDiff?.taskId === target.task.id) setActiveDiffId('')
        setState((previous) => ({
          ...previous,
          tasks: previous.tasks.filter((task) => task.id !== target.task.id),
          taskId: previous.taskId === target.task.id ? '' : previous.taskId,
        }))
        setTerminals((previous) => {
          const next = { ...previous }
          delete next[target.task.id]
          return next
        })
      }
      taskDialog.current?.close()
      setRefresh((value) => value + 1)
    } catch (cause) {
      setManagementError(errorText(cause))
    } finally {
      setManaging(false)
    }
  }
  const found = state.tasks.filter((task) =>
    `${task.name} ${task.branch} ${task.project}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  )
  return (
    <div className="app-shell">
      <header className="app-header" aria-label="통합 제목 표시줄">
        <div className="titlebar-content">
          <div className="brand">
            <span className="brand-mark">
              <img
                src="./app-icon.png"
                alt="시베리안고양이"
                draggable={false}
              />
            </span>
            <span>Lite IDE</span>
          </div>
          <div className="breadcrumb">
            <span>{project?.name ?? '시작하기'}</span>
            <ChevronRight size={12} />
            <GitBranch size={12} />
            <span>{current?.branch ?? 'Codex'}</span>
          </div>
          <div className="titlebar-actions">
            <AppUpdateButton />
            <button
              className="header-search"
              onClick={() => {
                setSearch('')
                searchDialog.current?.showModal()
              }}
            >
              <Search size={13} />
              <span>빠른 이동</span>
              <kbd>Ctrl K</kbd>
            </button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="변경 패널 전환"
              aria-pressed={showChanges}
              onClick={() => setShowChanges((value) => !value)}
            >
              <PanelRight />
            </Button>
          </div>
        </div>
      </header>
      <main className="workspace-layout">
        <WorkspacePanels
          projects={
            <aside
              className="panel projects-panel"
              aria-label="프로젝트 및 작업"
            >
              <div className="section-label">
                <span>프로젝트</span>
                <button
                  title="프로젝트 열기"
                  aria-label="프로젝트 열기"
                  onClick={() => void openProject()}
                >
                  <Plus size={15} />
                </button>
              </div>
              <nav className="project-list">
                {!projects.length && (
                  <div className="sidebar-empty">
                    <FolderOpen size={22} />
                    <p>
                      프로젝트를 열어
                      <br />
                      작업을 시작하세요.
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void openProject()}
                    >
                      폴더 열기
                    </Button>
                  </div>
                )}
                {projects.map((item) => (
                  <div className="project-group" key={item.path}>
                    <div
                      className={`project-row ${state.project === item.path ? 'current-project' : ''}`}
                    >
                      <button
                        aria-label={`${item.name} ${collapsed.includes(item.path) ? '펼치기' : '접기'}`}
                        aria-expanded={!collapsed.includes(item.path)}
                        onClick={() =>
                          setCollapsed((previous) =>
                            previous.includes(item.path)
                              ? previous.filter((path) => path !== item.path)
                              : [...previous, item.path],
                          )
                        }
                      >
                        {collapsed.includes(item.path) ? (
                          <ChevronRight size={13} />
                        ) : (
                          <ChevronDown size={13} />
                        )}
                      </button>
                      <button
                        className="project-name"
                        title={item.path}
                        onClick={() => {
                          setActiveDiffId('')
                          setState((previous) => ({
                            ...previous,
                            project: item.path,
                            taskId:
                              previous.tasks.find(
                                (task) =>
                                  task.project === item.path &&
                                  task.id === previous.taskId,
                              )?.id ?? '',
                          }))
                        }}
                      >
                        <FolderOpen size={14} />
                        <span>{item.name}</span>
                      </button>
                      <button
                        className="project-base-branch"
                        aria-label={`${item.name} 기준 브랜치 관리`}
                        title="새 Worktree의 기본 기준 브랜치 관리"
                        onClick={() => manageBaseBranch(item)}
                      >
                        <GitBranch size={14} />
                      </button>
                      <button
                        className="project-new-task"
                        aria-label={`${item.name} 새 작업`}
                        title={`${item.name} 새 작업`}
                        disabled={!ready || !repositories[item.path]}
                        onClick={() => void addTask(item)}
                      >
                        <Plus size={15} />
                      </button>
                    </div>
                    {!collapsed.includes(item.path) &&
                      state.tasks
                        .filter((task) => task.project === item.path)
                        .map((task) => (
                          <div className="managed-row" key={task.id}>
                            <button
                              className={`task-row ${current?.id === task.id ? 'selected' : ''}`}
                              title={task.path}
                              aria-current={
                                current?.id === task.id ? 'page' : undefined
                              }
                              onClick={() => selectTask(task)}
                            >
                              <span
                                className={`session-dot ${terminals[task.id]?.running ? 'completed' : 'idle'}`}
                              />
                              <span className="task-label">
                                <span>{task.name}</span>
                                <small>{task.branch}</small>
                              </span>
                            </button>
                            <SidebarActionMenu
                              className="row-action"
                              label={`${task.name} 작업 메뉴`}
                              heading={task.name}
                              icon={<MoreHorizontal size={15} />}
                              actions={[
                                { label: 'Codex 터미널', icon: <Terminal size={13} />, onClick: () => openTaskTerminal(task, 'codex') },
                                { label: '셸 터미널', icon: <Terminal size={13} />, onClick: () => openTaskTerminal(task, 'shell') },
                                { label: '터미널 종료', icon: <Square size={13} />, disabled: !terminals[task.id]?.running, onClick: () => { void window.desktop.closeTerminal(task.id).catch((cause) => setError(errorText(cause))) } },
                                { label: 'Startup 다시 실행', icon: <RefreshCw size={13} />, disabled: startupSnapshots[task.path]?.status === 'running', onClick: () => { void runTaskStartup(task) } },
                                {
                                  label: '이름 변경',
                                  icon: <Pencil size={13} />,
                                  onClick: () => manageTask(task, 'rename'),
                                },
                                {
                                  label: '작업 삭제',
                                  icon: <Trash2 size={13} />,
                                  destructive: true,
                                  onClick: () => manageTask(task, 'delete'),
                                },
                              ]}
                            />
                          </div>
                        ))}
                  </div>
                ))}
              </nav>
              <footer className="sidebar-footer">
                <CodexUsagePanel
                  connection={connection}
                  connecting={connecting}
                />
                <div className="sidebar-bottom">
                  <button
                    aria-label="설정"
                    title="설정 (Ctrl ,)"
                    onClick={() => setShowSettings(true)}
                  >
                    <Settings size={16} />
                  </button>
                  <button
                    aria-label="프로젝트 열기"
                    title="프로젝트 열기"
                    onClick={() => void openProject()}
                  >
                    <FolderOpen size={16} />
                  </button>
                  <span>Lite IDE</span>
                  <button
                    aria-label={theme === 'dark' ? '라이트 테마' : '다크 테마'}
                    onClick={() =>
                      setTheme((value) => (value === 'dark' ? 'light' : 'dark'))
                    }
                  >
                    {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
                  </button>
                </div>
              </footer>
            </aside>
          }
          agent={
            <section
              className="panel agent-panel"
              aria-label="작업 터미널 영역"
            >
              <TaskTabs
                tasks={current ? [{
                  id: current.id,
                  title: current.name,
                  active: !!terminals[current.id]?.running,
                  kind: 'terminal' as const,
                  detail: `${current.path} · 터미널`,
                }, ...visibleSessions.map((session) => ({
                  id: `session-${session.id}`,
                  title: `${session.parentSessionId ? '서브 · ' : '세션 · '}${session.nickname || session.title}`,
                  active: session.status === 'running' || session.status === 'waiting',
                  kind: session.parentSessionId ? 'subagent' as const : 'session' as const,
                  detail: [session.title, session.task, session.role, session.model].filter(Boolean).join('\n'),
                })), ...diffTabs.filter((tab) => tab.taskId === current.id).map((tab) => ({ id: tab.id, title: tab.path.split('/').at(-1)!, detail: `${current.name} · ${tab.path}`, active: false, kind: 'diff' as const }))] : []}
                selected={selectedTab}
                onSelect={(id) => {
                  const tab = diffTabs.find((tab) => tab.id === id)
                  if (tab) {
                    setActiveDiffId(id)
                    return
                  }
                  setActiveDiffId('')
                  if (current) setSelectedTabs((previous) => ({ ...previous, [current.id]: id }))
                }}
                onClose={closeDiff}
                onAdd={() => void addTask()}
              />
              <div
                id="agent-task-content"
                className="agent-task-content"
                role="tabpanel"
                aria-labelledby={selectedTab ? `task-tab-${selectedTab}` : undefined}
              >
                {error && (
                  <div className="error-message" role="alert">
                    <span>{error}</span>
                    <button aria-label="오류 닫기" onClick={() => setError('')}>
                      <X size={14} />
                    </button>
                  </div>
                )}
                {sessionError && <div className="session-observation-error" role="status">세션 관찰 실패: {sessionError}</div>}
                {current && !activeDiff && startupChecked && startupBlocked && <StartupPanel key={`startup:${current.path}`} workspace={current.path} project={current.project} snapshot={currentStartup ?? null} blocked={startupBlocked} onRun={() => { if (startupBlocked) autoStartTasks.current.set(current.path, current.id) }}
                  onSnapshot={(snapshot) => receiveStartup(snapshot, snapshot.workspace)} onError={setError} />}
                {state.tasks.filter((task) => mountedTasks.includes(task.id)).map((task) => (
                  <div className="task-terminal-slot" key={`terminal:${task.id}`} hidden={task.id !== current?.id || !!activeDiff || !!selectedSession || startupBlocked}>
                  <TaskTerminal
                    task={task}
                    active={task.id === current?.id && !activeDiff && !selectedSession && !startupBlocked}
                    theme={theme}
                    onStatus={(snapshot) =>
                      setTerminals((previous) => ({
                        ...previous,
                        [snapshot.taskId]: snapshot,
                      }))
                    }
                    onDraftUsed={() =>
                      setState((previous) => ({
                        ...previous,
                        tasks: previous.tasks.map((item) =>
                          item.id === task.id
                            ? { ...item, draft: undefined }
                            : item,
                        ),
                      }))
                    }
                  />
                  </div>
                ))}
                {activeDiff && <DiffView path={activeDiff.path} diff={diff} loading={diffLoading} onClose={() => closeDiff(activeDiff.id)} />}
                {current && ready && !activeDiff && !startupBlocked && startupChecked && selectedSession && <SessionTab key={`session:${selectedSession.id}`} session={selectedSession}
                  draft={sessionDrafts[selectedSession.id] ?? ''}
                  setDraft={(value) => setSessionDrafts((previous) => ({ ...previous, [selectedSession.id]: typeof value === 'function' ? value(previous[selectedSession.id] ?? '') : value }))}
                />}
                {current && ready && !activeDiff && <ProcessPanel key={`processes:${current.path}`} workspace={current.path} />}
                {!current && !activeDiff && (
                  <div className="welcome">
                    <div className="welcome-icon">
                      <img
                        src="./app-icon.png"
                        alt="시베리안고양이"
                        draggable={false}
                      />
                    </div>
                    <h2>작업 터미널을 시작하세요</h2>
                    <p>작업 하나에 전용 Worktree와 터미널이 함께 연결됩니다.</p>
                    <Button
                      variant="outline"
                      onClick={() =>
                        project ? void addTask(project) : void openProject()
                      }
                      disabled={!ready}
                    >
                      {project ? <Plus size={14} /> : <FolderOpen size={14} />}
                      {project ? '새 작업' : '프로젝트 열기'}
                    </Button>
                  </div>
                )}
              </div>
            </section>
          }
          changes={
            showChanges ? (
              <aside className="panel changes-panel" aria-label="변경 사항">
                <div className="changes-heading">
                  <h2>
                    <GitCompareArrows size={15} />
                    변경 사항
                    <span className="count">{repository.totalChanges}</span>
                  </h2>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="변경 사항 새로고침"
                    disabled={!current?.path || loading}
                    onClick={() => setRefresh((value) => value + 1)}
                  >
                    <RefreshCw className={loading ? 'spinning' : ''} />
                  </Button>
                </div>
                <div className="changes-summary">
                  <GitBranch size={13} />
                  <span>{current?.branch ?? '작업 공간'}</span>
                  <span className="muted">Working tree</span>
                </div>
                {repository.changes.length > 0 && (
                  <label className="file-search">
                    <Search size={13} />
                    <input
                      aria-label="변경 파일 검색"
                      placeholder="파일 검색…"
                      value={fileQuery}
                      onChange={(event) => setFileQuery(event.target.value)}
                    />
                  </label>
                )}
                <div
                  className="changes-content"
                >
                  {loading ? (
                    <div className="panel-empty">
                      <LoaderCircle size={20} className="spinning" />
                      <p>변경 사항 확인 중</p>
                    </div>
                  ) : repository.changes.length === 0 ? (
                    <div className="panel-empty">
                      {current?.path ? (
                        <Check size={25} strokeWidth={1.4} />
                      ) : (
                        <GitCompareArrows size={25} strokeWidth={1.4} />
                      )}
                      <strong>
                        {!current?.path
                          ? '작업을 선택해 주세요'
                          : repository.isGitRepository
                            ? '모든 변경 사항이 반영되었습니다'
                            : 'Git 저장소가 아닙니다'}
                      </strong>
                      <p>
                        {!current?.path
                          ? '전용 Worktree의 변경 사항이 여기에 표시됩니다.'
                          : repository.isGitRepository
                            ? '작업 중인 변경 파일이 여기에 표시됩니다.'
                            : 'Worktree 연결을 확인하거나 작업 삭제에서 로컬 기록을 정리해 주세요.'}
                      </p>
                    </div>
                  ) : (
                    <ChangedFilesTree files={repository.changes} query={fileQuery} workspace={current?.path ?? ''} selected={selectedFile} onSelect={openDiff} />
                  )}
                  {repository.totalChanges > 200 && (
                    <p className="file-limit">
                      200 / {repository.totalChanges}개 표시
                    </p>
                  )}
                </div>
                <footer className="changes-footer">
                  <span
                    className={`connection-dot ${connection.connected && connection.authenticated ? 'online' : ''}`}
                  />
                  <span>
                    {connecting
                      ? 'Codex 연결 중…'
                      : connection.connected && connection.authenticated
                        ? 'Codex 계정 연결됨'
                        : 'Codex 연결 확인 필요'}
                  </span>
                  <button
                    aria-label="Codex 연결 새로고침"
                    disabled={connecting}
                    onClick={() => void reconnect()}
                  >
                    <RefreshCw size={12} />
                  </button>
                </footer>
              </aside>
            ) : undefined
          }
        />
      </main>
      {opening && (
        <ProjectDialog
          onProject={projectOpened}
          onClose={() => setOpening(false)}
        />
      )}
      {newTaskProject && (
        <NewTaskDialog
          project={newTaskProject}
          worktrees={repositories[newTaskProject.path]?.worktrees ?? []}
          connection={connection}
          initialModel={
            defaults.model ||
            (
              connection.models.find((item) => item.isDefault) ??
              connection.models[0]
            )?.id ||
            ''
          }
          initialEffort={defaults.effort}
          initialBaseRef={defaults.baseRef}
          onManageBaseBranch={() => manageBaseBranch(newTaskProject)}
          onCreate={createTask}
          onClose={() => setNewTaskProject(null)}
        />
      )}
      {showSettings && (
        <SettingsDialog
          projects={projects}
          currentProject={settingsProject || state.project}
          initialTab={settingsProject ? 'project' : 'general'}
          connection={connection}
          theme={theme}
          onTheme={setTheme}
          onClose={() => {
            setShowSettings(false)
            setSettingsProject('')
          }}
        />
      )}
      <dialog
        ref={searchDialog}
        className="command-dialog"
        aria-label="빠른 이동"
      >
        <div className="command-input">
          <Search size={18} />
          <input
            autoFocus
            aria-label="프로젝트 및 작업 검색"
            placeholder="프로젝트, 작업, 브랜치 검색…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <button
            aria-label="검색 닫기"
            onClick={() => searchDialog.current?.close()}
          >
            <kbd>Esc</kbd>
          </button>
        </div>
        <div className="command-results">
          <span className="section-label">작업</span>
          {found.map((task) => (
            <button
              key={task.id}
              onClick={() => {
                selectTask(task)
                searchDialog.current?.close()
              }}
            >
              <Terminal size={15} />
              <span>
                {task.name}
                <small>{task.branch}</small>
              </span>
              <ArrowDown size={13} />
            </button>
          ))}
          {!found.length && (
            <p className="search-empty">검색 결과가 없습니다.</p>
          )}
        </div>
      </dialog>
      <dialog
        ref={taskDialog}
        className="form-dialog"
        aria-labelledby="task-management-title"
        onCancel={(event) => {
          if (managing) event.preventDefault()
        }}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void saveTask()
          }}
        >
          <h2 id="task-management-title">
            {target?.action === 'rename' ? '작업 이름 변경' : '작업 삭제'}
          </h2>
          {target?.action === 'rename' ? (
            <input
              autoFocus
              aria-label="작업 이름"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={100}
            />
          ) : (
            <>
              <p>
                {deletionPreview?.localOnly ? (
                  'Git 연결이 끊어진 작업입니다. 터미널을 종료하고 앱의 로컬 작업 기록과 초안만 정리합니다. 남아 있는 폴더, 로컬 브랜치와 Codex 원본 세션은 보존됩니다.'
                ) : (
                  <>
                    {target?.task.name}의 터미널을 종료하고 작업 폴더, 연결된 로컬
                    브랜치와 앱의 작업 기록을 함께 삭제합니다. 저장하지 않은 변경
                    사항과 추적하지 않는 파일도 함께 삭제되며 복구할 수 없습니다.
                    Codex 원본 세션과 원격 브랜치는 유지됩니다.
                  </>
                )}
              </p>
              <p className="target-path">{target?.task.path}</p>
              <p role="status">
                {deletionChanges === null
                  ? '변경 사항 확인 중…'
                  : deletionPreview?.localOnly
                    ? '폴더와 브랜치는 삭제하지 않습니다.'
                    : deletionChanges > 0
                      ? `변경 파일 ${deletionChanges}개를 포함해 삭제합니다.`
                      : '현재 변경 파일이 없습니다.'}
              </p>
              {deletionPreview && !deletionPreview.localOnly && (
                <p>현재 연결된 로컬 브랜치: {deletionPreview.branch ?? 'Detached HEAD (브랜치 삭제 없음)'}</p>
              )}
            </>
          )}
          {managementError && <p role="alert">{managementError}</p>}
          <div className="dialog-actions">
            <Button
              type="button"
              variant="ghost"
              disabled={managing}
              onClick={() => taskDialog.current?.close()}
            >
              취소
            </Button>
            <Button
              type="submit"
              variant={target?.action === 'delete' ? 'destructive' : 'default'}
              disabled={
                managing ||
                (target?.action === 'rename' && !name.trim()) ||
                (target?.action === 'delete' && deletionChanges === null)
              }
            >
              {managing
                ? '처리 중…'
                : target?.action === 'rename'
                  ? '저장'
                  : deletionPreview?.localOnly
                    ? '로컬 기록 정리'
                    : deletionChanges
                      ? '변경 사항 포함 삭제'
                      : '삭제'}
            </Button>
          </div>
        </form>
      </dialog>
    </div>
  )
}
