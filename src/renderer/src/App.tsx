import { useEffect, useRef, useState } from 'react'
import {
  ArrowUp,
  Check,
  ChevronRight,
  Code2,
  FileCode2,
  FolderOpen,
  GitBranch,
  Plus,
  RefreshCw,
  X,
} from 'lucide-react'
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
          <span className="brand-icon">
            <Code2 size={16} />
          </span>
          <span>Lite IDE</span>
          <span className="version">0.1</span>
        </div>
        <div className="header-caption">A little space to build.</div>
        <span className="provider-badge">
          <span className="provider-dot" />
          Codex
        </span>
      </header>

      <main className="workspace-layout">
        <aside
          className="panel projects-panel"
          aria-label="프로젝트 및 Worktree"
        >
          <div className="panel-heading">
            <h2>
              <FolderOpen size={16} />
              Projects
            </h2>
            <button
              className="icon-button"
              aria-label="프로젝트 열기"
              title="프로젝트 열기"
              onClick={openProject}
              disabled={opening}
            >
              <Plus size={16} />
            </button>
          </div>
          <div className="project-list">
            {projects.map((item) => (
              <button
                key={item.path}
                className={`project-item ${project?.path === item.path ? 'selected' : ''}`}
                title={item.path}
                onClick={() => {
                  setProject(item)
                  selectWorkspace(item.path)
                }}
              >
                <FolderOpen size={15} />
                <span>{item.name}</span>
                {project?.path === item.path && <ChevronRight size={14} />}
              </button>
            ))}
            {projects.length === 0 && (
              <div className="sidebar-empty">
                <p>아직 열린 프로젝트가 없습니다.</p>
                <button
                  className="text-button"
                  onClick={openProject}
                  disabled={opening}
                >
                  폴더 열기 <span>↗</span>
                </button>
              </div>
            )}
          </div>
          <div className="section-divider" />
          <div className="worktree-heading">
            <h2>
              <GitBranch size={15} />
              Worktrees
            </h2>
            <span className="count">{repository.worktrees.length}</span>
          </div>
          <div className="worktree-list">
            {repository.worktrees.map((tree) => (
              <button
                key={tree.path}
                title={tree.path}
                className={`worktree-item ${activeWorktree?.path === tree.path ? 'selected' : ''}`}
                onClick={() => selectWorkspace(tree.path)}
              >
                <GitBranch size={13} />
                <span>{tree.branch}</span>
                {activeWorktree?.path === tree.path && (
                  <span className="active-dot" />
                )}
              </button>
            ))}
            {repository.worktrees.length === 0 && (
              <p className="muted sidebar-help">
                {loading
                  ? '작업 공간을 확인하고 있습니다…'
                  : project
                    ? 'Git 저장소를 열면 Worktree가 표시됩니다.'
                    : '프로젝트의 작업 공간이 여기에 표시됩니다.'}
              </p>
            )}
          </div>
          <div className="sidebar-footer">
            <span className="local-dot" />
            Local workspace
          </div>
        </aside>

        <section className="panel agent-panel" aria-label="Codex 작업">
          <div className="session-bar">
            <div className="session-tabs" role="tablist" aria-label="작업 세션">
              {tabs.map((session) => (
                <button
                  key={session.id}
                  id={`tab-${session.id}`}
                  role="tab"
                  aria-selected={current?.id === session.id}
                  aria-controls="agent-session"
                  className={`session-tab ${current?.id === session.id ? 'active' : ''}`}
                  onClick={() =>
                    setSelectedSessions((previous) => ({
                      ...previous,
                      [key]: session.id,
                    }))
                  }
                >
                  <span className="tab-dot" />
                  {session.title}
                </button>
              ))}
            </div>
            <button
              className="icon-button"
              aria-label="새 작업 탭"
              title="새 작업 탭"
              onClick={addSession}
            >
              <Plus size={15} />
            </button>
          </div>

          <div className="agent-context">
            <div>
              <span className="codex-symbol">
                <Code2 size={17} />
              </span>
              <strong>Codex</strong>
              <span className="status-pill">연결 예정</span>
            </div>
            <span className="context-branch">
              {activeWorktree ? (
                <>
                  <GitBranch size={12} />
                  {activeWorktree.branch}
                </>
              ) : (
                '새 작업 공간'
              )}
            </span>
          </div>

          <div
            id="agent-session"
            role="tabpanel"
            aria-labelledby={current ? `tab-${current.id}` : undefined}
            className="conversation"
          >
            <div className="welcome">
              <span className="welcome-icon">
                <Code2 size={27} strokeWidth={1.4} />
              </span>
              <p className="eyebrow">YOUR NEXT COMMIT STARTS HERE</p>
              <h1>
                {project
                  ? '어떤 작업을 시작할까요?'
                  : '작게 시작하고, 하나씩 완성하세요.'}
              </h1>
              <p>
                {project
                  ? `${project.name}에서 작업할 준비가 되었습니다.`
                  : '프로젝트를 열고 Codex와 함께할 작업을 준비하세요.'}
                <br />
                코드와 대화, 변경 사항을 한곳에서 확인합니다.
              </p>
              {!project && (
                <button
                  className="primary-button"
                  onClick={openProject}
                  disabled={opening}
                >
                  <FolderOpen size={15} />
                  프로젝트 열기
                </button>
              )}
            </div>
          </div>
          {error && (
            <div role="alert" className="error-message">
              {error}
              <button
                className="icon-button"
                aria-label="오류 닫기"
                onClick={() => setError('')}
              >
                <X size={14} />
              </button>
            </div>
          )}
          <div className="composer-area">
            <div className="composer">
              <textarea
                aria-label="Codex에게 보낼 작업 초안"
                placeholder="Codex에게 맡길 작업을 적어보세요…"
                value={current?.draft ?? ''}
                onChange={(event) => updateDraft(event.target.value)}
                rows={3}
              />
              <div className="composer-toolbar">
                <span>
                  <Code2 size={13} />
                  Codex
                  <span className="toolbar-divider" />
                  {project?.name ?? '프로젝트를 선택하세요'}
                </span>
                <button
                  className="send-button"
                  disabled
                  aria-label="Codex 실행 연동 예정"
                  title="Codex CLI 실행은 다음 단계에서 연결합니다"
                >
                  <ArrowUp size={17} />
                </button>
              </div>
            </div>
            <p className="composer-note">
              초안을 작성할 수 있습니다. Codex CLI 실행 연동은 준비 중입니다.
            </p>
          </div>
        </section>

        <aside className="panel changes-panel" aria-label="변경 사항">
          <div className="panel-heading">
            <h2>
              Changes <span className="count">{repository.totalChanges}</span>
            </h2>
            <button
              className={`icon-button ${loading ? 'refreshing' : ''}`}
              aria-label="변경 사항 새로고침"
              title="변경 사항 새로고침"
              disabled={!workspace || loading}
              onClick={() => setRefresh((value) => value + 1)}
            >
              <RefreshCw size={14} />
            </button>
          </div>
          <div className="changes-content">
            {repository.changes.length > 0 ? (
              <>
                <p className="section-label">WORKING TREE</p>
                <div className="change-list">
                  {repository.changes.map((file) => (
                    <button
                      key={file.path}
                      className={`change-item ${selectedFile === file.path ? 'selected' : ''}`}
                      title={file.path}
                      onClick={() => setSelectedFile(file.path)}
                    >
                      <FileCode2 size={14} />
                      <span>{file.path}</span>
                      <span
                        className={
                          file.status.includes('D')
                            ? 'file-status deleted'
                            : 'file-status'
                        }
                      >
                        {file.status.trim()}
                      </span>
                    </button>
                  ))}
                </div>
                {repository.totalChanges > 200 && (
                  <p className="muted sidebar-help">
                    처음 200개 파일을 표시합니다.
                  </p>
                )}
              </>
            ) : (
              <div className="changes-empty">
                <span className="empty-check">
                  <Check size={18} strokeWidth={1.5} />
                </span>
                <p>
                  {loading
                    ? '변경 사항 확인 중'
                    : workspace
                      ? repository.isGitRepository
                        ? '작업 공간이 깨끗합니다'
                        : 'Git 저장소를 열어주세요'
                      : '변경 사항을 기다리고 있습니다'}
                </p>
                <span>
                  {workspace
                    ? '파일을 수정한 후 새로고침하세요.'
                    : '프로젝트를 열면 변경 파일이 표시됩니다.'}
                </span>
              </div>
            )}
          </div>
          <div className="review-footer">
            <p>
              {repository.totalChanges
                ? `${repository.totalChanges}개의 변경 파일`
                : '작은 변경부터 차근차근.'}
            </p>
            <button
              className="review-button"
              disabled={!selectedFile || loading || reviewing}
              onClick={review}
            >
              {reviewing ? '읽는 중…' : 'Review'}
              <ChevronRight size={14} />
            </button>
          </div>
        </aside>
      </main>
      <footer className="app-footer">
        <span>작업에 필요한 것만, 가볍게.</span>
        <span>
          LOCAL FIRST<span className="footer-separator">/</span>CODEX ONLY
        </span>
      </footer>
      <dialog ref={reviewDialog} className="diff-dialog">
        <div className="diff-heading">
          <h2>{selectedFile}</h2>
          <button
            className="icon-button"
            aria-label="검토 닫기"
            onClick={() => reviewDialog.current?.close()}
          >
            <X size={18} />
          </button>
        </div>
        <pre>{diff}</pre>
      </dialog>
    </div>
  )
}
