import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout } from 'node:timers/promises'
import { StartupService } from './startup-service.ts'
import { findGitBash } from './startup-script.ts'
import type { StartupSnapshot } from '../shared/types.ts'

const win = process.platform === 'win32'
async function saveScript(workspace: string, content: string) {
  const directory = "scripts 한글 ' $ space"
  const path = `${directory}/startup.${win ? 'ps1' : 'sh'}`
  await mkdir(join(workspace, directory), { recursive: true })
  await writeFile(join(workspace, path), (win ? '\ufeff' : '') + content, 'utf8')
  return path
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'lite-ide-startup-'))
  const workspace = join(root, '한글 workspace')
  await mkdir(workspace)
  const file = join(root, 'startup.json')
  const events: StartupSnapshot[] = []
  const service = new StartupService(file, (snapshot) => events.push(snapshot))
  return { root, workspace, file, service, events }
}
async function finished(service: StartupService, workspace: string) {
  for (let index = 0; index < 300; index++) {
    const snapshot = service.snapshot(workspace)
    if (snapshot && snapshot.status !== 'running') return snapshot
    await setTimeout(30)
  }
  throw new Error('Startup 종료 대기 시간 초과')
}

test('없는 파일과 레포 밖 경로를 거부하고 파일 복구 후 재실행한다', async () => {
  const { root, workspace, service } = await fixture()
  const extension = win ? 'ps1' : 'sh'
  try {
    for (const path of [`missing.${extension}`, `../outside.${extension}`, join(root, `outside.${extension}`), 'echo unsafe']) {
      const result = await service.initialize(workspace, path)
      assert.equal(result?.status, 'failed')
      assert.ok(result?.error)
      await assert.rejects(service.requireReady(workspace), /성공적으로 완료/)
    }
    const path = await saveScript(workspace, 'exit 0')
    await service.run(workspace, path)
    assert.equal((await finished(service, workspace)).status, 'completed')
    await service.requireReady(workspace)
  } finally {
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('디렉터리와 Worktree 외부를 가리키는 링크를 실행하지 않는다', async () => {
  const { root, workspace, service } = await fixture()
  const extension = win ? 'ps1' : 'sh'
  try {
    const directory = `directory.${extension}`
    await mkdir(join(workspace, directory))
    assert.match((await service.initialize(workspace, directory))!.error!, /파일이 아닙니다/)
    const outside = join(root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, `startup.${extension}`), 'exit 0', 'utf8')
    await symlink(outside, join(workspace, 'linked'), win ? 'junction' : 'dir')
    assert.match((await service.run(workspace, `linked/startup.${extension}`))!.error!, /Worktree 안/)
  } finally {
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('각 Worktree의 파일과 스크립트 위치를 사용한다', async () => {
  const { root, workspace, service } = await fixture()
  const second = join(root, 'second')
  await mkdir(second)
  try {
    const path = await saveScript(workspace, win ? "Write-Output 'FIRST'; Write-Output $PSScriptRoot" : 'echo FIRST; echo "$0"')
    await saveScript(second, win ? "Write-Output 'SECOND'; Write-Output $PSScriptRoot" : 'echo SECOND; echo "$0"')
    await Promise.all([service.initialize(workspace, path), service.initialize(second, path)])
    const first = await finished(service, workspace)
    const other = await finished(service, second)
    assert.equal(first.status, 'completed', first.error ?? first.output)
    assert.equal(other.status, 'completed', other.error ?? other.output)
    assert.match(first.output, /FIRST/)
    assert.match(other.output, /SECOND/)
    assert.ok(first.output.includes(workspace))
    assert.ok(other.output.includes(second))
  } finally {
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('스크립트 없는 작업은 즉시 시작하고 초기화 작업은 성공 기록 후에만 에이전트를 허용한다', async () => {
  const { root, workspace, file, service, events } = await fixture()
  try {
    assert.equal(await service.initialize(workspace, ''), null)
    await service.requireReady(workspace)
    const script = await saveScript(workspace, win
      ? "Write-Output '시작 한글'; Start-Sleep -Milliseconds 350; (Get-Location).Path | Set-Content -Encoding utf8 cwd.txt"
      : "printf '시작 한글\\n'; sleep 0.35; pwd > cwd.txt")
    const first = await service.initialize(workspace, script)
    assert.equal(first?.status, 'running')
    await assert.rejects(service.requireReady(workspace), /성공적으로 완료/)
    await assert.rejects(service.requireReady(join(workspace, 'nested')), /성공적으로 완료/)
    await service.requireReady(workspace + '-other')
    const duplicate = await service.run(workspace, script)
    assert.equal(duplicate?.startedAt, first?.startedAt)
    const done = await finished(service, workspace)
    assert.equal(done.status, 'completed', done.error ?? done.output)
    assert.equal(done.exitCode, 0)
    assert.match(done.output, /시작 한글/)
    assert.ok((await readFile(join(workspace, 'cwd.txt'), 'utf8')).includes(workspace))
    await service.requireReady(workspace)
    assert.equal((await service.run(workspace, script, true))?.startedAt, first?.startedAt)
    const restarted = new StartupService(file, () => {})
    await restarted.requireReady(workspace)
    assert.equal(await restarted.run(workspace, script, true), null)
    assert.ok(events.at(-1)!.revision > first!.revision)
    await restarted.close()
  } finally {
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('초기화 실패·앱 복원 후 에이전트를 차단하고 명시적인 새 스크립트 재시도 후 해제한다', async () => {
  const { root, workspace, file, service } = await fixture()
  try {
    const path = await saveScript(workspace, win ? "Write-Output '실패 로그'; exit 7" : "printf '실패 로그\\n'; exit 7")
    await service.initialize(workspace, path)
    const failed = await finished(service, workspace)
    assert.equal(failed.status, 'failed')
    assert.equal(failed.exitCode, 7)
    await assert.rejects(service.requireReady(workspace), /성공적으로 완료/)
    const restarted = new StartupService(file, () => {})
    try {
      await restarted.ready()
      assert.equal(restarted.snapshot(workspace)?.status, 'stopped')
      await assert.rejects(restarted.requireReady(workspace), /성공적으로 완료/)
      assert.equal((await restarted.run(workspace, path, true))?.status, 'stopped')
      await saveScript(workspace, win ? "Write-Output '복구'" : "printf '복구\\n'")
      await restarted.run(workspace, path)
      assert.equal((await finished(restarted, workspace)).status, 'completed')
      assert.match(restarted.snapshot(workspace)!.output, /복구/)
      await restarted.requireReady(workspace)
    } finally { await restarted.close() }
  } finally {
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('셸 오류와 외부 명령 실패를 성공으로 처리하지 않는다', async () => {
  const { root, workspace, service } = await fixture()
  try {
    for (const script of win
      ? ["throw '초기화 오류'", 'cmd.exe /c exit 9']
      : ['unknown_lite_ide_command', 'false']) {
      const path = await saveScript(workspace, script)
      await service.initialize(workspace, path)
      // 동일 작업에서 자동 실행은 1회이므로 재시도는 명시적으로 요청합니다.
      if (service.snapshot(workspace)?.status !== 'running') await service.run(workspace, path)
      const failed = await finished(service, workspace)
      assert.equal(failed.status, 'failed')
      assert.doesNotMatch(failed.output, /#< CLIXML|<Objs Version=/)
      await assert.rejects(service.requireReady(workspace), /성공적으로 완료/)
    }
  } finally {
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('중지 및 삭제 실패 후 초기화 gate와 중복 방지를 유지하고 종료 시 실행을 정리한다', async () => {
  const { root, workspace, file, service } = await fixture()
  try {
    const path = await saveScript(workspace, win ? "Write-Output 'RUNNING'; Start-Sleep -Seconds 60" : "printf 'RUNNING\\n'; sleep 60")
    await service.initialize(workspace, path)
    await service.stop(workspace)
    assert.equal(service.snapshot(workspace)?.status, 'stopped')
    await assert.rejects(service.requireReady(workspace), /성공적으로 완료/)
    await assert.rejects(service.removeWorkspace(workspace, async () => { throw new Error('삭제 실패') }), /삭제 실패/)
    const restarted = new StartupService(file, () => {})
    await assert.rejects(restarted.requireReady(workspace), /성공적으로 완료/)
    await restarted.close()
    await service.run(workspace, path)
    await service.close()
    assert.equal(service.hasRunning(), false)
    await assert.rejects(service.run(workspace, path), /종료 중/)
  } finally {
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('서로 다른 Worktree의 동시 초기화와 빠른 완료 기록을 직렬 저장한다', async () => {
  const { root, workspace, file, service } = await fixture()
  const second = join(root, 'second')
  await mkdir(second)
  try {
    const firstPath = await saveScript(workspace, 'exit 0')
    const secondPath = await saveScript(second, 'exit 0')
    await Promise.all([service.initialize(workspace, firstPath), service.initialize(second, secondPath)])
    assert.equal((await finished(service, workspace)).status, 'completed')
    assert.equal((await finished(service, second)).status, 'completed')
    const restarted = new StartupService(file, () => {})
    await restarted.requireReady(workspace)
    await restarted.requireReady(second)
    await restarted.close()
  } finally {
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('중지 시 Startup이 시작한 자식 프로세스도 종료한다', async () => {
  const { root, workspace, service } = await fixture()
  let childId: number | undefined
  try {
    const path = await saveScript(workspace, win
      ? "$child = Start-Process -FilePath powershell.exe -ArgumentList '-NoLogo -NoProfile -NonInteractive -Command Start-Sleep -Seconds 60' -WindowStyle Hidden -PassThru; Write-Output ('CHILD:' + $child.Id); Start-Sleep -Seconds 60"
      : 'sleep 60 &\necho CHILD:$!\nwait')
    await service.initialize(workspace, path)
    for (let index = 0; index < 200; index++) {
      const match = service.snapshot(workspace)?.output.match(/CHILD:(\d+)/)
      if (match) { childId = Number(match[1]); break }
      await setTimeout(30)
    }
    assert.ok(childId, service.snapshot(workspace)?.output)
    await service.stop(workspace)
    assert.throws(() => process.kill(childId!, 0))
  } finally {
    if (childId) { try { process.kill(childId, 'SIGKILL') } catch {} }
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('Git Bash는 Git 설치 경로에서 찾고 Windows의 WSL bash를 선택하지 않는다', { skip: !win }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'lite-ide-git-bash-'))
  try {
    const system = join(root, 'system32')
    const git = join(root, 'custom Git 한글')
    await mkdir(system)
    await writeFile(join(system, 'bash.exe'), '', 'utf8')
    await assert.rejects(findGitBash({ Path: system }), /Git Bash가 필요/)
    await mkdir(join(git, 'cmd'), { recursive: true })
    await mkdir(join(git, 'bin'))
    await writeFile(join(git, 'cmd', 'git.exe'), '', 'utf8')
    await writeFile(join(git, 'bin', 'bash.exe'), '', 'utf8')
    assert.equal(await findGitBash({ Path: `${system};"${join(git, 'cmd')}"` }), join(git, 'bin', 'bash.exe'))
    assert.equal(await findGitBash({ LOCALAPPDATA: root, ProgramFiles: root }).catch(() => null), null)
    await mkdir(join(root, 'Git', 'usr', 'bin'), { recursive: true })
    await writeFile(join(root, 'Git', 'usr', 'bin', 'bash.exe'), '', 'utf8')
    assert.equal(await findGitBash({ ProgramFiles: root }), join(root, 'Git', 'usr', 'bin', 'bash.exe'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('.sh를 실행하고 Superset 원본·Worktree 경로로 파일을 복사하며 실패를 전달한다', async (t) => {
  if (win) {
    try { await findGitBash() }
    catch { t.skip('Git Bash가 설치된 Windows에서 실행합니다.'); return }
  }
  const { root, workspace, service } = await fixture()
  const project = join(root, "원본 ' $ project")
  const path = ".superset 한글 ' $/setup.sh"
  try {
    await mkdir(project)
    await mkdir(join(workspace, ".superset 한글 ' $"))
    await writeFile(join(project, 'source.txt'), '원본 파일', 'utf8')
    await writeFile(join(workspace, path), [
      '#!/usr/bin/env sh', 'set -eu',
      '[ "$PWD" = "$(cd "$SUPERSET_WORKSPACE_PATH" && pwd)" ]',
      '[ "$SUPERSET_WORKSPACE_NAME" = "한글 workspace" ]',
      'cp "$SUPERSET_ROOT_PATH/source.txt" "$SUPERSET_WORKSPACE_PATH/copied.txt"',
      'echo "한글 완료: $0"', '',
    ].join('\n'), 'utf8')
    await service.initialize(workspace, `./${path}`, project)
    const done = await finished(service, workspace)
    assert.equal(done.status, 'completed', done.error ?? done.output)
    assert.match(done.output, /한글 완료:/)
    assert.ok(done.output.includes(path))
    assert.equal(await readFile(join(workspace, 'copied.txt'), 'utf8'), '원본 파일')
    await service.requireReady(workspace)
    await writeFile(join(workspace, path), 'exit 7\n', 'utf8')
    await service.run(workspace, path, false, project)
    const failed = await finished(service, workspace)
    assert.equal(failed.exitCode, 7, failed.error ?? failed.output)
    await assert.rejects(service.requireReady(workspace), /성공적으로 완료/)
  } finally {
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('Git Bash로 CRLF 파일과 자식 스크립트를 수정 없이 실행한다', { skip: !win }, async (t) => {
  try { await findGitBash() }
  catch { t.skip('Git Bash가 설치된 Windows에서 실행합니다.'); return }
  const { root, workspace, service } = await fixture()
  const previous = process.env.SHELLOPTS
  delete process.env.SHELLOPTS
  const parent = '#!/usr/bin/env sh\r\nset -eu\r\n./child.sh\r\n'
  const child = '#!/usr/bin/env sh\r\nset -eu\r\necho CRLF_CHILD_OK\r\n'
  try {
    await writeFile(join(workspace, 'setup.sh'), parent, 'utf8')
    await writeFile(join(workspace, 'child.sh'), child, 'utf8')
    await service.initialize(workspace, 'setup.sh')
    const result = await finished(service, workspace)
    assert.equal(result.status, 'completed', result.error ?? result.output)
    assert.match(result.output, /CRLF_CHILD_OK/)
    await service.requireReady(workspace)
    assert.equal(await readFile(join(workspace, 'setup.sh'), 'utf8'), parent)
    assert.equal(await readFile(join(workspace, 'child.sh'), 'utf8'), child)
  } finally {
    if (previous === undefined) delete process.env.SHELLOPTS
    else process.env.SHELLOPTS = previous
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('Git Bash Startup 중지 시 자식 프로세스도 종료한다', { skip: !win }, async (t) => {
  try { await findGitBash() }
  catch { t.skip('Git Bash가 설치된 Windows에서 실행합니다.'); return }
  const { root, workspace, service } = await fixture()
  let childId: number | undefined
  try {
    await writeFile(join(workspace, 'setup.sh'), `node -e 'console.log("CHILD:" + process.pid); setInterval(() => {}, 1000)'\n`, 'utf8')
    await service.initialize(workspace, 'setup.sh')
    for (let index = 0; index < 200; index++) {
      const match = service.snapshot(workspace)?.output.match(/CHILD:(\d+)/)
      if (match) { childId = Number(match[1]); break }
      await setTimeout(30)
    }
    assert.ok(childId, service.snapshot(workspace)?.output)
    await service.stop(workspace)
    assert.equal(service.snapshot(workspace)?.status, 'stopped')
    assert.throws(() => process.kill(childId!, 0))
    await assert.rejects(service.requireReady(workspace), /성공적으로 완료/)
  } finally {
    if (childId) { try { process.kill(childId, 'SIGKILL') } catch {} }
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
})
