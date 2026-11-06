import { useEffect, useRef, useState } from 'react'
import type { Project, RepositoryBranch, Worktree } from '../../../shared/types'
import { Button } from './ui/button'

export function WorktreeDialog({
  project,
  defaultBaseBranch,
  onCreated,
  onClose,
}: {
  project: Project
  defaultBaseBranch: string
  onCreated: (tree: Worktree) => void
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [branch, setBranch] = useState(
    () => `task/${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`,
  )
  const [branches, setBranches] = useState<RepositoryBranch[]>([])
  const [baseBranch, setBaseBranch] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [missingDefault, setMissingDefault] = useState(false)
  const [refresh, setRefresh] = useState(0)

  useEffect(() => {
    dialog.current?.showModal()
    let disposed = false
    setLoading(true)
    setError('')
    void window.desktop
      .listBranches(project.path)
      .then((items) => {
        if (disposed) return
        const preferred = items.find((item) => item.name === defaultBaseBranch)
        setBranches(items)
        setBaseBranch(defaultBaseBranch ? preferred?.ref ?? '' : 'HEAD')
        setMissingDefault(Boolean(defaultBaseBranch && !preferred))
      })
      .catch((cause) => {
        if (!disposed) {
          setBranches([])
          setBaseBranch('')
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      })
      .finally(() => {
        if (!disposed) setLoading(false)
      })
    return () => {
      disposed = true
    }
  }, [project.path, defaultBaseBranch, refresh])

  async function create() {
    if (busy || loading || !branch.trim() || !baseBranch) return
    setBusy(true)
    setError('')
    try {
      const created = await window.desktop.createWorktree(
        project.path,
        branch.trim(),
        baseBranch,
      )
      onCreated(created)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <dialog
      ref={dialog}
      className="form-dialog branch-dialog"
      aria-labelledby="tree-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void create()
        }}
      >
        <h2 id="tree-title">새 작업</h2>
        <p>
          {project.name}에서 작업 전용 Worktree와 새 브랜치를 만듭니다.
        </p>
        <label>
          새 브랜치 이름
          <input
            autoFocus
            placeholder="feature/my-task"
            value={branch}
            maxLength={100}
            disabled={busy}
            onChange={(event) => setBranch(event.target.value)}
            required
          />
        </label>
        <label>
          기준 브랜치
          <select
            value={baseBranch}
            disabled={loading || busy}
            onChange={(event) => setBaseBranch(event.target.value)}
            required
          >
            <option value="" disabled>
              {loading ? '브랜치 불러오는 중…' : '기준 브랜치를 선택해 주세요'}
            </option>
            <option value="HEAD">현재 프로젝트 브랜치 (HEAD)</option>
            <optgroup label="로컬 브랜치">
              {branches
                .filter((item) => item.ref.startsWith('refs/heads/'))
                .map((item) => (
                  <option key={item.ref} value={item.ref}>{item.name}</option>
                ))}
            </optgroup>
            <optgroup label="원격 브랜치">
              {branches
                .filter((item) => item.ref.startsWith('refs/remotes/'))
                .map((item) => (
                  <option key={item.ref} value={item.ref}>{item.name}</option>
                ))}
            </optgroup>
          </select>
        </label>
        {missingDefault && (
          <p className="branch-help" role="status">
            기본 기준 브랜치 “{defaultBaseBranch}”가 이 프로젝트에 없습니다.
            기준 브랜치를 선택해 주세요.
          </p>
        )}
        <p className="branch-help">원격 브랜치는 로컬에 저장된 상태를 사용합니다.</p>
        {error && (
          <>
            <p className="branch-error" role="alert">{error}</p>
            <Button
              type="button"
              variant="ghost"
              disabled={loading || busy}
              onClick={() => setRefresh((value) => value + 1)}
            >
              브랜치 새로고침
            </Button>
          </>
        )}
        <div className="dialog-actions">
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
            취소
          </Button>
          <Button type="submit" disabled={!branch.trim() || !baseBranch || loading || busy}>
            {busy ? '생성 중…' : '만들기'}
          </Button>
        </div>
      </form>
    </dialog>
  )
}
