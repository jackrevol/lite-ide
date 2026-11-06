export interface Project {
  path: string
  name: string
}

export interface Worktree {
  path: string
  branch: string
}

export interface ChangedFile {
  path: string
  status: string
}

export interface RepositorySnapshot {
  isGitRepository: boolean
  worktrees: Worktree[]
  changes: ChangedFile[]
  totalChanges: number
}

export interface DesktopApi {
  openProject(): Promise<Project | null>
  inspectRepository(projectPath: string): Promise<RepositorySnapshot>
  readDiff(projectPath: string, filePath: string): Promise<string>
}
