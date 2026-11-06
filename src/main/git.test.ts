import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  parseStatus,
  parseWorktrees,
  createWorktree,
  removeWorktree,
} from './git.ts'
import { validateCloneInput } from './clone.ts'
import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile, stat, rm, realpath } from 'node:fs/promises'
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

test('Worktree 삭제는 소속·기본 폴더·별도 프로젝트·변경 파일·잠금·무시 파일을 보호하고 브랜치를 보존한다', async () => {
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
    for (const name of ['untracked.txt', '.env']) {
      await writeFile(join(tree.path, name), '보존할 데이터\n', 'utf8')
      await assert.rejects(removeWorktree(directory, tree.path), /변경 파일/)
      assert.ok(await stat(join(tree.path, name)))
      await rm(join(tree.path, name))
    }
    git(directory, 'worktree', 'lock', tree.path)
    await assert.rejects(removeWorktree(directory, tree.path))
    git(directory, 'worktree', 'unlock', tree.path)
    await removeWorktree(directory, tree.path)
    assert.equal(await stat(tree.path).catch(() => null), null)
    assert.match(
      git(directory, 'branch', '--list', 'feature/delete-test'),
      /feature\/delete-test/,
    )
  } finally {
    // mkdtemp로 생성한 테스트 전용 폴더만 정리합니다.
    await rm(directory, { recursive: true, force: true })
    await rm(other, { recursive: true, force: true })
  }
})
