import type { AgentSession, TerminalSnapshot } from '../../../shared/types'

export interface SessionIndicatorStatus {
  state: AgentSession['status'] | 'unknown' | 'disconnected'
  label: string
}

export function agentSessionStatus(session: AgentSession): SessionIndicatorStatus {
  if (session.observationError)
    return { state: 'disconnected', label: '연결 안 됨 · 세션 상태 확인 실패' }
  if (session.requests.length || session.status === 'waiting')
    return { state: 'waiting', label: '답변 대기 중' }
  const labels: Record<AgentSession['status'], string> = {
    idle: '입력 대기 중', running: '작업 중', waiting: '답변 대기 중',
    completed: '작업 완료', failed: '작업 실패', interrupted: '작업 중단',
  }
  return { state: session.status, label: labels[session.status] }
}

export function workspaceTaskStatus(
  sessions: AgentSession[],
  workspace: string,
  platform: string,
  terminal?: TerminalSnapshot,
): SessionIndicatorStatus {
  if (!terminal?.running || terminal.kind !== 'codex')
    return { state: 'disconnected', label: '연결 안 됨' }
  if (terminal.waitingForInput)
    return { state: 'waiting', label: '답변 대기 중' }

  // 과거 대화나 자식 세션의 완료 기록이 현재 작업 상태를 덮지 않게 합니다.
  const root = workspaceSessions(sessions, workspace, platform)
    .filter((session) => !session.parentSessionId && !session.closed)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]
  // 세션 미관측이나 일반 입력 대기는 질문·승인 요청의 근거가 아닙니다.
  if (!root)
    return { state: 'unknown', label: '상태 확인 중' }
  return agentSessionStatus(root)
}

export function sameWorkspace(a: string, b: string, platform: string) {
  const normalize = (path: string) => {
    const value = path.replaceAll('\\', '/').replace(/\/+$/, '')
    return platform === 'win32' ? value.toLowerCase() : value
  }
  return normalize(a) === normalize(b)
}

export function workspaceSessions(
  sessions: AgentSession[],
  workspace: string,
  platform: string,
) {
  if (!workspace) return []
  return sessions
    .filter((session) => sameWorkspace(session.workspace, workspace, platform))
    .sort((a, b) => {
      // 부모 세션을 먼저 배치하고 갱신 중에도 탭의 순서를 유지합니다.
      if (!!a.parentSessionId !== !!b.parentSessionId)
        return a.parentSessionId ? 1 : -1
      return a.id.localeCompare(b.id)
    })
}
