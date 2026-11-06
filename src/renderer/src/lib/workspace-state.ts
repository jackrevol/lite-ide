export type Session = { id: string; title: string; draft: string }
export type TaskMode = 'local' | 'worktree'
export type WorkspaceState = {
  sessions: Record<string, Session[]>
  selected: Record<string, string>
  project: string
  workspace: string
  newTaskMode: TaskMode
}

export const storageKey = 'lite-ide.workspace.v1'
export const createSession = (number = 1): Session => ({
  id: crypto.randomUUID(),
  title: `작업 ${number}`,
  draft: '',
})

export function loadWorkspace(): WorkspaceState {
  const fallback: WorkspaceState = {
    sessions: { welcome: [createSession()] },
    selected: {},
    project: '',
    workspace: '',
    newTaskMode: 'local',
  }
  try {
    const data = JSON.parse(localStorage.getItem(storageKey) ?? 'null')
    if (!data || typeof data !== 'object') return fallback
    const sessions: Record<string, Session[]> = {}
    for (const [path, entries] of Object.entries(data.sessions ?? {})) {
      if (path === '__proto__' || !Array.isArray(entries)) continue
      const valid = entries.filter(
        (s): s is Session =>
          s &&
          typeof s.id === 'string' &&
          typeof s.title === 'string' &&
          typeof s.draft === 'string',
      )
      if (valid.length) sessions[path] = valid
    }
    const selected: Record<string, string> = {}
    for (const [path, id] of Object.entries(data.selected ?? {})) {
      if (path !== '__proto__' && typeof id === 'string') selected[path] = id
    }
    return {
      sessions: { ...fallback.sessions, ...sessions },
      selected,
      project: typeof data.project === 'string' ? data.project : '',
      workspace: typeof data.workspace === 'string' ? data.workspace : '',
      newTaskMode: data.newTaskMode === 'worktree' ? 'worktree' : 'local',
    }
  } catch {
    return fallback
  }
}
