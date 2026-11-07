import type { AgentSession } from '../../../shared/types'

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
