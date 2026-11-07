import { realpath, stat } from 'node:fs/promises'
import { resolve, win32, posix } from 'node:path'
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
  const extension = process.platform === 'win32' ? '.ps1' : '.sh'
  if (!path.toLowerCase().endsWith(extension))
    throw new Error(`이 운영체제의 Startup 스크립트는 ${extension} 파일을 지정해 주세요.`)
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
