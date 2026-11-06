import { useRef } from 'react'
import { Download, LoaderCircle } from 'lucide-react'
import { UpdatePanel, useAppUpdate } from './UpdatePanel'

export function AppUpdateButton() {
  const { state, pending, available } = useAppUpdate()
  const dialog = useRef<HTMLDialogElement>(null)
  return (
    <>
      <button
        className={`titlebar-update${available ? ' update-available' : ''}`}
        aria-label="앱 업데이트"
        title={
          available ? `Lite IDE ${state.version} 업데이트` : '앱 업데이트 확인'
        }
        onClick={() => dialog.current?.showModal()}
      >
        {pending ? (
          <LoaderCircle size={14} className="animate-spin" />
        ) : (
          <Download size={14} />
        )}
        <span>
          {state.status === 'downloading'
            ? `${state.progress ?? 0}%`
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
        <UpdatePanel onClose={() => dialog.current?.close()} />
      </dialog>
    </>
  )
}
