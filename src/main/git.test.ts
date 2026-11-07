import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  readDiff,
  parseStatus,
  parseWorktrees,
  createWorktree,
  removeWorktree,
  removeEmptyWorktreeDirectory,
  listBranches,
  requireLinkedWorktree,
  inspectWorktreeDeletion,
  inspectRepository,
} from './git.ts'
import { validateCloneInput } from './clone.ts'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  rm,
  realpath,
  rmdir,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('Git 삭제 후 빈 폴더만 재시도하고 새로 생긴 파일은 보존한다', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lite-ide-empty-worktree-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let attempts = 0
  await removeEmptyWorktreeDirectory(directory, async (path) => {
    if (++attempts < 3) throw Object.assign(new Error('locked'), { code: 'EPERM' })
    await rmdir(path)
  })
  assert.equal(attempts, 3)
  await removeEmptyWorktreeDirectory(directory)
  await mkdir(directory)
  await writeFile(join(directory, 'keep.txt'), '보존', 'utf8')
  await assert.rejects(removeEmptyWorktreeDirectory(directory))
  assert.equal(await readFile(join(directory, 'keep.txt'), 'utf8'), '보존')
})

test('해제되지 않는 폴더 잠금은 제한 횟수 후 오류로 반환한다', async () => {
  let attempts = 0
  await assert.rejects(removeEmptyWorktreeDirectory('/unused', async () => {
    attempts++
    throw Object.assign(new Error('locked'), { code: 'EBUSY' })
  }), /locked/)
  assert.equal(attempts, 5)
})

test('Windows cwd 잠금으로 Git 등록만 해제되어도 잠금 해제 후 빈 폴더까지 정리한다', { skip: process.platform !== 'win32' }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lite-ide-cwd-lock-')))
  const tree = join(root, 'worktree')
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { windowsHide: true, encoding: 'utf8' })
  let child: ReturnType<typeof spawn> | undefined
  let exited: Promise<unknown> | undefined
  try {
    git('init', '--initial-branch=main')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'fixture')
    git('worktree', 'add', '-b', 'locked-cwd', tree)
    child = spawn(process.execPath, ['-e', `
      const fs = require('node:fs');
      process.stdout.write('ready');
      const timer = setInterval(() => {
        if (!fs.existsSync('.git')) {
          clearInterval(timer);
          setTimeout(() => process.exit(0), 600);
        }
      }, 10);
    `], { cwd: tree, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    exited = once(child, 'exit')
    await once(child.stdout!, 'data')
    assert.deepEqual(await removeWorktree(root, tree), {})
    assert.equal(await stat(tree).catch(() => null), null)
    assert.equal(git('branch', '--list', 'locked-cwd').trim(), '')
  } finally {
    child?.kill()
    await exited
    await rm(root, { recursive: true, force: true })
  }
})

test('Git 복제는 HTTPS와 SSH 주소 및 안전한 폴더 이름을 허용한다', () => {
  for (const url of [
    'https://github.com/owner/repo.git',
    'git@github.com:owner/repo.git',
    'ssh://git@example.com/owner/repo.git',
  ]) {
    assert.doesNotThrow(() => validateCloneInput(url, '한글 project'))
  }
})

test('새 Worktree는 선택한 로컬·원격 기준 commit에서 시작하고 잘못된 ref를 거부한다', async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'lite-ide-base-ref-')),
  )
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      windowsHide: true,
    })
  const commit = () =>
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-am',
      'fixture',
    )
  try {
    git('init', '--initial-branch=main')
    await writeFile(join(root, 'file.txt'), 'base\n', 'utf8')
    git('add', '.')
    commit()
    const base = git('rev-parse', 'HEAD').trim()
    await assert.rejects(requireLinkedWorktree(root), /전용 Worktree/)
    git('branch', 'base')
    git('update-ref', 'refs/remotes/origin/base', base)
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/base')
    git('tag', 'v1')
    await writeFile(join(root, 'file.txt'), 'newer\n', 'utf8')
    commit()
    const head = git('rev-parse', 'HEAD').trim()
    await writeFile(join(root, 'file.txt'), 'unsaved\n', 'utf8')
    const refs = await listBranches(root)
    assert.ok(refs.includes('refs/heads/base'))
    assert.ok(refs.includes('refs/remotes/origin/base'))
    assert.equal(refs.includes('refs/remotes/origin/HEAD'), false)
    for (const [index, ref] of [
      'refs/heads/base',
      'refs/remotes/origin/base',
    ].entries()) {
      const tree = await createWorktree(root, `feature/base-${index}`, ref)
      await requireLinkedWorktree(tree.path)
      assert.equal(
        execFileSync('git', ['-C', tree.path, 'rev-parse', 'HEAD'], {
          encoding: 'utf8',
          windowsHide: true,
        }).trim(),
        base,
      )
      await removeWorktree(root, tree.path)
    }
    for (const ref of [
      '--detach',
      'missing',
      'refs/heads/missing',
      'refs/tags/v1',
      'HEAD~1',
      base,
    ])
      await assert.rejects(
        createWorktree(root, 'feature/rejected', ref),
        /기준 브랜치/,
      )
    assert.equal(git('branch', '--list', 'feature/rejected').trim(), '')
    assert.equal(git('rev-parse', 'HEAD').trim(), head)
    assert.equal(await readFile(join(root, 'file.txt'), 'utf8'), 'unsaved\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Git 복제의 옵션 주입, 외부 명령 프로토콜, 경로 이탈, 인증 정보 저장을 차단한다', () => {
  for (const url of [
    '--upload-pack=evil',
    'ext::command',
    'file:///tmp/repo',
    'https://token@example.com/repo',
    'ssh://git:secret@example.com/repo',
    'https://example.com/repo\n',
  ]) {
    assert.throws(() => validateCloneInput(url, 'repo'))
  }
  for (const name of [
    '..',
    '../outside',
    'nested/repo',
    'nested\\repo',
    'CON',
    'repo.',
    'repo ',
  ]) {
    assert.throws(() => validateCloneInput('https://example.com/repo', name))
  }
})

test('변경 파일의 한글과 공백 및 이름 변경 경로를 보존한다', () => {
  assert.deepEqual(
    parseStatus(
      ' M src/한글 파일.ts\0R  new name.ts\0old name.ts\0?? notes.txt\0',
    ),
    [
      { path: 'src/한글 파일.ts', status: ' M' },
      { path: 'new name.ts', status: 'R ' },
      { path: 'notes.txt', status: '??' },
    ],
  )
})

test('Worktree의 공백 포함 경로와 브랜치를 읽는다', () => {
  assert.deepEqual(
    parseWorktrees(
      'worktree C:/Projects/my app\0HEAD abc\0branch refs/heads/main\0\0worktree C:/Projects/feature\0HEAD def\0detached\0\0',
    ),
    [
      { path: 'C:/Projects/my app', branch: 'main' },
      { path: 'C:/Projects/feature', branch: 'Detached HEAD' },
    ],
  )
})

test('변경 사항이 없으면 빈 목록을 반환한다', () => {
  assert.deepEqual(parseStatus(''), [])
  assert.deepEqual(parseWorktrees(''), [])
})

test('중첩된 추적하지 않는 파일은 폴더 요약 대신 실제 파일 경로로 조회한다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lite-ide-nested-files-'))
  try {
    execFileSync('git', ['-C', root, 'init', '--initial-branch=main'], { windowsHide: true })
    await mkdir(join(root, 'src', 'nested'), { recursive: true })
    await writeFile(join(root, 'src', 'nested', '한글.ts'), 'nested\n', 'utf8')
    const snapshot = await inspectRepository(root)
    assert.deepEqual(snapshot.changes, [{ path: 'src/nested/한글.ts', status: '??' }])
    assert.equal(snapshot.totalChanges, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('구버전 Git의 줄바꿈 형식에서도 한글 경로를 읽는다', () => {
  assert.deepEqual(
    parseWorktrees(
      'worktree C:/Projects/한글 project\nHEAD abc\nbranch refs/heads/main\n\n',
    ),
    [{ path: 'C:/Projects/한글 project', branch: 'main' }],
  )
})

test('Worktree 삭제는 경로·변경 파일·잠금을 보호하고 무시 파일과 연결 브랜치를 삭제한다', async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'lite-ide-git-delete-')),
  )
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], {
      windowsHide: true,
      encoding: 'utf8',
    })
  const initialize = async (cwd: string) => {
    git(cwd, 'init', '--initial-branch=main')
    await writeFile(join(cwd, '.gitignore'), '.env\n', 'utf8')
    await writeFile(join(cwd, 'hello.txt'), 'hello\n', 'utf8')
    git(cwd, 'add', '.')
    git(
      cwd,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-m',
      'fixture',
    )
  }
  await initialize(directory)
  const tree = await createWorktree(directory, 'feature/delete-test')
  const other = await realpath(
    await mkdtemp(join(tmpdir(), 'lite-ide-other-git-')),
  )
  await initialize(other)
  try {
    await assert.rejects(removeWorktree(directory, directory), /기본 작업 공간/)
    await assert.rejects(removeWorktree(directory, other), /등록된 Worktree/)
    await assert.rejects(
      removeWorktree(directory, tree.path, [tree.path]),
      /별도로 연 프로젝트/,
    )
    await writeFile(join(tree.path, 'hello.txt'), 'changed\n', 'utf8')
    await assert.rejects(removeWorktree(directory, tree.path), /변경 파일/)
    git(tree.path, 'checkout', '--', 'hello.txt')
    for (const name of ['untracked.txt']) {
      await writeFile(join(tree.path, name), '보존할 데이터\n', 'utf8')
      await assert.rejects(removeWorktree(directory, tree.path), /변경 파일/)
      assert.ok(await stat(join(tree.path, name)))
      await rm(join(tree.path, name))
    }
    git(directory, 'worktree', 'lock', tree.path)
    await assert.rejects(removeWorktree(directory, tree.path))
    git(directory, 'worktree', 'unlock', tree.path)
    await writeFile(
      join(tree.path, '.env'),
      'Worktree와 함께 삭제할 무시 파일',
      'utf8',
    )
    await removeWorktree(directory, tree.path)
    assert.equal(await stat(tree.path).catch(() => null), null)
    assert.equal(
      git(directory, 'branch', '--list', 'feature/delete-test').trim(),
      '',
    )
    const discard = await createWorktree(directory, 'feature/confirmed-delete')
    await writeFile(join(discard.path, 'hello.txt'), '수정한 파일\n', 'utf8')
    await writeFile(
      join(discard.path, '새 파일.txt'),
      '추적하지 않는 파일\n',
      'utf8',
    )
    await writeFile(join(discard.path, '.env'), '무시된 파일\n', 'utf8')
    await assert.rejects(removeWorktree(directory, discard.path), /변경 파일/)
    await assert.rejects(
      removeWorktree(directory, directory, [], true),
      /기본 작업 공간/,
    )
    await assert.rejects(
      removeWorktree(directory, discard.path, [discard.path], true),
      /별도로 연 프로젝트/,
    )
    git(directory, 'worktree', 'lock', discard.path)
    await assert.rejects(removeWorktree(directory, discard.path, [], true))
    assert.equal(
      await readFile(join(discard.path, '새 파일.txt'), 'utf8'),
      '추적하지 않는 파일\n',
    )
    git(directory, 'worktree', 'unlock', discard.path)
    await removeWorktree(directory, discard.path, [], true)
    assert.equal(await stat(discard.path).catch(() => null), null)
    assert.equal(git(directory, 'branch', '--list', discard.branch).trim(), '')
    assert.equal(
      await readFile(join(directory, 'hello.txt'), 'utf8'),
      'hello\n',
    )
  } finally {
    // mkdtemp로 생성한 테스트 전용 폴더만 정리합니다.
    await rm(directory, { recursive: true, force: true })
    await rm(other, { recursive: true, force: true })
  }
})

test('연결된 미병합 로컬 브랜치를 삭제하고 detached·공유 브랜치·삭제 부분 실패를 처리한다', async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'lite-ide-delete-branch-')),
  )
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], {
      windowsHide: true,
      encoding: 'utf8',
    })
  try {
    git(root, 'init', '--initial-branch=main')
    await writeFile(join(root, 'file.txt'), 'base', 'utf8')
    git(root, 'add', '.')
    git(
      root,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-m',
      'base',
    )
    git(root, 'branch', 'keep')
    const unmerged = join(root, 'unmerged')
    git(root, 'worktree', 'add', '-b', 'feature/unmerged', unmerged)
    await writeFile(join(unmerged, 'file.txt'), 'unmerged commit', 'utf8')
    git(
      unmerged,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-am',
      'unmerged',
    )
    const commit = git(unmerged, 'rev-parse', 'HEAD').trim()
    git(root, 'update-ref', 'refs/remotes/origin/feature/unmerged', commit)
    assert.deepEqual(await removeWorktree(root, unmerged), {})
    assert.equal(await stat(unmerged).catch(() => null), null)
    assert.equal(git(root, 'branch', '--list', 'feature/unmerged').trim(), '')
    assert.equal(
      git(root, 'rev-parse', 'refs/remotes/origin/feature/unmerged').trim(),
      commit,
    )
    assert.match(git(root, 'branch', '--list', 'main', 'keep'), /main/)

    const detached = join(root, 'detached')
    git(root, 'worktree', 'add', '--detach', detached, 'HEAD')
    assert.deepEqual(await removeWorktree(root, detached), {})
    assert.equal(await stat(detached).catch(() => null), null)
    assert.match(git(root, 'branch', '--list', 'keep'), /keep/)

    const shared = join(root, 'shared'),
      other = join(root, 'shared-other')
    git(root, 'worktree', 'add', '-b', 'feature/shared', shared)
    git(root, 'worktree', 'add', '--force', other, 'feature/shared')
    await assert.rejects(removeWorktree(root, shared), /다른 Worktree/)
    assert.ok(await stat(shared))
    assert.ok(await stat(other))
    assert.match(
      git(root, 'branch', '--list', 'feature/shared'),
      /feature\/shared/,
    )
    git(root, 'worktree', 'remove', '--', other)
    await removeWorktree(root, shared)

    const partial = join(root, 'partial')
    git(root, 'worktree', 'add', '-b', 'feature/partial', partial)
    const lock = join(root, '.git', 'refs', 'heads', 'feature', 'partial.lock')
    await writeFile(lock, '', 'utf8')
    const result = await removeWorktree(root, partial)
    assert.match(
      result.warning ?? '',
      /폴더는 삭제되었지만 로컬 브랜치 feature\/partial/,
    )
    assert.equal(await stat(partial).catch(() => null), null)
    assert.match(
      git(root, 'branch', '--list', 'feature/partial'),
      /feature\/partial/,
    )
    await rm(lock)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('브랜치 변경 후 실제 브랜치를 삭제하고 Git 연결이 끊어진 작업은 파일·브랜치를 보존한다', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lite-worktree-recovery-')))
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', windowsHide: true,
  })
  try {
    git(root, 'init', '--initial-branch=main')
    await writeFile(join(root, 'file.txt'), 'base', 'utf8')
    git(root, 'add', '.')
    git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'base')
    const tree = join(root, 'switched')
    git(root, 'worktree', 'add', '-b', 'task/original', tree)
    git(tree, 'switch', '-c', 'dev')
    assert.deepEqual(await inspectWorktreeDeletion(root, tree), {
      localOnly: false, branch: 'dev', totalChanges: 0,
    })
    await assert.rejects(removeWorktree(root, tree, [], true, true), /다시 연결/)
    await removeWorktree(root, tree)
    assert.equal(git(root, 'branch', '--list', 'dev').trim(), '')
    assert.match(git(root, 'branch', '--list', 'task/original'), /task\/original/)

    // Git 등록과 .git이 모두 사라진 상태에서도 로컬 기록 정리를 재시도할 수 있습니다.
    await mkdir(tree)
    await writeFile(join(tree, 'keep.txt'), '남은 파일', 'utf8')
    await assert.rejects(requireLinkedWorktree(tree), /Git 연결이 끊어/)
    assert.equal((await inspectRepository(tree)).isGitRepository, false)
    assert.deepEqual(await inspectWorktreeDeletion(root, tree), {
      localOnly: true, branch: null, totalChanges: 0,
    })
    await assert.rejects(removeWorktree(root, tree), /등록된 Worktree/)
    assert.match((await removeWorktree(root, tree, [], false, true)).warning ?? '', /로컬 기록만/)
    assert.equal(await readFile(join(tree, 'keep.txt'), 'utf8'), '남은 파일')
    assert.match(git(root, 'branch', '--list', 'task/original'), /task\/original/)
    await assert.rejects(removeWorktree(root, root, [root], false, true), /기본 작업 공간/)
    await rm(tree, { recursive: true })
    await assert.rejects(requireLinkedWorktree(tree), /Git 연결이 끊어/)
    assert.equal((await inspectWorktreeDeletion(root, tree)).localOnly, true)
    await removeWorktree(root, tree, [], false, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


test('대괄호 파일의 diff는 해당 파일만 표시하고 점 두 개로 시작하는 새 파일도 읽는다', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lite-literal-diff-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true })
  git('init', '--initial-branch=main')
  for (const file of ['file[1].txt', 'file1.txt']) await writeFile(join(root, file), 'before', 'utf8')
  git('add', '.')
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture')
  for (const file of ['file[1].txt', 'file1.txt']) await writeFile(join(root, file), 'after', 'utf8')
  const diff = await readDiff(root, 'file[1].txt')
  assert.match(diff, /file\[1\]\.txt/)
  assert.equal(diff.includes('file1.txt'), false)
  await writeFile(join(root, '..notes'), 'notes', 'utf8')
  assert.match(await readDiff(root, '..notes'), /\+notes/)
})

test('Worktree checkout 훅 실패와 시간 초과는 이번 폴더와 브랜치를 정리한다', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'lite-worktree-rollback-'))
  const root = join(parent, 'repo')
  await mkdir(root)
  t.after(() => rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true })
  git('init', '--initial-branch=main')
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'fixture')
  const hook = join(root, '.git', 'hooks', 'post-checkout')
  for (const [content, timeout] of [['#!/bin/sh\nexit 1\n', 5000], ['#!/bin/sh\nsleep 2\n', 500]] as const) {
    await writeFile(hook, content, { encoding: 'utf8', mode: 0o755 })
    await assert.rejects(createWorktree(root, 'feature/retry', 'HEAD', timeout))
    assert.equal((await inspectRepository(root)).worktrees.length, 1)
    assert.equal(git('branch', '--list', 'feature/retry').trim(), '')
  }
  await rm(hook)
  const tree = await createWorktree(root, 'feature/retry')
  await removeWorktree(root, tree.path)
})
