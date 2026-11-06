import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  FileCode2,
  FolderOpen,
  GitBranch,
  GitCompareArrows,
  LoaderCircle,
  MessageSquare,
  Moon,
  PanelRight,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Square,
  Sun,
  Trash2,
  X,
} from 'lucide-react'
import { Button } from './components/ui/button'
import { Conversation } from './components/Conversation'
import { CodexUsagePanel } from './components/CodexUsagePanel'
import { ProjectDialog } from './components/ProjectDialog'
import { AppUpdateButton } from './components/AppUpdateButton'
import { NewTaskDialog } from './components/NewTaskDialog'
import type { TaskMode } from './lib/workspace-state'
import { createSession, loadWorkspace, storageKey } from './lib/workspace-state'
import type {
  AgentSession,
  CodexStatus,
  Project,
  RepositorySnapshot,
} from '../../shared/types'

const emptyRepository: RepositorySnapshot = {
  isGitRepository: false,
  worktrees: [],
  changes: [],
  totalChanges: 0,
}
const labels = {
  idle: '대기',
  running: '작업 중',
  waiting: '응답 필요',
  completed: '완료',
  interrupted: '중단됨',
  failed: '오류',
}
const samePath = (a: string, b: string) =>
  a.replaceAll('\\', '/') === b.replaceAll('\\', '/')
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

export function App() {
  const [state, setState] = useState(loadWorkspace)
  const [projects, setProjects] = useState<Project[]>([])
  const [agents, setAgents] = useState<Record<string, AgentSession>>({})
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
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
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
  const [rename, setRename] = useState('')
  const [branch, setBranch] = useState('')
  const [creatingTree, setCreatingTree] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [newTaskOpen, setNewTaskOpen] = useState(false)
  const searchDialog = useRef<HTMLDialogElement>(null)
  const renameDialog = useRef<HTMLDialogElement>(null)
  const deleteDialog = useRef<HTMLDialogElement>(null)
  const treeDialog = useRef<HTMLDialogElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const key = state.workspace || 'welcome'
  const tabs = state.sessions[key] ?? []
  const current =
    tabs.find((session) => session.id === state.selected[key]) ?? tabs[0]
  const agent = current ? agents[current.id] : undefined
  const active = agent?.status === 'running' || agent?.status === 'waiting'
  const project = projects.find((item) => item.path === state.project)
  const tree = repository.worktrees.find((item) =>
    samePath(item.path, state.workspace),
  )
  const selectedModel = connection.models.find((item) => item.id === model)
  const title = agent?.title ?? current?.title ?? '새 작업'

  function selectWorkspace(
    path: string,
    projectPath = state.project,
    sessionId?: string,
  ) {
    setState((previous) => ({
      ...previous,
      project: projectPath,
      workspace: path,
      sessions: previous.sessions[path]
        ? previous.sessions
        : { ...previous.sessions, [path]: [createSession()] },
      selected: sessionId
        ? { ...previous.selected, [path]: sessionId }
        : previous.selected,
    }))
  }

  const reconnect = useCallback(async () => {
    setConnecting(true)
    try {
      const result = await window.desktop.codexStatus()
      setConnection(result)
      setModel((previous) =>
        result.models.some((item) => item.id === previous)
          ? previous
          : ((result.models.find((item) => item.isDefault) ?? result.models[0])
              ?.id ?? ''),
      )
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
      setError(
        '로컬 저장 공간이 부족합니다. 입력한 내용을 별도로 보관해 주세요.',
      )
    }
  }, [state])
  useEffect(() => {
    setEffort(selectedModel?.defaultEffort ?? '')
  }, [selectedModel?.id, selectedModel?.defaultEffort])
  useEffect(() => {
    let disposed = false
    const unsubscribeDisconnect = window.desktop.onCodexDisconnect((reason) => {
      setConnection({
        connected: false,
        authenticated: false,
        models: [],
        error: reason,
      })
    })
    const unsubscribe = window.desktop.onSession((session) => {
      setAgents((previous) => ({ ...previous, [session.id]: session }))
      if (['completed', 'interrupted', 'failed'].includes(session.status))
        setRefresh((value) => value + 1)
    })
    void Promise.all([
      window.desktop.listProjects(),
      window.desktop.listSessions(),
    ])
      .then(async ([opened, saved]) => {
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
        setAgents((previous) => ({
          ...Object.fromEntries(saved.map((item) => [item.id, item])),
          ...previous,
        }))
        setState((previous) => {
          const sessions = { ...previous.sessions }
          for (const item of saved) {
            if (
              !(sessions[item.workspace] ?? []).some(
                (entry) => entry.id === item.id,
              )
            )
              sessions[item.workspace] = [
                ...(sessions[item.workspace] ?? []),
                { id: item.id, title: item.title, draft: '' },
              ]
          }
          const restored =
            opened.find((item) => item.path === previous.project) ?? opened[0]
          const snapshot = snapshots.find(
            ([path]) => path === restored?.path,
          )?.[1]
          const workspace = restored
            ? (snapshot?.worktrees.find((item) =>
                samePath(item.path, previous.workspace),
              )?.path ?? restored.path)
            : ''
          if (workspace && !sessions[workspace]?.length)
            sessions[workspace] = [createSession()]
          return {
            ...previous,
            sessions,
            project: restored?.path ?? '',
            workspace,
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
      unsubscribe()
      unsubscribeDisconnect()
    }
  }, [reconnect])

  useEffect(() => {
    if (!ready || !state.workspace) {
      setRepository(emptyRepository)
      return
    }
    let disposed = false
    setLoading(true)
    setSelectedFile('')
    setDiff('')
    window.desktop
      .inspectRepository(state.workspace)
      .then((snapshot) => {
        if (disposed) return
        setRepository(snapshot)
        setRepositories((previous) => ({
          ...previous,
          [state.project]: snapshot,
        }))
      })
      .catch((cause) => {
        if (!disposed) setError(errorText(cause))
      })
      .finally(() => {
        if (!disposed) setLoading(false)
      })
    return () => {
      disposed = true
    }
  }, [state.workspace, state.project, ready, refresh])

  useEffect(() => {
    if (!selectedFile || !state.workspace) {
      setDiff('')
      return
    }
    let disposed = false
    setDiffLoading(true)
    window.desktop
      .readDiff(state.workspace, selectedFile)
      .then((value) => {
        if (!disposed) setDiff(value || '표시할 텍스트 변경 내용이 없습니다.')
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
  }, [selectedFile, state.workspace, refresh])

  const addSession = useCallback(() => {
    setNewTaskOpen(true)
  }, [])
  async function createTask(mode: TaskMode, branch: string) {
    if (mode === 'worktree' && (!project || !repository.isGitRepository))
      throw new Error('Worktree를 만들 Git 프로젝트를 먼저 열어 주세요.')
    const workspace =
      mode === 'worktree'
        ? (await window.desktop.createWorktree(project!.path, branch)).path
        : (project?.path ?? '')
    const target = workspace || 'welcome'
    const session = createSession((state.sessions[target]?.length ?? 0) + 1)
    setState((previous) => ({
      ...previous,
      workspace,
      newTaskMode: mode,
      sessions: {
        ...previous.sessions,
        [target]: [...(previous.sessions[target] ?? []), session],
      },
      selected: { ...previous.selected, [target]: session.id },
    }))
    setRefresh((value) => value + 1)
  }
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.isComposing) return
      if (event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setSearch('')
        searchDialog.current?.showModal()
      }
      if (
        event.key.toLowerCase() === 'n' &&
        !document.querySelector('dialog[open]')
      ) {
        event.preventDefault()
        addSession()
      }
      if (event.key.toLowerCase() === 'b' && event.shiftKey) {
        event.preventDefault()
        setShowChanges((value) => !value)
      }
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [addSession])

  async function openProject() {
    setOpening(true)
  }
  function projectOpened(opened: Project) {
    setProjects((previous) =>
      previous.some((item) => item.path === opened.path)
        ? previous
        : [...previous, opened],
    )
    selectWorkspace(opened.path, opened.path)
  }
  function updateDraft(draft: string) {
    setState((previous) => ({
      ...previous,
      sessions: {
        ...previous.sessions,
        [key]: (previous.sessions[key] ?? []).map((session) =>
          session.id === current?.id ? { ...session, draft } : session,
        ),
      },
    }))
  }
  async function send() {
    if (!current?.draft.trim() || !state.workspace || submitting || active)
      return
    const text = current.draft
    const sessionId = current.id
    setSubmitting(true)
    setError('')
    updateDraft('')
    try {
      await window.desktop.sendMessage({
        sessionId,
        workspace: state.workspace,
        text,
        model,
        effort,
      })
    } catch (cause) {
      setError(errorText(cause))
      setState((previous) => ({
        ...previous,
        sessions: {
          ...previous.sessions,
          [key]: previous.sessions[key].map((item) =>
            item.id === sessionId && !item.draft
              ? { ...item, draft: text }
              : item,
          ),
        },
      }))
    } finally {
      setSubmitting(false)
      composer.current?.focus()
    }
  }
  async function renameCurrent() {
    if (!current || !rename.trim()) return
    try {
      if (agent) await window.desktop.renameSession(current.id, rename)
      setState((previous) => ({
        ...previous,
        sessions: {
          ...previous.sessions,
          [key]: previous.sessions[key].map((item) =>
            item.id === current.id ? { ...item, title: rename.trim() } : item,
          ),
        },
      }))
      renameDialog.current?.close()
    } catch (cause) {
      setError(errorText(cause))
    }
  }
  async function deleteCurrent() {
    if (!current || active) return
    try {
      if (agent) await window.desktop.deleteSession(current.id)
      setAgents((previous) => {
        const next = { ...previous }
        delete next[current.id]
        return next
      })
      setState((previous) => {
        const remaining = previous.sessions[key].filter(
          (item) => item.id !== current.id,
        )
        return {
          ...previous,
          sessions: {
            ...previous.sessions,
            [key]: remaining.length ? remaining : [createSession()],
          },
        }
      })
      deleteDialog.current?.close()
    } catch (cause) {
      setError(errorText(cause))
    }
  }
  async function newWorktree() {
    if (!project || !branch.trim()) return
    setCreatingTree(true)
    try {
      const created = await window.desktop.createWorktree(
        project.path,
        branch.trim(),
      )
      selectWorkspace(created.path)
      setRefresh((value) => value + 1)
      treeDialog.current?.close()
      setBranch('')
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setCreatingTree(false)
    }
  }

  const query = search.trim().toLowerCase()
  const searchResults = projects
    .flatMap((item) => {
      const paths = new Set([
        item.path,
        ...(repositories[item.path]?.worktrees.map((entry) => entry.path) ??
          []),
      ])
      return [...paths].flatMap((path) =>
        (state.sessions[path] ?? []).map((session) => ({
          project: item,
          path,
          session,
          title: agents[session.id]?.title ?? session.title,
        })),
      )
    })
    .filter((item) =>
      `${item.title} ${item.project.name} ${item.path}`
        .toLowerCase()
        .includes(query),
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
            <span>{tree?.branch ?? 'Codex'}</span>
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
              onClick={() => setShowChanges(!showChanges)}
            >
              <PanelRight />
            </Button>
          </div>
        </div>
      </header>
      <main
        className={`workspace-layout ${showChanges ? '' : 'without-changes'}`}
      >
        <aside
          className="panel projects-panel"
          aria-label="프로젝트 및 Worktree"
        >
          <div className="sidebar-top">
            <Button className="new-task" variant="outline" onClick={addSession}>
              <Plus size={15} />새 작업<kbd>Ctrl N</kbd>
            </Button>
          </div>
          <div className="section-label">
            <span>프로젝트</span>
            <button
              title="프로젝트 열기"
              aria-label="프로젝트 열기"
              disabled={opening}
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
                  disabled={opening}
                >
                  폴더 열기
                </Button>
              </div>
            )}
            {projects.map((item) => {
              const trees = repositories[item.path]?.worktrees ?? []
              const workspaces = trees.length
                ? trees
                : [{ path: item.path, branch: '로컬 작업 공간' }]
              const folded = collapsed.includes(item.path)
              return (
                <div className="project-group" key={item.path}>
                  <div
                    className={`project-row ${state.project === item.path ? 'current-project' : ''}`}
                  >
                    <button
                      aria-label={`${item.name} ${folded ? '펼치기' : '접기'}`}
                      aria-expanded={!folded}
                      onClick={() =>
                        setCollapsed(
                          folded
                            ? collapsed.filter((path) => path !== item.path)
                            : [...collapsed, item.path],
                        )
                      }
                    >
                      {folded ? (
                        <ChevronRight size={13} />
                      ) : (
                        <ChevronDown size={13} />
                      )}
                    </button>
                    <button
                      className="project-name"
                      title={item.path}
                      onClick={() => selectWorkspace(item.path, item.path)}
                    >
                      <FolderOpen size={14} />
                      <span>{item.name}</span>
                    </button>
                  </div>
                  {!folded &&
                    workspaces.map((entry) => (
                      <div className="workspace-group" key={entry.path}>
                        <button
                          className={`workspace-row ${samePath(state.workspace, entry.path) ? 'selected' : ''}`}
                          title={entry.path}
                          onClick={() => selectWorkspace(entry.path, item.path)}
                        >
                          <GitBranch size={13} />
                          <span>{entry.branch}</span>
                          {samePath(state.workspace, entry.path) && (
                            <span className="active-dot" />
                          )}
                        </button>
                        {(state.sessions[entry.path] ?? []).map((session) => {
                          const live = agents[session.id]
                          return (
                            <button
                              key={session.id}
                              className={`session-row ${current?.id === session.id ? 'selected' : ''}`}
                              title={live?.title ?? session.title}
                              aria-current={
                                current?.id === session.id ? 'page' : undefined
                              }
                              onClick={() =>
                                selectWorkspace(
                                  entry.path,
                                  item.path,
                                  session.id,
                                )
                              }
                            >
                              <span
                                className={`session-dot ${live?.status ?? 'idle'}`}
                              />
                              <span>{live?.title ?? session.title}</span>
                              {live?.status === 'waiting' && (
                                <span className="attention-tag">응답</span>
                              )}
                            </button>
                          )
                        })}
                      </div>
                    ))}
                </div>
              )
            })}
            {!state.workspace &&
              tabs.map((session) => (
                <button
                  className={`session-row ${current?.id === session.id ? 'selected' : ''}`}
                  key={session.id}
                  onClick={() =>
                    setState((previous) => ({
                      ...previous,
                      selected: { ...previous.selected, welcome: session.id },
                    }))
                  }
                >
                  <MessageSquare size={13} />
                  <span>{session.title}</span>
                </button>
              ))}
          </nav>
          {project && (
            <button
              className="add-worktree"
              disabled={!repository.isGitRepository || loading}
              onClick={() => {
                setBranch('')
                treeDialog.current?.showModal()
              }}
            >
              <Plus size={13} />새 Worktree
            </button>
          )}
          <footer className="sidebar-footer">
            <CodexUsagePanel connection={connection} connecting={connecting} />
            <div className="sidebar-bottom">
              <button
                title="프로젝트 열기"
                onClick={() => void openProject()}
                disabled={opening}
              >
                <FolderOpen size={16} />
              </button>
              <span>Lite IDE</span>
              <button
                aria-label={theme === 'dark' ? '라이트 테마' : '다크 테마'}
                onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              >
                {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
              </button>
            </div>
          </footer>
        </aside>
        <section className="panel agent-panel" aria-label="Codex 작업">
          <div className="agent-heading">
            <div className="heading-title">
              <MessageSquare size={16} />
              <h1>{title}</h1>
              <span className={`status-label ${agent?.status ?? 'idle'}`}>
                {agent ? labels[agent.status] : 'Codex'}
              </span>
            </div>
            <div className="heading-actions">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="작업 이름 변경"
                onClick={() => {
                  setRename(title)
                  renameDialog.current?.showModal()
                }}
              >
                <Pencil />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="작업 삭제"
                disabled={active}
                onClick={() => deleteDialog.current?.showModal()}
              >
                <Trash2 />
              </Button>
            </div>
          </div>
          {agent?.messages.length ? (
            <Conversation session={agent} />
          ) : (
            <div className="welcome">
              <div className="welcome-icon">
                <img
                  src="./app-icon.png"
                  alt="시베리안고양이"
                  draggable={false}
                />
              </div>
              <h2>무엇을 만들어 볼까요?</h2>
              <p>
                {project
                  ? `${project.name}에서 Codex와 함께 작업하세요.`
                  : '프로젝트를 열고, 생각을 코드로 옮겨보세요.'}
              </p>
              <div className="starter-actions">
                {[
                  '프로젝트 구조를 파악해 줘',
                  '변경 사항을 검토해 줘',
                  '실패하는 테스트를 찾아 고쳐 줘',
                ].map((prompt) => (
                  <button
                    key={prompt}
                    onClick={() => {
                      updateDraft(prompt)
                      composer.current?.focus()
                    }}
                  >
                    <span>{prompt}</span>
                    <ArrowUp size={13} />
                  </button>
                ))}
              </div>
              {!project && (
                <Button
                  variant="outline"
                  onClick={() => void openProject()}
                  disabled={opening}
                >
                  <FolderOpen size={14} />
                  프로젝트 열기
                </Button>
              )}
            </div>
          )}
          {error && (
            <div className="error-message" role="alert">
              <span>{error}</span>
              <button aria-label="오류 닫기" onClick={() => setError('')}>
                <X size={14} />
              </button>
            </div>
          )}
          <div className="composer-area">
            <div className="composer">
              <textarea
                ref={composer}
                aria-label="Codex에게 메시지"
                placeholder={
                  project
                    ? 'Codex에게 작업을 요청하세요…'
                    : '어떤 작업을 하고 싶으신가요?'
                }
                value={current?.draft ?? ''}
                onChange={(event) => updateDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === 'Enter' &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing &&
                    event.nativeEvent.keyCode !== 229
                  ) {
                    event.preventDefault()
                    void send()
                  }
                }}
                rows={3}
              />
              <div className="composer-toolbar">
                <Code2 size={15} />
                <select
                  aria-label="모델"
                  value={model}
                  disabled={connecting || !connection.models.length || active}
                  onChange={(event) => setModel(event.target.value)}
                >
                  {!connection.models.length && <option value="">Codex</option>}
                  {connection.models.map((item) => (
                    <option value={item.id} key={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
                {selectedModel?.efforts.length ? (
                  <select
                    aria-label="추론 수준"
                    value={effort}
                    disabled={active}
                    onChange={(event) => setEffort(event.target.value)}
                  >
                    {selectedModel.efforts.map((item) => (
                      <option value={item} key={item}>
                        {item}
                      </option>
                    ))}
                  </select>
                ) : null}
                <span className="toolbar-spacer" />
                {active ? (
                  <Button
                    aria-label="작업 중단"
                    title="작업 중단"
                    size="icon-sm"
                    variant="secondary"
                    onClick={() =>
                      void window.desktop
                        .interruptSession(agent.id)
                        .catch((cause) => setError(errorText(cause)))
                    }
                  >
                    <Square size={13} fill="currentColor" />
                  </Button>
                ) : (
                  <Button
                    aria-label="메시지 보내기"
                    title="메시지 보내기"
                    size="icon-sm"
                    disabled={
                      !ready ||
                      !state.workspace ||
                      !current?.draft.trim() ||
                      !connection.connected ||
                      !connection.authenticated ||
                      submitting
                    }
                    onClick={() => void send()}
                  >
                    <ArrowUp />
                  </Button>
                )}
              </div>
            </div>
            <div className="composer-meta">
              <span title={state.workspace}>
                <GitBranch size={12} />
                {tree?.branch ?? project?.name ?? '프로젝트 선택'}
              </span>
              <span>Enter 전송 · Shift Enter 줄바꿈</span>
            </div>
            {(!connection.connected || !connection.authenticated) &&
              !connecting && (
                <div className="connection-banner">
                  <span>
                    {connection.error ?? 'Codex에 로그인해 작업을 시작하세요.'}
                  </span>
                  <button
                    onClick={() =>
                      void (
                        connection.connected
                          ? window.desktop.loginCodex()
                          : reconnect()
                      ).catch((cause) => setError(errorText(cause)))
                    }
                  >
                    {connection.connected ? '로그인' : '다시 연결'}
                  </button>
                  {connection.connected && (
                    <button onClick={() => void reconnect()}>연결 확인</button>
                  )}
                </div>
              )}
          </div>
        </section>
        {showChanges && (
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
                disabled={!state.workspace || loading}
                onClick={() => setRefresh((value) => value + 1)}
              >
                <RefreshCw className={loading ? 'spinning' : ''} />
              </Button>
            </div>
            <div className="changes-summary">
              <GitBranch size={13} />
              <span>{tree?.branch ?? '작업 공간'}</span>
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
                  {state.workspace ? (
                    <Check size={25} strokeWidth={1.4} />
                  ) : (
                    <GitCompareArrows size={25} strokeWidth={1.4} />
                  )}
                  <strong>
                    {!state.workspace
                      ? '아직 열린 프로젝트가 없습니다'
                      : repository.isGitRepository
                        ? '모든 변경 사항이 반영되었습니다'
                        : 'Git 저장소가 아닙니다'}
                  </strong>
                  <p>
                    {!state.workspace
                      ? '프로젝트의 변경 사항이 여기에 표시됩니다.'
                      : repository.isGitRepository
                        ? '작업 중인 변경 파일이 여기에 표시됩니다.'
                        : 'Codex 작업은 그대로 사용할 수 있습니다.'}
                  </p>
                </div>
              ) : (
                repository.changes
                  .filter((file) =>
                    file.path.toLowerCase().includes(fileQuery.toLowerCase()),
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
                        {file.status.trim() === '??' ? 'U' : file.status.trim()}
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
                            : line.startsWith('-') && !line.startsWith('---')
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
                    ? 'Codex 연결됨'
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
        )}
      </main>
      {opening && (
        <ProjectDialog
          onProject={projectOpened}
          onClose={() => setOpening(false)}
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
            placeholder="프로젝트, 작업, Worktree 검색…"
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
          {searchResults.map((result) => (
            <button
              key={`${result.project.path}:${result.session.id}`}
              onClick={() => {
                selectWorkspace(
                  result.path,
                  result.project.path,
                  result.session.id,
                )
                searchDialog.current?.close()
              }}
            >
              <MessageSquare size={15} />
              <span>
                {result.title}
                <small>
                  {result.project.name} · {result.path.split(/[\\/]/).at(-1)}
                </small>
              </span>
              <ArrowDown size={13} />
            </button>
          ))}
          {!searchResults.length && (
            <p className="search-empty">검색 결과가 없습니다.</p>
          )}
        </div>
        <footer>방향키 대신 Tab으로 이동 · Enter 선택</footer>
      </dialog>
      <dialog
        ref={renameDialog}
        className="form-dialog"
        aria-labelledby="rename-title"
      >
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void renameCurrent()
          }}
        >
          <h2 id="rename-title">작업 이름 변경</h2>
          <input
            autoFocus
            aria-label="작업 이름"
            value={rename}
            onChange={(event) => setRename(event.target.value)}
            maxLength={100}
          />
          <div className="dialog-actions">
            <Button
              type="button"
              variant="ghost"
              onClick={() => renameDialog.current?.close()}
            >
              취소
            </Button>
            <Button type="submit" disabled={!rename.trim()}>
              저장
            </Button>
          </div>
        </form>
      </dialog>
      <dialog
        ref={deleteDialog}
        className="form-dialog"
        aria-labelledby="delete-title"
      >
        <h2 id="delete-title">이 작업을 목록에서 삭제할까요?</h2>
        <p>
          이 앱의 대화 기록과 입력 내용을 삭제합니다. 프로젝트 파일과 Codex 원본
          세션은 유지됩니다.
        </p>
        <div className="dialog-actions">
          <Button variant="ghost" onClick={() => deleteDialog.current?.close()}>
            취소
          </Button>
          <Button variant="destructive" onClick={() => void deleteCurrent()}>
            삭제
          </Button>
        </div>
      </dialog>
      {newTaskOpen && (
        <NewTaskDialog
          mode={state.newTaskMode}
          canCreateWorktree={Boolean(project && repository.isGitRepository)}
          onCreate={createTask}
          onClose={() => {
            setNewTaskOpen(false)
            composer.current?.focus()
          }}
        />
      )}
      <dialog
        ref={treeDialog}
        className="form-dialog"
        aria-labelledby="tree-title"
      >
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void newWorktree()
          }}
        >
          <h2 id="tree-title">새 Worktree</h2>
          <p>현재 프로젝트에서 독립적인 브랜치와 작업 폴더를 만듭니다.</p>
          <input
            autoFocus
            aria-label="새 브랜치 이름"
            placeholder="feature/my-task"
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
          />
          <div className="dialog-actions">
            <Button
              type="button"
              variant="ghost"
              onClick={() => treeDialog.current?.close()}
            >
              취소
            </Button>
            <Button type="submit" disabled={!branch.trim() || creatingTree}>
              {creatingTree ? '생성 중…' : '만들기'}
            </Button>
          </div>
        </form>
      </dialog>
    </div>
  )
}
