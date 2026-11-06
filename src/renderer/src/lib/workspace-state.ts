export type TaskMode = 'worktree'
export type Session = {
  id: string
  title: string
  draft: string
  project?: string
  branch?: string
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

// 이전 로컬 작업 기록은 복원하지 않고, 새 작업과 Worktree만 1:1로 저장합니다.
export const storageKey = 'lite-ide.workspace.v2'
export const createSession = (number = 1): Session => ({
  id: crypto.randomUUID(),
  title: `작업 ${number}`,
  draft: '',
})

export function loadWorkspace(): WorkspaceState {
  const fallback: WorkspaceState = {
    sessions: {},
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
          typeof s.project === 'string' &&
          !!s.project &&
          typeof s.branch === 'string' &&
          !!s.branch &&
          path.replaceAll('\\', '/') !== s.project.replaceAll('\\', '/') &&
          (s.model === undefined || typeof s.model === 'string') &&
          (s.effort === undefined || typeof s.effort === 'string') &&
          (s.customTitle === undefined || typeof s.customTitle === 'boolean'),
      )
      if (valid.length) sessions[path] = valid.slice(0, 1)
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
      sessions,
      selected,
      project: typeof data.project === 'string' ? data.project : '',
      workspace:
        typeof data.workspace === 'string' && sessions[data.workspace]?.length
          ? data.workspace
          : '',
      worktreeNames,
      newTaskMode: 'worktree',
    }
  } catch {
    return fallback
  }
}
