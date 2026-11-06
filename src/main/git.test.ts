import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createWorktree, listBranches, parseStatus, parseWorktrees, requireLinkedWorktree,
} from './git.ts'
import { validateCloneInput } from './clone.ts'

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

test('Worktree는 선택한 로컬·원격 브랜치 또는 HEAD 커밋에서 생성된다', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'lite-ide-branches-'))
  const project = join(fixture, '한글 project')
  const git = (...args: string[]) => execFileSync('git', [
    '-C', project, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args,
  ], { encoding: 'utf8', windowsHide: true }).trim()
  try {
    await mkdir(project)
    git('init', '--initial-branch=main')
    assert.deepEqual(await listBranches(project), [])
    await writeFile(join(project, 'file.txt'), 'main\n', 'utf8')
    git('add', '.')
    git('commit', '-m', 'main')
    const mainCommit = git('rev-parse', 'HEAD')
    await assert.rejects(requireLinkedWorktree(project), /전용 Worktree/)
    git('checkout', '-b', 'develop')
    await writeFile(join(project, 'file.txt'), 'develop\n', 'utf8')
    git('commit', '-am', 'develop')
    const developCommit = git('rev-parse', 'HEAD')
    git('update-ref', 'refs/remotes/origin/develop', developCommit)
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop')
    assert.deepEqual(await listBranches(project), [
      { name: 'develop', ref: 'refs/heads/develop' },
      { name: 'main', ref: 'refs/heads/main' },
      { name: 'origin/develop', ref: 'refs/remotes/origin/develop' },
    ])
    for (const [branch, base, commit] of [
      ['feature/from-main', 'refs/heads/main', mainCommit],
      ['feature/from-remote', 'refs/remotes/origin/develop', developCommit],
      ['feature/from-head', 'HEAD', developCommit],
    ]) {
      const created = await createWorktree(project, branch, base)
      assert.equal(created.branch, branch)
      await requireLinkedWorktree(created.path)
      assert.equal(execFileSync('git', ['-C', created.path, 'rev-parse', 'HEAD'], {
        encoding: 'utf8', windowsHide: true,
      }).trim(), commit)
    }
    // 존재하지 않거나 브랜치가 아닌 리비전은 새 브랜치를 만들기 전에 거부합니다.
    for (const base of ['', '--help', 'refs/heads/missing', 'HEAD~1', mainCommit]) {
      await assert.rejects(createWorktree(project, 'feature/invalid', base), /기준 브랜치/)
    }
    assert.equal(git('branch', '--list', 'feature/invalid'), '')
    git('branch', 'removed')
    assert.ok((await listBranches(project)).some((item) => item.name === 'removed'))
    git('branch', '-D', 'removed')
    await assert.rejects(createWorktree(project, 'feature/removed', 'refs/heads/removed'), /기준 브랜치/)
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})
