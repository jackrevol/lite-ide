import { useEffect, useRef, useState } from 'react'
import { Button } from './ui/button'

export function SettingsDialog({
  defaultBaseBranch,
  onSave,
  onClose,
}: {
  defaultBaseBranch: string
  onSave: (branch: string) => void
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [branch, setBranch] = useState(defaultBaseBranch)
  const [error, setError] = useState('')
  useEffect(() => {
    dialog.current?.showModal()
  }, [])

  return (
    <dialog
      ref={dialog}
      className="form-dialog branch-dialog"
      aria-labelledby="settings-title"
      onCancel={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          try {
            onSave(branch.trim())
            onClose()
          } catch {
            setError('설정을 저장하지 못했습니다. 로컬 저장 공간을 확인해 주세요.')
          }
        }}
      >
        <h2 id="settings-title">설정</h2>
        <label>
          Worktree 기본 기준 브랜치
          <input
            autoFocus
            placeholder="예: main, develop, origin/main"
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
          />
        </label>
        <p className="branch-help">
          모든 프로젝트에 적용됩니다. 비워 두면 현재 프로젝트 브랜치(HEAD)를
          사용합니다. 생성할 때마다 다른 브랜치를 선택할 수 있습니다.
        </p>
        {error && (
          <p role="alert" className="branch-error">{error}</p>
        )}
        <div className="dialog-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            취소
          </Button>
          <Button type="submit">저장</Button>
        </div>
      </form>
    </dialog>
  )
}
