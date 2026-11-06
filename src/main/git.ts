import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { lstat, readFile, realpath } from 'node:fs/promises'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path'
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
      git(directory, [
        '-c',
        'core.quotePath=false',
        'worktree',
        'list',
        '--porcelain',
      ]),
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
  const untracked = await git(directory, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
    '--',
    file,
  ])
  if (untracked.split('\0').includes(file.replaceAll('\\', '/'))) {
    const absolute = resolve(directory, file)
    const info = await lstat(absolute)
    if (info.isSymbolicLink() || !info.isFile()) return '일반 파일이 아닙니다.'
    const scope = relative(await realpath(directory), await realpath(absolute))
    if (scope.startsWith('..') || isAbsolute(scope))
      throw new Error('프로젝트 내부 파일만 확인할 수 있습니다.')
    if (info.size > 1024 * 1024)
      return '파일이 1MB를 초과하여 미리보기를 생략했습니다.'
    const content = await readFile(absolute, 'utf8')
    if (content.includes('\0'))
      return '바이너리 파일은 diff를 표시할 수 없습니다.'
    return (
      `diff --git a/${file} b/${file}\nnew file\n--- /dev/null\n+++ b/${file}\n` +
      content
        .split('\n')
        .map((line) => `+${line}`)
        .join('\n')
    )
  }
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

export async function createWorktree(
  directory: string,
  branch: string,
): Promise<Worktree> {
  if (typeof branch !== 'string' || !branch.trim() || branch.length > 100)
    throw new Error('브랜치 이름을 입력해 주세요.')
  await git(directory, ['check-ref-format', '--branch', branch])
  const name = branch.replace(/[^a-zA-Z0-9._-]/g, '-')
  const path = join(
    dirname(directory),
    `${basename(directory)}-worktrees`,
    `${name}-${crypto.randomUUID().slice(0, 8)}`,
  )
  await git(directory, ['worktree', 'add', '-b', branch, path])
  // Git이 정규화한 경로를 사용해 Windows의 짧은 경로·드라이브 표기 차이를 없앱니다.
  const snapshot = await inspectRepository(directory)
  const created = snapshot.worktrees.find((tree) => tree.branch === branch)
  if (!created) throw new Error('생성한 Worktree 경로를 확인하지 못했습니다.')
  return created
}
