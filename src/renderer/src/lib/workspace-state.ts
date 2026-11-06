export type TaskMode = 'local' | 'worktree'
export type Session = {
  id: string
  title: string
  draft: string
  customTitle?: boolean
  model?: string
  effort?: string
}
export type WorkspaceState = {
  sessions: Record<string, Session[]>
  selected: Record<string, string>
  project: string
  workspace: string
  worktreeNames: Record<string, string>
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
    worktreeNames: {},
    newTaskMode: 'worktree' as TaskMode,
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
          typeof s.draft === 'string' &&
          (s.model === undefined || typeof s.model === 'string') &&
          (s.effort === undefined || typeof s.effort === 'string') &&
          (s.customTitle === undefined || typeof s.customTitle === 'boolean'),
      )
      if (valid.length) sessions[path] = valid
    }
    const selected: Record<string, string> = {}
    for (const [path, id] of Object.entries(data.selected ?? {})) {
      if (path !== '__proto__' && typeof id === 'string') selected[path] = id
    }
    const worktreeNames: Record<string, string> = {}
    for (const [path, name] of Object.entries(data.worktreeNames ?? {})) {
      if (path !== '__proto__' && typeof name === 'string' && name.trim())
        worktreeNames[path] = name.trim().slice(0, 100)
    }
    return {
      sessions: { ...fallback.sessions, ...sessions },
      selected,
      project: typeof data.project === 'string' ? data.project : '',
      workspace: typeof data.workspace === 'string' ? data.workspace : '',
      worktreeNames,
      newTaskMode: data.newTaskMode === 'local' ? 'local' : 'worktree',
    }
  } catch {
    return fallback
  }
}
