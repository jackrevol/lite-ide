import { useEffect, useRef, useState } from 'react'
import { FolderOpen, GitBranch, LoaderCircle } from 'lucide-react'
import { Button } from './ui/button'
import type { TaskMode } from '../lib/workspace-state'

export function NewTaskDialog({
  mode,
  canCreateWorktree,
  onCreate,
  onClose,
}: {
  mode: TaskMode
  canCreateWorktree: boolean
  onCreate: (mode: TaskMode, branch: string) => Promise<void>
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const creating = useRef(false)
  const [selected, setSelected] = useState<TaskMode>(
    mode === 'worktree' && canCreateWorktree ? 'worktree' : 'local',
  )
  const [branch, setBranch] = useState(
    () =>
      `task/${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`,
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    dialog.current?.showModal()
  }, [])

  function close() {
    dialog.current?.close()
    onClose()
  }

  async function create() {
    if (creating.current) return
    creating.current = true
    setBusy(true)
    setError('')
    try {
      await onCreate(selected, branch.trim())
      close()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      creating.current = false
      setBusy(false)
    }
  }
  return (
    <dialog
      ref={dialog}
      className="form-dialog new-task-dialog"
      aria-labelledby="new-task-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!creating.current) close()
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void create()
        }}
      >
        <h2 id="new-task-title">새 작업</h2>
        <p>작업 위치를 선택하세요. 다음에도 이 선택을 기억합니다.</p>
        <fieldset className="task-mode-options" disabled={busy}>
          <legend className="sr-only">작업 위치</legend>
          <label>
            <input
              type="radio"
              name="task-mode"
              value="local"
              checked={selected === 'local'}
              onChange={() => setSelected('local')}
            />
            <FolderOpen size={18} />
            <span>
              <strong>로컬</strong>
              <small>프로젝트 폴더에서 바로 작업합니다.</small>
            </span>
          </label>
          <label>
            <input
              type="radio"
              name="task-mode"
              value="worktree"
              checked={selected === 'worktree'}
              disabled={!canCreateWorktree}
              onChange={() => setSelected('worktree')}
            />
            <GitBranch size={18} />
            <span>
              <strong>Worktree</strong>
              <small>
                {canCreateWorktree
                  ? '새 브랜치와 별도 폴더에서 작업합니다.'
                  : 'Git 프로젝트를 열면 사용할 수 있습니다.'}
              </small>
            </span>
          </label>
        </fieldset>
        {selected === 'worktree' && (
          <label className="task-branch">
            브랜치 이름
            <input
              aria-label="작업 브랜치 이름"
              value={branch}
              onChange={(event) => setBranch(event.target.value)}
              disabled={busy}
              required
            />
          </label>
        )}
        {error && (
          <p role="alert" className="update-error">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <Button
            type="button"
            variant="ghost"
            onClick={close}
            disabled={busy}
          >
            취소
          </Button>
          <Button
            type="submit"
            disabled={busy || (selected === 'worktree' && !branch.trim())}
          >
            {busy && <LoaderCircle size={14} className="animate-spin" />}
            {busy ? '생성 중…' : '작업 만들기'}
          </Button>
        </div>
      </form>
    </dialog>
  )
}
