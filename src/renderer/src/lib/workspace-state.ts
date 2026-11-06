export type Task = {
  id: string
  title: string
  draft: string
  project: string
  branch: string
}
export type WorkspaceState = {
  tasks: Record<string, Task>
  project: string
  workspace: string
}

// 이전 로컬 작업과 여러 작업을 가진 Worktree 기록은 불러오지 않습니다.
export const storageKey = 'lite-ide.workspace.v2'

export function loadWorkspace(): WorkspaceState {
  const fallback: WorkspaceState = { tasks: {}, project: '', workspace: '' }
  try {
    const data = JSON.parse(localStorage.getItem(storageKey) ?? 'null')
    if (!data || typeof data !== 'object') return fallback
    const tasks: Record<string, Task> = {}
    const ids = new Set<string>()
    for (const [path, task] of Object.entries(data.tasks ?? {})) {
      const item = task as Task | null
      if (
        !path || path === '__proto__' || !item ||
        typeof item.id !== 'string' || !item.id || ids.has(item.id) ||
        typeof item.title !== 'string' || typeof item.draft !== 'string' ||
        typeof item.project !== 'string' || !item.project ||
        typeof item.branch !== 'string' || !item.branch ||
        path.replaceAll('\\', '/') === item.project.replaceAll('\\', '/')
      ) continue
      ids.add(item.id)
      tasks[path] = item
    }
    return {
      tasks,
      project: typeof data.project === 'string' ? data.project : '',
      workspace: typeof data.workspace === 'string' && tasks[data.workspace]
        ? data.workspace : '',
    }
  } catch {
    return fallback
  }
}
