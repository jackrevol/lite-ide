import { useState } from 'react'
import { LoaderCircle, Play, Square } from 'lucide-react'
import type { StartupSnapshot } from '../../../shared/types'

export function StartupPanel({ workspace, project, snapshot, blocked, onSnapshot, onRun, onError }: {
  workspace: string
  project: string
  snapshot: StartupSnapshot | null
  blocked: boolean
  onSnapshot: (snapshot: StartupSnapshot) => void
  onRun: () => void
  onError: (error: string) => void
}) {
  const [pending, setPending] = useState(false)
  const run = async () => {
    onRun()
    setPending(true)
    try {
      const result = await window.desktop.runStartup(project, workspace)
      if (result) onSnapshot(result)
      else onError('프로젝트 설정에서 Startup 스크립트를 입력하고 저장해 주세요.')
    } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setPending(false) }
  }
  const running = snapshot?.status === 'running'
  const status = !snapshot ? '설정한 스크립트 실행' : running ? '실행 중' : snapshot.status === 'completed' ? '완료' : snapshot.status === 'stopped' ? '중지됨' : '실패'
  return <section className={`startup-panel ${blocked ? 'startup-blocked' : ''}`} aria-label="Startup 스크립트">
    <div className="startup-heading">
      <div className="startup-title">
        {running && <LoaderCircle size={12} className="spinning" />}
        <span>Startup · {status}{snapshot?.exitCode !== undefined ? ` (${snapshot.exitCode})` : ''}</span>
      </div>
      {running ? <button aria-label="Startup 중지" disabled={pending} onClick={() => {
        setPending(true)
        void window.desktop.stopStartup(workspace).catch((cause) => onError(String(cause))).finally(() => setPending(false))
      }}><Square size={12} /> 중지</button> : <button aria-label="Startup 실행" disabled={pending} onClick={() => void run()}><Play size={12} />{pending ? '시작 중…' : snapshot ? '다시 실행' : '실행'}</button>}
    </div>
    <div className="startup-details">
      {blocked && <p role="status">{running ? 'Worktree 초기화 중입니다. 성공적으로 완료되면 에이전트를 시작합니다.' : '초기화가 완료되지 않아 에이전트를 시작하지 않았습니다. 설정을 확인하고 다시 실행해 주세요.'}</p>}
      {snapshot?.error && <p role="alert">{snapshot.error}</p>}
      <pre aria-label="Startup 로그">{snapshot?.output || '출력이 없습니다.'}</pre>
      <small>작업 폴더: {workspace}</small>
    </div>
  </section>
}
