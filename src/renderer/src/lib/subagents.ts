import type { AgentSession } from '../../../shared/types'

export function getSubagents(
  parentId: string,
  agents: Record<string, AgentSession>,
) {
  const family = new Set([parentId])
  const children: AgentSession[] = []
  // 자식이 먼저 저장된 경우에도 모든 깊이의 에이전트를 부모 아래에 모읍니다.
  for (const id of family) {
    for (const session of Object.values(agents)) {
      if (session.parentSessionId === id && !family.has(session.id)) {
        family.add(session.id)
        children.push(session)
      }
    }
  }
  return children
}

export const isAgentActive = (session: AgentSession) =>
  session.status === 'running' || session.status === 'waiting'
