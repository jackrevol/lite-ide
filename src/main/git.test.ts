import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  parseStatus,
  parseWorktrees,
  createWorktree,
  removeWorktree,
  listBranches,
  requireLinkedWorktree,
} from './git.ts'
import { validateCloneInput } from './clone.ts'
import { execFileSync } from 'node:child_process'
import {
  mkdtemp,
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
