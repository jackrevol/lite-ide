import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  parseStatus,
  parseWorktrees,
  createWorktree,
  removeWorktree,
  listBranches,
  requireLinkedWorktree,
  inspectWorktreeDeletion,
  inspectRepository,
} from './git.ts'
import { validateCloneInput } from './clone.ts'
import { execFileSync } from 'node:child_process'
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  rm,
  realpath,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
