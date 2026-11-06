import { useEffect, useRef, useState } from 'react'
import type { CodexStatus, Project, Worktree } from '../../../shared/types'
import {
  createSession,
  type Session,
  type TaskMode,
} from '../lib/workspace-state'
import { Button } from './ui/button'

export function NewTaskDialog({
  project,
  worktrees,
  connection,
  initialModel,
  initialEffort,
  initialBaseRef,
  branches,
  onCreate,
  onClose,
}: {
  project: Project
  worktrees: Worktree[]
  connection: CodexStatus
  initialModel: string
  initialEffort: string
  initialMode: TaskMode
  initialBaseRef: string
  branches: string[]
  onCreate: (
    workspace: string,
    session: Session,
    mode: TaskMode,
  ) => Promise<void>
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [branch, setBranch] = useState(
    () =>
      `task/${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`,
  )
  const [model, setModel] = useState(initialModel)
  const [effort, setEffort] = useState(initialEffort)
  const [baseRef, setBaseRef] = useState(initialBaseRef)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const created = useRef<{ workspace: string; session: Session } | null>(null)
  const submitting = useRef(false)
  const selectedModel = connection.models.find((item) => item.id === model)
  const invalidModel = !!model && !selectedModel
  const invalidEffort =
    !!effort && !!selectedModel && !selectedModel.efforts.includes(effort)
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  useEffect(() => {
    if (created.current) return
    if (model && !connection.models.some((item) => item.id === model)) return
    const selected =
      connection.models.find((item) => item.id === model) ??
      connection.models.find((item) => item.isDefault) ??
      connection.models[0]
    if (!selected) return
    if (selected.id !== model) setModel(selected.id)
    if (!effort && selected.efforts.includes(selected.defaultEffort))
      setEffort(selected.defaultEffort)
  }, [connection.models, model, effort])
  async function submit() {
    if (submitting.current) return
    submitting.current = true
    setPending(true)
    setError('')
    try {
      if (!created.current) {
        const tree = await window.desktop.createWorktree(
          project.path,
          branch.trim(),
          baseRef,
        )
        const target = tree.path
        created.current = {
          workspace: target,
          session: {
            ...createSession(),
            project: project.path,
            branch: tree.branch,
            title: name.trim() || '새 작업',
            customTitle: !!name.trim(),
            draft: prompt,
            model,
            effort,
          },
        }
      }
      await onCreate(
        created.current.workspace,
        created.current.session,
        'worktree',
      )
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
          <p>작업마다 새 Worktree를 생성합니다.</p>
          <label>
            기준 브랜치
            <select
              aria-label="이번 작업 기준 브랜치"
              value={baseRef}
              onChange={(event) => setBaseRef(event.target.value)}
            >
              <option value="HEAD">현재 HEAD (기본)</option>
              {baseRef !== 'HEAD' && !branches.includes(baseRef) && (
                <option value={baseRef}>{baseRef} (현재 확인 불가)</option>
              )}
              {branches.map((ref) => (
                <option value={ref} key={ref}>
                  {ref.replace(/^refs\/(heads|remotes)\//, '')}
                </option>
              ))}
            </select>
          </label>
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
                {invalidModel && (
                  <option value={model}>{model} (현재 사용 불가)</option>
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
                disabled={
                  !selectedModel ||
                  (!selectedModel.efforts.length && !invalidEffort)
                }
                onChange={(event) => setEffort(event.target.value)}
              >
                {!selectedModel?.efforts.length && (
                  <option value="">기본값</option>
                )}
                {invalidEffort && (
                  <option value={effort}>{effort} (현재 사용 불가)</option>
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
        {(invalidModel || invalidEffort) && (
          <p role="alert">
            프로젝트 기본 모델 또는 추론 수준을 현재 사용할 수 없습니다. 연결을
            확인하거나 이번 작업에 사용할 값을 선택해 주세요.
          </p>
        )}
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
              invalidModel ||
              invalidEffort ||
              (!branch.trim() || !worktrees.length || (baseRef !== 'HEAD' && !branches.includes(baseRef))) ||
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
