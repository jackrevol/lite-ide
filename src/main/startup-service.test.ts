import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout } from 'node:timers/promises'
import { StartupService } from './startup-service.ts'
import type { StartupSnapshot } from '../shared/types.ts'

const win = process.platform === 'win32'
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

test('스크립트 없는 작업은 즉시 시작하고 초기화 작업은 성공 기록 후에만 에이전트를 허용한다', async () => {
  const { root, workspace, file, service, events } = await fixture()
  try {
    assert.equal(await service.initialize(workspace, ''), null)
    await service.requireReady(workspace)
    const script = win
      ? "Write-Output '시작 한글'; Start-Sleep -Milliseconds 350; (Get-Location).Path | Set-Content -Encoding utf8 cwd.txt"
      : "printf '시작 한글\\n'; sleep 0.35; pwd > cwd.txt"
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
    await service.initialize(workspace, win ? "Write-Output '실패 로그'; exit 7" : "printf '실패 로그\\n'; exit 7")
    const failed = await finished(service, workspace)
    assert.equal(failed.status, 'failed')
    assert.equal(failed.exitCode, 7)
    await assert.rejects(service.requireReady(workspace), /성공적으로 완료/)
    const restarted = new StartupService(file, () => {})
    try {
      await restarted.ready()
      assert.equal(restarted.snapshot(workspace)?.status, 'stopped')
      await assert.rejects(restarted.requireReady(workspace), /성공적으로 완료/)
      assert.equal((await restarted.run(workspace, 'exit 0', true))?.status, 'stopped')
      await restarted.run(workspace, win ? "Write-Output '복구'" : "printf '복구\\n'")
      assert.equal((await finished(restarted, workspace)).status, 'completed')
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
      await service.initialize(workspace, script)
      // 동일 작업에서 자동 실행은 1회이므로 재시도는 명시적으로 요청합니다.
      if (service.snapshot(workspace)?.status !== 'running') await service.run(workspace, script)
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
    await service.initialize(workspace, win ? "Write-Output 'RUNNING'; Start-Sleep -Seconds 60" : "printf 'RUNNING\\n'; sleep 60")
    await service.stop(workspace)
    assert.equal(service.snapshot(workspace)?.status, 'stopped')
    await assert.rejects(service.requireReady(workspace), /성공적으로 완료/)
    await assert.rejects(service.removeWorkspace(workspace, async () => { throw new Error('삭제 실패') }), /삭제 실패/)
    const restarted = new StartupService(file, () => {})
    await assert.rejects(restarted.requireReady(workspace), /성공적으로 완료/)
    await restarted.close()
    await service.run(workspace, win ? 'Start-Sleep -Seconds 60' : 'sleep 60')
    await service.close()
    assert.equal(service.hasRunning(), false)
    await assert.rejects(service.run(workspace, 'exit 0'), /종료 중/)
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
    await Promise.all([service.initialize(workspace, 'exit 0'), service.initialize(second, 'exit 0')])
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
    await service.initialize(workspace, win
      ? "$child = Start-Process -FilePath powershell.exe -ArgumentList '-NoLogo -NoProfile -NonInteractive -Command Start-Sleep -Seconds 60' -WindowStyle Hidden -PassThru; Write-Output ('CHILD:' + $child.Id); Start-Sleep -Seconds 60"
      : 'sleep 60 &\necho CHILD:$!\nwait')
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
