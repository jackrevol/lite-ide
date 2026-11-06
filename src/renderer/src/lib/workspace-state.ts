import type { TerminalKind } from '../../../shared/types'

export interface WorkspaceTask {
  id: string
  project: string
  path: string
  branch: string
  name: string
  model: string
  effort: string
  terminalKind: TerminalKind
  initialPrompt?: string
  draft?: string
  threadId?: string
}
export interface WorkspaceState {
  tasks: WorkspaceTask[]
  project: string
  taskId: string
}
export const storageKey = 'lite-ide.workspace.v3'

function canonical(path: string) {
  const normalized = path.replaceAll('\\', '/').replace(/\/$/, '')
  return typeof window !== 'undefined' && window.desktop.platform === 'win32'
    ? normalized.toLowerCase()
    : normalized
}
function validTask(value: unknown): value is WorkspaceTask {
  if (!value || typeof value !== 'object') return false
  const task = value as WorkspaceTask
  return (
    ['id', 'project', 'path', 'branch', 'name', 'model', 'effort'].every(
      (key) => typeof task[key as keyof WorkspaceTask] === 'string',
    ) &&
    !!task.id &&
    !!task.project &&
    !!task.path &&
    !!task.branch &&
    canonical(task.project) !== canonical(task.path) &&
    ['codex', 'shell'].includes(task.terminalKind) &&
    ['initialPrompt', 'draft', 'threadId'].every(
      (key) =>
        task[key as keyof WorkspaceTask] === undefined ||
        typeof task[key as keyof WorkspaceTask] === 'string',
    )
  )
}
export function loadWorkspace(): WorkspaceState {
  const fallback: WorkspaceState = { tasks: [], project: '', taskId: '' }
  try {
    let data = JSON.parse(localStorage.getItem(storageKey) ?? 'null')
    if (!data) {
      const legacy = JSON.parse(
        localStorage.getItem('lite-ide.workspace.v2') ?? 'null',
      )
      if (!legacy) return fallback
      const tasks: WorkspaceTask[] = []
      for (const [path, entries] of Object.entries(legacy.sessions ?? {})) {
        if (!Array.isArray(entries)) continue
        const entry = entries[0]
        if (!entry) continue
        const task = {
          id: entry.id,
          project: entry.project,
          path,
          branch: entry.branch,
          name: legacy.worktreeNames?.[path] || entry.title,
          model: entry.model ?? '',
          effort: entry.effort ?? '',
          terminalKind: 'codex',
          draft: entry.draft,
        } as WorkspaceTask
        if (validTask(task)) tasks.push(task)
      }
      data = {
        tasks,
        project: legacy.project,
        taskId:
          tasks.find(
            (task) =>
              canonical(task.path) === canonical(legacy.workspace ?? ''),
          )?.id ?? '',
      }
    }
    if (!Array.isArray(data.tasks)) return fallback
    const ids = new Set<string>(),
      paths = new Set<string>()
    const tasks = data.tasks.filter((task: unknown): task is WorkspaceTask => {
      if (
        !validTask(task) ||
        ids.has(task.id) ||
        paths.has(canonical(task.path))
      )
        return false
      ids.add(task.id)
      paths.add(canonical(task.path))
      return true
    })
    return {
      tasks,
      project: typeof data.project === 'string' ? data.project : '',
      taskId: tasks.some((task: WorkspaceTask) => task.id === data.taskId)
        ? data.taskId
        : '',
    }
  } catch {
    return fallback
  }
}
