import { useRef } from 'react'
import { Download, LoaderCircle } from 'lucide-react'
import { UpdatePanel, useAppUpdate } from './UpdatePanel'

export function AppUpdateButton() {
  const { state, pending, available, action } = useAppUpdate()
  const dialog = useRef<HTMLDialogElement>(null)
  const requesting = useRef(false)
  async function start() {
    dialog.current?.showModal()
    if (pending || requesting.current) return
    requesting.current = true
    try {
      await action(window.desktop.startUpdate)
    } finally {
      requesting.current = false
    }
  }
  if (!available) return null
  return (
    <>
      <button
        className={`titlebar-update${available ? ' update-available' : ''}`}
        aria-label="앱 업데이트"
        title={`Lite IDE ${state.version} 다운로드 후 종료하고 설치`}
        onClick={() => void start()}
      >
        {pending ? (
          <LoaderCircle size={14} className="animate-spin" />
        ) : (
          <Download size={14} />
        )}
        <span>
          {state.status === 'downloading'
            ? `${state.progress ?? 0}%`
            : state.status === 'installing'
              ? '설치 중…'
              : '업데이트'}
        </span>
        {available && state.status !== 'downloading' && (
          <span className="update-dot" />
        )}
      </button>
      <dialog
        ref={dialog}
        className="form-dialog update-dialog"
        aria-labelledby="update-title"
      >
        <h2 id="update-title">앱 업데이트</h2>
        <UpdatePanel
          automatic
          onStart={start}
          onClose={() => dialog.current?.close()}
        />
      </dialog>
    </>
  )
}
