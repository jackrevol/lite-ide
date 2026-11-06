import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowDown,
  Check,
  ChevronDown,
  ChevronRight,
  FileCode2,
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
  CodexStatus,
  Project,
  ProjectDefaults,
  RepositorySnapshot,
  TerminalSnapshot,
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
  const [selectedFile, setSelectedFile] = useState('')
  const [diff, setDiff] = useState('')
  const [diffLoading, setDiffLoading] = useState(false)
  const [fileQuery, setFileQuery] = useState('')
  const [search, setSearch] = useState('')
  const [collapsed, setCollapsed] = useState<string[]>([])
  const [newTaskProject, setNewTaskProject] = useState<Project | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [defaults, setDefaults] = useState<ProjectDefaults>({
    baseRef: 'HEAD',
    model: '',
    effort: '',
  })
  const [branches, setBranches] = useState<string[]>([])
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
  const managementRequest = useRef(0)
  const searchDialog = useRef<HTMLDialogElement>(null)
  const taskDialog = useRef<HTMLDialogElement>(null)
  const current = state.tasks.find((task) => task.id === state.taskId)
  const project = projects.find((item) => item.path === state.project)
  const projectTasks = state.tasks.filter(
    (task) => task.project === state.project,
  )

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
      return
    }
    let disposed = false
    setLoading(true)
    void window.desktop
      .inspectRepository(directory)
      .then((snapshot) => {
        if (disposed) return
        setRepository(current ? snapshot : emptyRepository)
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
          setRepositories((previous) => ({
            ...previous,
            // 손상된 작업 경로의 빈 결과로 프로젝트 Worktree 목록을 덮어쓰지 않습니다.
            [project.path]: snapshot.isGitRepository
              ? snapshot : previous[project.path] ?? emptyRepository,
          }))
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
    setSelectedFile('')
    setDiff('')
  }, [current?.path])
  useEffect(() => {
    if (!current || !selectedFile) return
    let disposed = false
    setDiffLoading(true)
    void window.desktop
      .readDiff(current.path, selectedFile)
      .then((value) => {
        if (!disposed) setDiff(value)
      })
      .catch((cause) => {
        if (!disposed) setDiff(errorText(cause))
      })
      .finally(() => {
        if (!disposed) setDiffLoading(false)
      })
    return () => {
      disposed = true
    }
  }, [current?.path, selectedFile, refresh])

  function selectTask(task: WorkspaceTask) {
    setState((previous) => ({
      ...previous,
      project: task.project,
      taskId: task.id,
    }))
  }
  async function openProject() {
    setOpening(true)
  }
  function projectOpened(opened: Project) {
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
      const [settings, refs] = await Promise.all([
        window.desktop.getSettings(),
        window.desktop.listBranches(item.path),
      ])
      setDefaults(
        settings.projects[projectSettingsKey(item.path)] ?? {
          baseRef: 'HEAD',
          model: '',
          effort: '',
        },
      )
      setBranches(refs)
      setNewTaskProject(item)
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      openingTask.current = false
    }
  }, [])
  async function createTask(task: WorkspaceTask) {
    setState((previous) => ({
      tasks: previous.tasks.some((item) => item.id === task.id)
        ? previous.tasks
        : [...previous.tasks, task],
      project: task.project,
      taskId: task.id,
    }))
    setRefresh((value) => value + 1)
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
                        onClick={() =>
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
                        }
                      >
                        <FolderOpen size={14} />
                        <span>{item.name}</span>
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
                tasks={projectTasks.map((task) => ({
                  id: task.id,
                  title: task.name,
                  active: !!terminals[task.id]?.running,
                }))}
                selected={current?.id}
                onSelect={(id) => {
                  const task = state.tasks.find((task) => task.id === id)
                  if (task) selectTask(task)
                }}
                onAdd={() => void addTask()}
              />
              <div
                id="agent-task-content"
                className="agent-task-content"
                role="tabpanel"
                aria-labelledby={current ? `task-tab-${current.id}` : undefined}
              >
                <div className="agent-heading terminal-heading">
                  <div className="heading-title">
                    <Terminal size={15} />
                    <h1>{current?.name ?? '작업 터미널'}</h1>
                  </div>
                  {current && (
                    <div className="terminal-controls">
                      <button
                        aria-label="Codex 터미널"
                        title="현재 프로세스를 종료하고 Codex로 전환"
                        aria-pressed={current.terminalKind === 'codex'}
                        onClick={() =>
                          setState((previous) => ({
                            ...previous,
                            tasks: previous.tasks.map((task) =>
                              task.id === current.id
                                ? { ...task, terminalKind: 'codex' }
                                : task,
                            ),
                          }))
                        }
                      >
                        Codex
                      </button>
                      <button
                        aria-label="셸 터미널"
                        title="현재 프로세스를 종료하고 셸로 전환"
                        aria-pressed={current.terminalKind === 'shell'}
                        onClick={() =>
                          setState((previous) => ({
                            ...previous,
                            tasks: previous.tasks.map((task) =>
                              task.id === current.id
                                ? { ...task, terminalKind: 'shell' }
                                : task,
                            ),
                          }))
                        }
                      >
                        셸
                      </button>
                      <button
                        title="터미널 종료"
                        aria-label="터미널 종료"
                        disabled={!terminals[current.id]?.running}
                        onClick={() =>
                          void window.desktop
                            .closeTerminal(current.id)
                            .catch((cause) => setError(errorText(cause)))
                        }
                      >
                        <Square size={12} />
                      </button>
                    </div>
                  )}
                </div>
                {error && (
                  <div className="error-message" role="alert">
                    <span>{error}</span>
                    <button aria-label="오류 닫기" onClick={() => setError('')}>
                      <X size={14} />
                    </button>
                  </div>
                )}
                {current && ready ? (
                  <TaskTerminal
                    key={current.id}
                    task={current}
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
                        tasks: previous.tasks.map((task) =>
                          task.id === current.id
                            ? { ...task, draft: undefined }
                            : task,
                        ),
                      }))
                    }
                  />
                ) : (
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
                  className={`changes-content ${selectedFile ? 'with-preview' : ''}`}
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
                    repository.changes
                      .filter((file) =>
                        file.path
                          .toLowerCase()
                          .includes(fileQuery.toLowerCase()),
                      )
                      .map((file) => (
                        <button
                          key={file.path}
                          title={file.path}
                          aria-label={file.path}
                          className={`file-row ${selectedFile === file.path ? 'selected' : ''}`}
                          onClick={() => setSelectedFile(file.path)}
                        >
                          <FileCode2 size={14} />
                          <span>
                            {file.path.split('/').at(-1)}
                            <small>
                              {file.path.includes('/')
                                ? file.path.slice(0, file.path.lastIndexOf('/'))
                                : ''}
                            </small>
                          </span>
                          <span
                            className={`file-status ${file.status.includes('D') ? 'deleted' : file.status.includes('?') || file.status.includes('A') ? 'added' : ''}`}
                          >
                            {file.status.trim() === '??'
                              ? 'U'
                              : file.status.trim()}
                          </span>
                        </button>
                      ))
                  )}
                  {repository.totalChanges > 200 && (
                    <p className="file-limit">
                      200 / {repository.totalChanges}개 표시
                    </p>
                  )}
                </div>
                {selectedFile && (
                  <section className="diff-preview" aria-label="파일 변경 내용">
                    <div className="diff-heading">
                      <span title={selectedFile}>{selectedFile}</span>
                      <button
                        aria-label="변경 내용 닫기"
                        onClick={() => setSelectedFile('')}
                      >
                        <X size={14} />
                      </button>
                    </div>
                    {diffLoading ? (
                      <div className="panel-empty">
                        <LoaderCircle size={18} className="spinning" />
                      </div>
                    ) : (
                      <pre>
                        {diff.split('\n').map((line, index) => (
                          <div
                            key={index}
                            className={
                              line.startsWith('+') && !line.startsWith('+++')
                                ? 'diff-add'
                                : line.startsWith('-') &&
                                    !line.startsWith('---')
                                  ? 'diff-remove'
                                  : line.startsWith('@@')
                                    ? 'diff-hunk'
                                    : ''
                            }
                          >
                            <span className="line-number">{index + 1}</span>
                            {line || ' '}
                          </div>
                        ))}
                      </pre>
                    )}
                  </section>
                )}
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
          branches={branches}
          onCreate={createTask}
          onClose={() => setNewTaskProject(null)}
        />
      )}
      {showSettings && (
        <SettingsDialog
          projects={projects}
          currentProject={state.project}
          connection={connection}
          theme={theme}
          onTheme={setTheme}
          onClose={() => setShowSettings(false)}
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
