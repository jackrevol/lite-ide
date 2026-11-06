import { useEffect, useRef, useState } from 'react'
import type { CodexStatus, Project, Worktree } from '../../../shared/types'
import { createSession, type Session } from '../lib/workspace-state'
import { Button } from './ui/button'

export function NewTaskDialog({
  project,
  worktrees,
  connection,
  initialModel,
  initialEffort,
  onCreate,
  onClose,
}: {
  project: Project
  worktrees: Worktree[]
  connection: CodexStatus
  initialModel: string
  initialEffort: string
  onCreate: (workspace: string, session: Session) => Promise<void>
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [mode, setMode] = useState(worktrees.length ? 'new' : 'existing')
  const [workspace, setWorkspace] = useState(project.path)
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [branch, setBranch] = useState(
    () =>
      `task/${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`,
  )
  const [model, setModel] = useState(initialModel)
  const [effort, setEffort] = useState(initialEffort)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const created = useRef<{ workspace: string; session: Session } | null>(null)
  const submitting = useRef(false)
  const selectedModel = connection.models.find((item) => item.id === model)
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  useEffect(() => {
    if (created.current) return
    const selected =
      connection.models.find((item) => item.id === model) ??
      connection.models.find((item) => item.isDefault) ??
      connection.models[0]
    if (!selected) return
    if (selected.id !== model) setModel(selected.id)
    if (!selected.efforts.includes(effort)) setEffort(selected.defaultEffort)
  }, [connection.models, model, effort])
  async function submit() {
    if (submitting.current) return
    submitting.current = true
    setPending(true)
    setError('')
    try {
      if (!created.current) {
        const target =
          mode === 'new'
            ? (await window.desktop.createWorktree(project.path, branch.trim()))
                .path
            : workspace
        created.current = {
          workspace: target,
          session: {
            ...createSession(),
            title: name.trim() || '새 작업',
            customTitle: !!name.trim(),
            draft: prompt,
            model,
            effort,
          },
        }
      }
      await onCreate(created.current.workspace, created.current.session)
      onClose()
    } catch (cause) {
      setError(
        `${created.current ? '작업 공간과 입력 내용을 보존했습니다. 다시 시도하면 같은 작업에서 시작합니다. ' : ''}${cause instanceof Error ? cause.message : String(cause)}`,
      )
    } finally {
      submitting.current = false
      setPending(false)
    }
  }
  return (
    <dialog
      ref={dialog}
      className="form-dialog new-task-dialog"
      aria-labelledby="new-task-title"
      onCancel={(event) => {
        if (pending) event.preventDefault()
        else onClose()
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <h2 id="new-task-title">새 작업</h2>
        <p title={project.path}>{project.name}에서 작업을 시작합니다.</p>
        <fieldset disabled={pending || !!created.current}>
          <label>
            작업 공간
            <select
              aria-label="작업 공간 방식"
              value={mode}
              onChange={(event) => setMode(event.target.value)}
            >
              <option value="new" disabled={!worktrees.length}>
                새 Worktree (기본)
              </option>
              <option value="existing">기존 작업 공간</option>
            </select>
          </label>
          {mode === 'new' ? (
            <label>
              새 브랜치 이름
              <input
                aria-label="새 브랜치 이름"
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
                required
                maxLength={100}
              />
            </label>
          ) : (
            <label>
              기존 작업 공간
              <select
                aria-label="기존 작업 공간"
                value={workspace}
                onChange={(event) => setWorkspace(event.target.value)}
              >
                {(worktrees.length
                  ? worktrees
                  : [{ path: project.path, branch: '로컬 작업 공간' }]
                ).map((tree) => (
                  <option key={tree.path} value={tree.path}>
                    {tree.branch} · {tree.path}
                  </option>
                ))}
              </select>
            </label>
          )}
          {mode === 'new' && !worktrees.length && (
            <p>
              Git 저장소에서 새 Worktree를 만들 수 있습니다. 기존 작업 공간을
              선택해 주세요.
            </p>
          )}
          <label>
            작업 이름
            <input
              aria-label="새 작업 이름"
              placeholder="선택 사항"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={100}
            />
          </label>
          <label>
            첫 요청
            <textarea
              aria-label="첫 요청"
              placeholder="Codex에게 요청할 내용을 입력하세요. 비워 두면 초안으로 만듭니다."
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={4}
            />
          </label>
          <div className="task-model-fields">
            <label>
              모델
              <select
                aria-label="새 작업 모델"
                value={model}
                disabled={!connection.models.length}
                onChange={(event) => {
                  const next = connection.models.find(
                    (item) => item.id === event.target.value,
                  )
                  setModel(event.target.value)
                  setEffort(next?.defaultEffort ?? '')
                }}
              >
                {!connection.models.length && (
                  <option value="">연결 후 선택</option>
                )}
                {connection.models.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              추론 수준
              <select
                aria-label="새 작업 추론 수준"
                value={effort}
                disabled={!selectedModel?.efforts.length}
                onChange={(event) => setEffort(event.target.value)}
              >
                {!selectedModel?.efforts.length && (
                  <option value="">기본값</option>
                )}
                {selectedModel?.efforts.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </fieldset>
        {error && <p role="alert">{error}</p>}
        {prompt.trim() &&
          (!connection.connected || !connection.authenticated) && (
            <p>Codex 연결과 로그인을 완료한 후 요청을 시작할 수 있습니다.</p>
          )}
        <div className="dialog-actions">
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={onClose}
          >
            {created.current ? '닫기' : '취소'}
          </Button>
          <Button
            type="submit"
            disabled={
              pending ||
              (mode === 'new' && (!branch.trim() || !worktrees.length)) ||
              (!!prompt.trim() &&
                (!connection.connected || !connection.authenticated))
            }
          >
            {pending
              ? '시작 중…'
              : created.current
                ? '다시 시도'
                : prompt.trim()
                  ? '만들고 시작'
                  : '만들기'}
          </Button>
        </div>
      </form>
    </dialog>
  )
}
