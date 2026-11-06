import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type {
  ChangedFile,
  RepositorySnapshot,
  Worktree,
} from '../shared/types.ts'

const execute = promisify(execFile)

async function git(directory: string, args: string[]): Promise<string> {
  const { stdout } = await execute('git', ['-C', directory, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  })
  return stdout
}

export function parseStatus(output: string): ChangedFile[] {
  const entries = output.split('\0')
  const files: ChangedFile[] = []
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    if (!entry) continue
    const status = entry.slice(0, 2)
    files.push({ path: entry.slice(3), status })
    // -z 형식의 이름 변경은 새 경로 다음에 이전 경로가 별도 필드로 옵니다.
    if (/[RC]/.test(status)) index++
  }
  return files
}

export function parseWorktrees(output: string): Worktree[] {
  const worktrees: Worktree[] = []
  let current: Worktree | undefined
  for (const entry of output.split(output.includes('\0') ? '\0' : /\r?\n/)) {
    if (entry.startsWith('worktree ')) {
      const path = entry.slice(9)
      current = {
        path: path.startsWith('"') ? JSON.parse(path) : path,
        branch: 'Detached HEAD',
      }
      worktrees.push(current)
    } else if (entry.startsWith('branch ') && current) {
      current.branch = entry.slice(7).replace(/^refs\/heads\//, '')
    }
  }
  return worktrees
}

export async function inspectRepository(
  directory: string,
): Promise<RepositorySnapshot> {
  try {
    await git(directory, ['rev-parse', '--show-toplevel'])
  } catch {
    return {
      isGitRepository: false,
      worktrees: [],
      changes: [],
      totalChanges: 0,
    }
  }
  const [status, worktreeList] = await Promise.all([
    git(directory, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=normal',
    ]),
    git(directory, ['worktree', 'list', '--porcelain', '-z']).catch(() =>
      git(directory, ['-c', 'core.quotePath=false', 'worktree', 'list', '--porcelain']),
    ),
  ])
  const changes = parseStatus(status)
  return {
    isGitRepository: true,
    worktrees: parseWorktrees(worktreeList),
    changes: changes.slice(0, 200),
    totalChanges: changes.length,
  }
}

export async function readDiff(
  directory: string,
  file: string,
): Promise<string> {
  const options = ['--no-ext-diff', '--no-textconv', '--no-color']
  try {
    await git(directory, ['rev-parse', '--verify', 'HEAD'])
  } catch {
    const [staged, unstaged] = await Promise.all([
      git(directory, ['diff', ...options, '--cached', '--', file]),
      git(directory, ['diff', ...options, '--', file]),
    ])
    return staged + unstaged
  }
  return git(directory, ['diff', ...options, 'HEAD', '--', file])
}
