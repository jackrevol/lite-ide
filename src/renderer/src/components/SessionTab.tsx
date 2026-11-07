import { useState, type Dispatch, type SetStateAction } from 'react'
import { RefreshCw, Square } from 'lucide-react'
import type { AgentSession } from '../../../shared/types'
import { Conversation } from './Conversation'
import { Button } from './ui/button'

const labels = { idle: '대기', running: '실행 중', waiting: '응답 대기', completed: '완료', interrupted: '중단', failed: '실패' }

export function SessionTab({ session, draft, setDraft, requestDrafts, setRequestDrafts }: { session: AgentSession; draft: string; setDraft: Dispatch<SetStateAction<string>>; requestDrafts: Record<string, Record<string, string>>; setRequestDrafts: Dispatch<SetStateAction<Record<string, Record<string, string>>>> }) {
  const [pending, setPending] = useState('')
  const [error, setError] = useState('')
  const active = session.status === 'running' || session.status === 'waiting'
  const canControl = session.canAcceptDirectInput !== false && !session.closed
  async function perform(action: string, run: () => Promise<void>) {
    if (pending) return
    setPending(action)
    setError('')
    try { await run() } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally { setPending('') }
  }
  return (
    <div className="session-tab-view">
      <div className="session-tab-meta">
        <span className={`status-label ${session.status}`}>{session.closed ? '종료됨' : labels[session.status]}</span>
        <span>{[session.nickname, session.role, session.model].filter(Boolean).join(' · ') || 'Codex 세션'}</span>
        {(session.parentSessionId || session.canAcceptDirectInput === false) && <Button variant="ghost" size="xs" disabled={!!pending} onClick={() => void perform('refresh', () => window.desktop.inspectSubagent(session.id))}>
          <RefreshCw size={12} className={pending === 'refresh' ? 'spinning' : ''} />활동 새로고침
        </Button>}
        {active && canControl && <Button variant="outline" size="xs" disabled={!!pending} onClick={() => void perform('stop', () => window.desktop.interruptSession(session.id))}><Square size={12} />작업 중단</Button>}
      </div>
      {session.task && <p className="session-tab-task">{session.task}</p>}
      {(error || session.observationError) && <p className="error-message" role="alert">{error || session.observationError}</p>}
      {session.messages.length || session.requests.length ? <Conversation session={session} requestDrafts={requestDrafts} setRequestDrafts={setRequestDrafts} /> : <p className="session-tab-empty">아직 기록된 활동이 없습니다. 활동을 수신하면 여기에 표시됩니다.</p>}
      {!canControl ? <p className="session-tab-note">{session.closed ? '종료된 세션의 활동 기록입니다.' : 'CLI 세션을 읽기 전용으로 관찰합니다. 지시는 해당 작업의 터미널에서 전달해 주세요.'}</p> : (
        <form className="session-tab-composer" onSubmit={(event) => {
          event.preventDefault()
          if (!draft.trim() || session.status === 'waiting') return
          void perform('send', async () => {
            if (session.parentSessionId) await window.desktop.sendSubagentMessage(session.id, draft)
            else await window.desktop.sendMessage({ sessionId: session.id, workspace: session.workspace, text: draft })
            setDraft((current) => current === draft ? '' : current)
          })
        }}>
          <textarea aria-label="세션 추가 지시" placeholder="이 세션에 추가 지시를 입력하세요" value={draft} onChange={(event) => setDraft(event.target.value)} rows={2} />
          <Button type="submit" size="sm" disabled={!!pending || !draft.trim() || session.status === 'waiting'}>{pending === 'send' ? '전송 중…' : '지시 보내기'}</Button>
        </form>
      )}
    </div>
  )
}
