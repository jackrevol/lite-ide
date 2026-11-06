import { useEffect, useRef, useState } from 'react'
import { FolderOpen, GitBranch, LoaderCircle } from 'lucide-react'
import { Button } from './ui/button'
import type { Project } from '../../../shared/types'

export function ProjectDialog({
  onProject,
  onClose,
}: {
  onProject: (project: Project) => void
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [parent, setParent] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [choosing, setChoosing] = useState(false)
  useEffect(() => {
    dialog.current?.showModal()
    let disposed = false
    void window.desktop
      .defaultCloneDirectory()
      .then((directory) => {
        if (!disposed) setParent((previous) => previous || directory)
      })
      .catch((cause) => {
        if (!disposed) setError(String(cause))
      })
    return () => {
      disposed = true
    }
  }, [])

  async function chooseDirectory() {
    setChoosing(true)
    try {
      const path = await window.desktop.chooseCloneDirectory()
      if (path) setParent(path)
    } catch (cause) {
      setError(String(cause))
    } finally {
      setChoosing(false)
    }
  }
  async function open(clone: boolean) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const project = clone
        ? await window.desktop.cloneProject(url.trim(), parent, name.trim())
        : await window.desktop.openProject()
      if (project) {
        onProject(project)
        onClose()
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <dialog
      ref={dialog}
      className="form-dialog project-dialog"
      aria-labelledby="project-dialog-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy && !choosing) onClose()
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void open(true)
        }}
      >
        <h2 id="project-dialog-title">
          <GitBranch size={16} /> Git 저장소에서 시작
        </h2>
        <p>저장소를 복제하여 프로젝트로 엽니다.</p>
        <label>
          저장소 URL
          <input
            autoFocus
            aria-label="저장소 URL"
            placeholder="https://github.com/owner/repository.git"
            value={url}
            disabled={busy}
            onChange={(event) => {
              const value = event.target.value
              setUrl(value)
              setName(
                value
                  .trim()
                  .replace(/\/$/, '')
                  .split(/[/:]/)
                  .at(-1)
                  ?.replace(/\.git$/, '') ?? '',
              )
            }}
            required
          />
        </label>
        <label>
          프로젝트 폴더 이름
          <input
            aria-label="프로젝트 폴더 이름"
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={busy}
            required
            maxLength={100}
          />
        </label>
        <label>저장 위치</label>
        <button
          type="button"
          className="clone-directory"
          aria-label="저장 위치 변경"
          title="저장 위치 변경"
          disabled={busy || choosing}
          onClick={() => void chooseDirectory()}
        >
          <FolderOpen size={15} />
          <span>{parent || '저장할 폴더 선택'}</span>
          <span className="clone-directory-change">변경</span>
        </button>
        <p className="clone-help">
          HTTPS · SSH 지원. 비공개 저장소는 설정된 Git 인증을 사용합니다.
        </p>
        {error && (
          <p className="clone-error" role="alert">
            {error}
          </p>
        )}
        {busy && (
          <p className="clone-status" role="status">
            <LoaderCircle size={14} className="animate-spin" />
            프로젝트를 여는 중입니다. 저장소 크기에 따라 시간이 걸릴 수
            있습니다.
          </p>
        )}
        <div className="dialog-actions">
          <Button
            type="button"
            variant="ghost"
            disabled={busy || choosing}
            onClick={onClose}
          >
            취소
          </Button>
          <Button
            type="submit"
            disabled={
              busy || choosing || !url.trim() || !name.trim() || !parent
            }
          >
            {busy ? '진행 중…' : '복제하고 열기'}
          </Button>
        </div>
      </form>
      <div className="project-local">
        <span>이미 컴퓨터에 있는 프로젝트</span>
        <Button
          variant="outline"
          disabled={busy || choosing}
          onClick={() => void open(false)}
        >
          <FolderOpen size={14} />
          로컬 폴더 열기
        </Button>
      </div>
    </dialog>
  )
}
