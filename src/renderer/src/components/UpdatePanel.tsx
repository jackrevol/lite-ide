import { useEffect, useState } from 'react'
import { Download, RefreshCw } from 'lucide-react'
import type { AppUpdateState } from '../../../shared/types'
import { Button } from './ui/button'

export function useAppUpdate() {
  const [state, setState] = useState<AppUpdateState>({
    status: 'idle',
    currentVersion: '',
    canInstall: false,
  })
  const pending = ['checking', 'downloading', 'installing'].includes(
    state.status,
  )
  const available = ['available', 'downloading', 'downloaded'].includes(
    state.status,
  )
  useEffect(() => {
    let disposed = false
    const unsubscribe = window.desktop.onUpdate((next) => {
      if (!disposed) setState(next)
    })
    void window.desktop.updateStatus().then((next) => {
      if (!disposed) setState(next)
    })
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])
  async function action(run: () => Promise<AppUpdateState>) {
    try {
      setState(await run())
    } catch (error) {
      setState((previous) => ({
        ...previous,
        status: 'error',
        error: String(error),
      }))
    }
  }
  return { state, pending, available, action }
}

export function UpdatePanel({ onClose }: { onClose?: () => void }) {
  const { state, pending, action } = useAppUpdate()
  const descriptions = {
    idle: 'GitHub에서 새 버전을 확인할 수 있습니다.',
    checking: '최신 릴리스를 확인하고 있습니다.',
    current: '사용 가능한 새 업데이트가 없습니다.',
    available: '새 버전을 다운로드할 수 있습니다.',
    downloading: '설치 파일을 다운로드하고 있습니다.',
    downloaded: '다운로드와 무결성 검증이 완료되었습니다.',
    installing: '설치 파일을 열고 있습니다.',
    error: '업데이트를 완료하지 못했습니다.',
  }
  return (
    <>
      <p className="update-version">
        현재 버전 {state.currentVersion || '확인 중'}
        {state.version && <> → 새 버전 {state.version}</>}
      </p>
      <p role="status">{descriptions[state.status]}</p>
      {state.status === 'downloading' && (
        <progress
          max={100}
          value={state.progress ?? 0}
          aria-label="업데이트 다운로드 진행률"
        />
      )}
      {state.error && (
        <p className="update-error" role="alert">
          {state.error}
        </p>
      )}
      {state.status === 'downloaded' && (
        <p>
          {!state.canInstall
            ? '개발 실행에서는 설치를 실행할 수 없습니다. 설치된 앱에서 이용해 주세요.'
            : window.desktop.platform === 'darwin'
              ? 'DMG를 열고 앱을 Applications 폴더로 옮겨 교체해 주세요. 교체 전에 Lite IDE를 종료해 주세요.'
              : '설치 프로그램을 열면 Lite IDE가 종료됩니다. 설치 화면의 안내에 따라 업데이트해 주세요.'}
        </p>
      )}
      <div className="dialog-actions">
        {onClose && (
          <Button variant="ghost" onClick={onClose}>
            닫기
          </Button>
        )}
        {state.status === 'downloading' ? (
          <Button
            variant="outline"
            onClick={() => void window.desktop.cancelUpdateDownload()}
          >
            다운로드 취소
          </Button>
        ) : state.status === 'downloaded' ? (
          <Button
            disabled={!state.canInstall}
            onClick={() => void action(window.desktop.installUpdate)}
          >
            {window.desktop.platform === 'darwin'
              ? 'DMG 열기'
              : '종료하고 설치'}
          </Button>
        ) : state.status === 'available' ? (
          <Button onClick={() => void action(window.desktop.downloadUpdate)}>
            <Download size={14} />
            다운로드
          </Button>
        ) : (
          <Button
            disabled={pending}
            onClick={() => void action(window.desktop.checkUpdate)}
          >
            <RefreshCw size={14} />
            업데이트 확인
          </Button>
        )}
      </div>
    </>
  )
}
