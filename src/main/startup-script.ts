import { realpath, stat } from 'node:fs/promises'
import { join, resolve, win32, posix } from 'node:path'
import { workspaceContains } from './git.ts'

export function validateStartupScriptPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value))
    throw new Error('Startup 스크립트는 레포 안의 파일 상대 경로로 입력해 주세요.')
  const path = value.trim().replaceAll('\\', '/')
  if (win32.isAbsolute(path) || posix.isAbsolute(path) || path.includes(':') || path.split('/').includes('..'))
    throw new Error('Startup 스크립트는 레포 안의 파일 상대 경로로 입력해 주세요.')
  return path
}

export async function resolveStartupScript(workspace: string, value: string): Promise<string> {
  const path = validateStartupScriptPath(value)
  const extensions = process.platform === 'win32' ? ['.ps1', '.sh'] : ['.sh']
  if (!extensions.some((extension) => path.toLowerCase().endsWith(extension)))
    throw new Error(`이 운영체제의 Startup 스크립트는 ${extensions.join(' 또는 ')} 파일을 지정해 주세요.`)
  const root = await realpath(workspace)
  let file: string
  try {
    file = await realpath(resolve(root, path))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(`Startup 스크립트 파일이 없습니다: ${path}. 현재 Worktree에 파일이 있는지 확인해 주세요.`)
    throw error
  }
  if (!workspaceContains(root, file))
    throw new Error('Startup 스크립트는 현재 Worktree 안의 파일이어야 합니다.')
  if (!(await stat(file)).isFile()) throw new Error(`Startup 스크립트가 파일이 아닙니다: ${path}`)
  return file
}

export async function findGitBash(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const value = (name: string) => Object.entries(env).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1]
  const isFile = (path: string) => stat(path).then((entry) => entry.isFile()).catch(() => false)
  const roots: string[] = []
  for (const entry of (value('PATH') ?? '').split(';')) {
    const directory = entry.replace(/^"|"$/g, '')
    if (!directory || !win32.isAbsolute(directory)) continue
    if (await isFile(join(directory, 'git.exe'))) {
      // Git의 cmd, bin, mingw64/bin 및 휴대용 설치 경로를 지원합니다.
      roots.push(resolve(directory, '..'), resolve(directory, '../..'), directory)
    }
  }
  for (const name of ['ProgramW6432', 'ProgramFiles', 'ProgramFiles(x86)']) {
    const directory = value(name)
    if (directory) roots.push(join(directory, 'Git'))
  }
  const local = value('LOCALAPPDATA')
  if (local) roots.push(join(local, 'Programs', 'Git'))
  for (const root of new Set(roots)) {
    for (const directory of ['bin', 'usr/bin']) {
      const executable = join(root, directory, 'bash.exe')
      if (await isFile(executable)) return executable
    }
  }
  // Windows의 bash.exe는 WSL 실행기일 수 있으므로 PATH에서 직접 실행하지 않습니다.
  throw new Error('Windows에서 .sh Startup 스크립트를 실행하려면 Git for Windows의 Git Bash가 필요합니다. Git Bash를 설치한 뒤 앱을 다시 시작하거나 .ps1 파일을 지정해 주세요.')
}
