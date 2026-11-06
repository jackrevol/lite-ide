import { useEffect, useRef, useState } from 'react'
import {
  ArrowUp,
  ChevronRight,
  Code2,
  FileCode2,
  FolderOpen,
  GitBranch,
  Plus,
  RefreshCw,
  X,
} from 'lucide-react'
import { Button } from './components/ui/button'
import { Badge } from './components/ui/badge'
import { Tabs, TabsList, TabsTab, TabsPanel } from './components/ui/tabs'
import { Textarea } from './components/ui/textarea'
import { Separator } from './components/ui/separator'
import type { Project, RepositorySnapshot } from '../../shared/types'

type Session = { id: string; title: string; draft: string }
const initialSession = (): Session => ({
  id: crypto.randomUUID(),
  title: 'Agent 1',
  draft: '',
})
const emptyRepository: RepositorySnapshot = {
  isGitRepository: false,
  worktrees: [],
  changes: [],
  totalChanges: 0,
}

export function App() {
  const [projects, setProjects] = useState<Project[]>([])
  const [project, setProject] = useState<Project | null>(null)
  const [workspace, setWorkspace] = useState('')
  const [repository, setRepository] = useState(emptyRepository)
  const [sessions, setSessions] = useState<Record<string, Session[]>>(() => ({
    welcome: [initialSession()],
  }))
  const [selectedSessions, setSelectedSessions] = useState<
    Record<string, string>
  >({})
  const [refresh, setRefresh] = useState(0)
  const [loading, setLoading] = useState(false)
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState('')
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [diff, setDiff] = useState('')
  const [reviewing, setReviewing] = useState(false)
  const reviewDialog = useRef<HTMLDialogElement>(null)
  const reviewRequest = useRef(0)
  const key = workspace || 'welcome'
  const tabs = sessions[key] ?? []
  const current =
    tabs.find((session) => session.id === selectedSessions[key]) ?? tabs[0]
  const activeWorktree = repository.worktrees.find(
    (tree) =>
      tree.path.replaceAll('\\', '/') === workspace.replaceAll('\\', '/'),
  )

  function selectWorkspace(path: string) {
    setWorkspace(path)
    setSessions((previous) =>
      previous[path] ? previous : { ...previous, [path]: [initialSession()] },
    )
  }

  async function openProject() {
    setOpening(true)
    setError('')
    try {
      const opened = await window.desktop.openProject()
      if (!opened) return
      setProjects((previous) =>
        previous.some((item) => item.path === opened.path)
          ? previous
          : [...previous, opened],
      )
      setProject(opened)
      selectWorkspace(opened.path)
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : '프로젝트를 열지 못했습니다.',
      )
    } finally {
      setOpening(false)
    }
  }

  useEffect(() => {
    let disposed = false
    reviewRequest.current++
    reviewDialog.current?.close()
    setSelectedFile(null)
    setReviewing(false)
    setRepository(emptyRepository)
    setError('')
    if (!workspace) return
    setLoading(true)
    window.desktop
      .inspectRepository(workspace)
      .then((snapshot) => {
        if (disposed) return
        setRepository(snapshot)
        setSelectedFile(snapshot.changes[0]?.path ?? null)
      })
      .catch((cause: unknown) => {
        if (!disposed)
          setError(
            cause instanceof Error
              ? cause.message
              : 'Git 상태를 확인하지 못했습니다.',
          )
      })
      .finally(() => {
        if (!disposed) setLoading(false)
      })
    return () => {
      disposed = true
    }
  }, [workspace, refresh])

  function addSession() {
    const session = { ...initialSession(), title: `Agent ${tabs.length + 1}` }
    setSessions((previous) => ({
      ...previous,
      [key]: [...(previous[key] ?? []), session],
    }))
    setSelectedSessions((previous) => ({ ...previous, [key]: session.id }))
  }

  function updateDraft(draft: string) {
    setSessions((previous) => ({
      ...previous,
      [key]: previous[key].map((session) =>
        session.id === current?.id ? { ...session, draft } : session,
      ),
    }))
  }

  async function review() {
    if (!selectedFile) return
    const request = ++reviewRequest.current
    setReviewing(true)
    try {
      const text = await window.desktop.readDiff(workspace, selectedFile)
      if (request !== reviewRequest.current) return
      setDiff(
        text ||
          'Git diff가 없습니다. 새 파일은 git add 이후 내용을 검토할 수 있습니다.',
      )
      reviewDialog.current?.showModal()
    } catch (cause) {
      if (request === reviewRequest.current)
        setError(
          cause instanceof Error
            ? cause.message
            : '변경 내용을 읽지 못했습니다.',
        )
    } finally {
      if (request === reviewRequest.current) setReviewing(false)
    }
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <Code2 size={18} />
          <span>Lite IDE</span>
        </div>
        <Badge variant="outline">Codex</Badge>
      </header>
      <main className="workspace-layout">
        <aside
          className="panel projects-panel"
          aria-label="프로젝트 및 Worktree"
        >
          <div className="panel-heading">
            <h2>
              <FolderOpen size={15} />
              Projects
            </h2>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="프로젝트 열기"
              title="프로젝트 열기"
              onClick={openProject}
              disabled={opening}
            >
              <Plus />
            </Button>
          </div>
          <div className="project-list">
            {projects.map((item) => (
              <Button
                key={item.path}
                variant="ghost"
                size="sm"
                className={`workspace-item ${project?.path === item.path ? 'selected' : ''}`}
                title={item.path}
                aria-pressed={project?.path === item.path}
                onClick={() => {
                  setProject(item)
                  selectWorkspace(item.path)
                }}
              >
                <FolderOpen />
                <span className="truncate-label">{item.name}</span>
                {project?.path === item.path && <ChevronRight />}
              </Button>
            ))}
            {projects.length === 0 && (
              <Button
                variant="outline"
                size="sm"
                className="open-project"
                onClick={openProject}
                disabled={opening}
              >
                <Plus />
                프로젝트 열기
              </Button>
            )}
          </div>
          <Separator className="sidebar-separator" />
          <div className="panel-heading worktree-heading">
            <h2>
              <GitBranch size={15} />
              Worktrees
            </h2>
            <Badge variant="secondary">{repository.worktrees.length}</Badge>
          </div>
          <div className="worktree-list">
            {repository.worktrees.map((tree) => (
              <Button
                key={tree.path}
                title={tree.path}
                variant="ghost"
                size="sm"
                className={`workspace-item ${activeWorktree?.path === tree.path ? 'selected' : ''}`}
                aria-pressed={activeWorktree?.path === tree.path}
                onClick={() => selectWorkspace(tree.path)}
              >
                <GitBranch />
                <span className="truncate-label">{tree.branch}</span>
              </Button>
            ))}
          </div>
        </aside>
        <section className="panel agent-panel" aria-label="Codex 작업">
          <Tabs
            className="agent-tabs"
            value={current?.id ?? ''}
            onValueChange={(value) =>
              setSelectedSessions((previous) => ({
                ...previous,
                [key]: String(value),
              }))
            }
          >
            <div className="session-bar">
              <TabsList
                size="sm"
                className="session-tabs"
                aria-label="작업 세션"
              >
                {tabs.map((session) => (
                  <TabsTab key={session.id} value={session.id}>
                    {session.title}
                  </TabsTab>
                ))}
              </TabsList>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="새 작업 탭"
                title="새 작업 탭"
                onClick={addSession}
              >
                <Plus />
              </Button>
            </div>
            <div className="agent-context">
              <div>
                <Code2 size={16} />
                <strong>Codex</strong>
                <Badge variant="outline">미연결</Badge>
              </div>
              {activeWorktree && (
                <span className="context-branch" title={activeWorktree.branch}>
                  <GitBranch size={12} />
                  <span className="truncate-label">
                    {activeWorktree.branch}
                  </span>
                </span>
              )}
            </div>
            <TabsPanel value={current?.id ?? ''} className="session-content">
              <div className="conversation" />
              {error && (
                <div role="alert" className="error-message">
                  {error}
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="오류 닫기"
                    onClick={() => setError('')}
                  >
                    <X />
                  </Button>
                </div>
              )}
              <div className="composer-area">
                <div className="composer">
                  <Textarea
                    aria-label="Codex에게 보낼 작업 초안"
                    placeholder="Message Codex…"
                    value={current?.draft ?? ''}
                    onChange={(event) => updateDraft(event.target.value)}
                    rows={3}
                    className="message-input"
                  />
                  <div className="composer-toolbar">
                    <span>
                      <Code2 size={13} />
                      Codex
                      {project && (
                        <>
                          <span className="toolbar-divider" />
                          <span className="truncate-label">{project.name}</span>
                        </>
                      )}
                    </span>
                    <Button
                      size="icon-sm"
                      disabled
                      aria-label="Codex 실행 연동 예정"
                      title="Codex 미연결"
                    >
                      <ArrowUp />
                    </Button>
                  </div>
                </div>
              </div>
            </TabsPanel>
          </Tabs>
        </section>
        <aside className="panel changes-panel" aria-label="변경 사항">
          <div className="panel-heading">
            <h2>
              Changes{' '}
              <Badge variant="secondary">{repository.totalChanges}</Badge>
            </h2>
            <Button
              variant="ghost"
              size="icon-sm"
              className={loading ? 'refreshing' : ''}
              aria-label="변경 사항 새로고침"
              title="변경 사항 새로고침"
              disabled={!workspace || loading}
              onClick={() => setRefresh((value) => value + 1)}
            >
              <RefreshCw />
            </Button>
          </div>
          <div className="changes-content">
            {repository.changes.map((file) => (
              <Button
                key={file.path}
                variant="ghost"
                size="sm"
                className={`workspace-item ${selectedFile === file.path ? 'selected' : ''}`}
                title={file.path}
                aria-pressed={selectedFile === file.path}
                onClick={() => setSelectedFile(file.path)}
              >
                <FileCode2 />
                <span className="truncate-label">{file.path}</span>
                <span
                  className={`file-status ${file.status.includes('D') ? 'deleted' : ''}`}
                >
                  {file.status.trim()}
                </span>
              </Button>
            ))}
            {repository.totalChanges > 200 && (
              <span className="file-limit">
                200 / {repository.totalChanges}
              </span>
            )}
            {workspace && !loading && !repository.isGitRepository && (
              <Badge variant="outline">Git 없음</Badge>
            )}
          </div>
          <div className="review-footer">
            <Button
              variant="outline"
              className="review-button"
              disabled={!selectedFile || loading || reviewing}
              onClick={review}
            >
              {reviewing ? '읽는 중…' : 'Review'}
              <ChevronRight />
            </Button>
          </div>
        </aside>
      </main>
      <dialog
        ref={reviewDialog}
        className="diff-dialog"
        aria-labelledby="diff-title"
      >
        <div className="diff-heading">
          <h2 id="diff-title">{selectedFile}</h2>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="검토 닫기"
            onClick={() => reviewDialog.current?.close()}
          >
            <X />
          </Button>
        </div>
        <pre>{diff}</pre>
      </dialog>
    </div>
  )
}
