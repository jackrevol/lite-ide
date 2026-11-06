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
  sep,
} from 'node:path'
import type {
  ChangedFile,
  RepositorySnapshot,
  Worktree,
  WorktreeDeletionPreview,
} from '../shared/types.ts'

const execute = promisify(execFile)

async function git(
  directory: string,
  args: string[],
  timeout = 15_000,
): Promise<string> {
  const { stdout } = await execute('git', ['-C', directory, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout,
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
    const top = await git(directory, ['rev-parse', '--show-toplevel'])
    // .git이 사라진 하위 폴더를 상위 저장소의 작업 공간으로 오인하지 않습니다.
    if (pathKey(await realpath(top.trim())) !== pathKey(await realpath(directory)))
      throw new Error('Git 저장소 루트가 아닙니다.')
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
    worktrees: await Promise.all(
      parseWorktrees(worktreeList).map(async (tree) => ({
        ...tree,
        path: await realpath(tree.path).catch(() => resolve(tree.path)),
      })),
    ),
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
  baseRef = 'HEAD',
): Promise<Worktree> {
  if (typeof branch !== 'string' || !branch.trim() || branch.length > 100)
    throw new Error('브랜치 이름을 입력해 주세요.')
  await git(directory, ['check-ref-format', '--branch', branch])
  const base = await resolveBaseRef(directory, baseRef)
  const name = branch.replace(/[^a-zA-Z0-9._-]/g, '-')
  const path = join(
    dirname(directory),
    `${basename(directory)}-worktrees`,
    `${name}-${crypto.randomUUID().slice(0, 8)}`,
  )
  await git(directory, ['worktree', 'add', '-b', branch, path, base])
  // Git이 정규화한 경로를 사용해 Windows의 짧은 경로·드라이브 표기 차이를 없앱니다.
  const snapshot = await inspectRepository(directory)
  const created = snapshot.worktrees.find((tree) => tree.branch === branch)
  if (!created) throw new Error('생성한 Worktree 경로를 확인하지 못했습니다.')
  return created
}

export async function requireLinkedWorktree(directory: string): Promise<void> {
  let directories: [string, string]
  try {
    const top = await git(directory, ['rev-parse', '--show-toplevel'])
    if (
      pathKey(await realpath(top.trim())) !== pathKey(await realpath(directory))
    )
      throw new Error('Worktree 루트가 아닙니다.')
    directories = await Promise.all([
      git(directory, ['rev-parse', '--absolute-git-dir']),
      git(directory, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    ])
  } catch {
    throw new Error(
      'Worktree 폴더가 없거나 Git 연결이 끊어졌습니다. 작업 삭제에서 로컬 기록을 정리한 뒤 새 작업을 만들어 주세요.',
    )
  }
  const [gitDirectory, commonDirectory] = directories
  if (pathKey(gitDirectory.trim()) === pathKey(commonDirectory.trim()))
    throw new Error('새 작업을 만들어 전용 Worktree에서 실행해 주세요.')
}

export async function listBranches(directory: string): Promise<string[]> {
  const output = await git(directory, [
    'for-each-ref',
    '--format=%(refname)%00%(symref)',
    'refs/heads/',
    'refs/remotes/',
  ])
  return output
    .split(/\r?\n/)
    .filter((line) => line.endsWith('\0'))
    .map((line) => line.slice(0, -1))
    .filter((ref) => /^refs\/(heads|remotes)\/.+/.test(ref))
}

export async function resolveBaseRef(
  directory: string,
  baseRef: string,
): Promise<string> {
  if (
    typeof baseRef !== 'string' ||
    (baseRef !== 'HEAD' && !(await listBranches(directory)).includes(baseRef))
  )
    throw new Error('사용 가능한 기준 브랜치를 선택해 주세요.')
  const commit = (
    await git(directory, [
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${baseRef}^{commit}`,
    ])
  ).trim()
  if (!/^[a-f0-9]{40,64}$/.test(commit))
    throw new Error('기준 브랜치의 commit을 확인하지 못했습니다.')
  return commit
}

export const pathKey = (path: string) => {
  const value = resolve(path)
  return process.platform === 'win32' ? value.toLowerCase() : value
}

export function workspaceContains(directory: string, path: string) {
  const root = pathKey(directory),
    target = pathKey(path)
  return (
    root === target || target.startsWith(root.endsWith(sep) ? root : root + sep)
  )
}

export async function resolveWorktreePath(target: string) {
  if (typeof target !== 'string' || !isAbsolute(target))
    throw new Error('올바른 Worktree 경로를 선택해 주세요.')
  return realpath(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return resolve(target)
  })
}

export async function inspectWorktreeDeletion(
  directory: string,
  target: string,
  protectedPaths: string[] = [],
): Promise<WorktreeDeletionPreview> {
  const canonicalTarget = await resolveWorktreePath(target)
  const snapshot = await inspectRepository(directory)
  if (!snapshot.isGitRepository)
    throw new Error('프로젝트의 Git 저장소를 확인할 수 없습니다.')
  if (
    pathKey(snapshot.worktrees[0].path) === pathKey(canonicalTarget) ||
    protectedPaths.some((path) => workspaceContains(canonicalTarget, path))
  )
    throw new Error(
      '기본 작업 공간이나 별도로 연 프로젝트는 삭제할 수 없습니다.',
    )
  const member = snapshot.worktrees.find(
    (tree) => pathKey(tree.path) === pathKey(canonicalTarget),
  )
  if (!member) return { localOnly: true, branch: null, totalChanges: 0 }
  try {
    await requireLinkedWorktree(canonicalTarget)
  } catch {
    return { localOnly: true, branch: null, totalChanges: 0 }
  }
  const status = await git(canonicalTarget, [
    'status', '--porcelain=v1', '-z', '--untracked-files=all',
  ])
  return {
    localOnly: false,
    branch: member.branch === 'Detached HEAD' ? null : member.branch,
    totalChanges: parseStatus(status).length,
  }
}

export async function removeWorktree(
  directory: string,
  target: string,
  protectedPaths: string[] = [],
  discardChanges = false,
  localOnly = false,
): Promise<{ warning?: string }> {
  const canonicalTarget = await resolveWorktreePath(target)
  const preview = await inspectWorktreeDeletion(
    directory, canonicalTarget, protectedPaths,
  )
  if (localOnly) {
    if (!preview.localOnly)
      throw new Error(
        'Worktree가 다시 연결되었습니다. 삭제 내용을 다시 확인해 주세요.',
      )
    return {
      warning: 'Git 연결이 끊어진 작업의 로컬 기록만 정리했습니다. 남아 있는 폴더와 로컬 브랜치는 보존했습니다.',
    }
  }
  const snapshot = await inspectRepository(directory)
  const member = snapshot.worktrees.find(
    (tree) => pathKey(tree.path) === pathKey(canonicalTarget),
  )
  if (!member)
    throw new Error('이 프로젝트에 등록된 Worktree만 삭제할 수 있습니다.')
  if (
    pathKey(snapshot.worktrees[0].path) === pathKey(canonicalTarget) ||
    protectedPaths.some((path) => pathKey(path) === pathKey(canonicalTarget))
  )
    throw new Error(
      '기본 작업 공간이나 별도로 연 프로젝트는 삭제할 수 없습니다.',
    )
  await requireLinkedWorktree(canonicalTarget)
  const status = await git(canonicalTarget, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ])
  if (status && !discardChanges)
    throw new Error(
      '변경 파일 또는 추적하지 않는 파일이 있어 삭제할 수 없습니다.',
    )
  let branchRef: string | null
  try {
    branchRef = (
      await git(canonicalTarget, ['symbolic-ref', '--quiet', 'HEAD'])
    ).trim()
  } catch (error) {
    if ((error as { code?: unknown }).code !== 1) throw error
    branchRef = null
  }
  const branch = branchRef?.startsWith('refs/heads/')
    ? branchRef.slice(11)
    : null
  if (
    branch &&
    snapshot.worktrees.some(
      (tree) =>
        pathKey(tree.path) !== pathKey(canonicalTarget) &&
        tree.branch === branch,
    )
  )
    throw new Error(
      `로컬 브랜치 ${branch}를 다른 Worktree에서도 사용하고 있어 삭제할 수 없습니다.`,
    )
  // Git 자체가 잠금·서브모듈 등 추가 보호 조건을 검사합니다.
  let warning: string | undefined
  try {
    // node_modules가 큰 Windows Worktree 삭제를 일반 조회 제한 시간으로 중단하지 않습니다.
    await git(
      directory,
      ['worktree', 'remove', ...(discardChanges ? ['--force'] : []), '--', canonicalTarget],
      10 * 60_000,
    )
  } catch (error) {
    const after = await inspectRepository(directory)
    if (
      !after.isGitRepository ||
      after.worktrees.some((tree) => pathKey(tree.path) === pathKey(canonicalTarget))
    )
      throw error
    // Git 등록이 이미 해제된 부분 실패는 재시도 불가 상태로 남기지 않습니다.
    warning = `Git 등록은 해제되었지만 폴더 삭제 중 오류가 발생했습니다. 남아 있는 폴더를 확인해 주세요. ${error instanceof Error ? error.message : String(error)}`
  }
  if (branch) {
    try {
      await git(directory, ['branch', '-D', '--', branch])
    } catch (error) {
      return {
        warning: [
          warning,
          `${warning ? 'Worktree 등록은 해제되었지만' : 'Worktree 폴더는 삭제되었지만'} 로컬 브랜치 ${branch}를 삭제하지 못했습니다. ${error instanceof Error ? error.message : String(error)}`,
        ].filter(Boolean).join('\n'),
      }
    }
  }
  return warning ? { warning } : {}
}
