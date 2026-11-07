import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ProcessService, descendantsOf, parsePs, type ProcessRecord, type TerminalProcessRoot } from './process-service.ts'

const root: TerminalProcessRoot = { taskId: 'task', generation: 'first', workspace: '/worktree', pid: 10 }
const row = (pid: number, ppid: number, identity = `start-${pid}`): ProcessRecord =>
  ({ pid, ppid, identity, startedAt: identity, command: `node ${pid}`, state: 'running' })
const target = (pid: number) => ({ ...root, pid, identity: `start-${pid}` })

test('자식 종료 요청 뒤 실제 프로세스가 사라질 때까지 기다린다', async () => {
  let stopping = false
  let checks = 0
  const service = new ProcessService(async () => {
    if (!stopping) return [row(10, 1), row(11, 10)]
    checks++
    return checks < 3 ? [row(10, 1), row(11, 1)] : [row(10, 1)]
  }, async () => { stopping = true })
  await service.register(root)
  await service.stopDescendants(root, () => [root])
  assert.ok(checks >= 3)
})

test('소유권 미확인과 자식 종료 오류를 삭제 성공으로 숨기지 않는다', async () => {
  const service = new ProcessService(async () => [row(10, 1), row(11, 10)], async () => { throw new Error('종료 거부') })
  await assert.rejects(service.stopDescendants(root, () => [root]), /소유권/)
  await service.register(root)
  await assert.rejects(service.stopDescendants(root, () => [root]), /종료 거부/)
})

test('프로세스 목록은 등록된 터미널 자손만 포함하고 다른 작업과 재사용 PID를 제외한다', async () => {
  let records = [row(10, 1), row(11, 10), row(12, 11), row(90, 1)]
  const service = new ProcessService(async () => records)
  await service.register(root)
  const snapshot = await service.inspect(root.workspace, [root])
  assert.deepEqual(snapshot.processes.map((process) => process.pid), [10, 11, 12])
  assert.equal(snapshot.processes[0].root, true)
  assert.equal(snapshot.processes[1].root, false)
  records = [row(10, 1, 'reused'), row(11, 10)]
  assert.equal((await service.inspect(root.workspace, [root])).processes.length, 0)
  await assert.rejects(service.stop(() => [root], target(10), async () => {}), /소유/)
})

test('프로세스 중단은 선택한 자손 트리를 말단부터 종료하고 PTY 루트와 형제를 유지한다', async () => {
  let records = [row(10, 1), row(11, 10), row(12, 11), row(13, 10), row(90, 1)]
  const killed: number[] = []
  const service = new ProcessService(async () => records, async (process) => {
    killed.push(process.pid)
    records = records.filter((record) => record.pid !== process.pid)
  })
  await service.register(root)
  await service.stop(() => [root], target(11), async () => { assert.fail('PTY 루트를 종료하면 안 됩니다.') })
  assert.deepEqual(killed, [12, 11])
  assert.deepEqual(records.map((process) => process.pid), [10, 13, 90])
})

test('PTY 루트 선택은 자손을 종료한 뒤 TerminalService 중단 경로를 호출한다', async () => {
  let records = [row(10, 1), row(11, 10)]
  const actions: string[] = []
  const service = new ProcessService(async () => records, async (process) => {
    actions.push(`kill:${process.pid}`)
    records = records.filter((record) => record.pid !== process.pid)
  })
  await service.register(root)
  await service.stop(() => [root], target(10), async () => { actions.push('terminal:stop') })
  assert.deepEqual(actions, ['kill:11', 'terminal:stop'])
})

test('다른 PID, 터미널 generation, 변경된 생성 시각은 종료할 수 없다', async () => {
  const records = [row(10, 1), row(11, 10), row(90, 1)]
  const service = new ProcessService(async () => records, async () => assert.fail('종료 호출 금지'))
  await service.register(root)
  await assert.rejects(service.stop(() => [root], target(90), async () => {}), /소유/)
  await assert.rejects(service.stop(() => [root], { ...target(11), generation: 'other' }, async () => {}), /터미널/)
  await assert.rejects(service.stop(() => [root], { ...target(11), identity: 'old' }, async () => {}), /소유/)
  await assert.rejects(service.stop(() => [root], { ...target(11), workspace: '/other' }, async () => {}), /터미널/)
})

test('목록 확인과 중단 사이에 재부모화되거나 PID가 재사용된 자손은 종료하지 않는다', async () => {
  let reads = 0
  const service = new ProcessService(async () => {
    reads++
    return reads <= 2
      ? [row(10, 1), row(11, 10), row(12, 11)]
      : [row(10, 1), row(11, 1), row(12, 11, 'reused')]
  }, async () => assert.fail('다른 소유자의 프로세스 종료 금지'))
  await service.register(root)
  await service.stop(() => [root], target(11), async () => {})
})

test('중단 중 터미널 generation이 변경되면 이후 프로세스에 신호를 보내지 않는다', async () => {
  let roots = [root]
  let records = [row(10, 1), row(11, 10), row(12, 11)]
  const killed: number[] = []
  const service = new ProcessService(async () => records, async (process) => {
    killed.push(process.pid)
    records = records.filter((record) => record.pid !== process.pid)
    roots = [{ ...root, generation: 'next' }]
  })
  await service.register(root)
  await assert.rejects(service.stop(() => roots, target(11), async () => {}), /터미널/)
  assert.deepEqual(killed, [12])
})

test('프로세스 조회 오류는 빈 성공으로 숨기지 않고 반환한다', async () => {
  const service = new ProcessService(async () => { throw new Error('denied') })
  const snapshot = await service.inspect(root.workspace, [root])
  assert.match(snapshot.error!, /denied/)
  assert.deepEqual(snapshot.processes, [])
})

test('macOS ps 출력은 생성 시각과 전체 명령을 파싱하며 순환 부모도 무한 탐색하지 않는다', () => {
  const records = parsePs('  10 1 Fri Nov  6 13:20:01 2026 Ss /bin/zsh -l\n  11 10 Fri Nov  6 13:20:02 2026 S node 작업.js --name hello world\n')
  assert.equal(records[0].identity, 'Fri Nov 6 13:20:01 2026')
  assert.equal(records[1].command, 'node 작업.js --name hello world')
  assert.deepEqual(descendantsOf(10, [row(10, 11), row(11, 10)]).map((process) => process.pid), [11])
})

test('부모보다 먼저 생성된 프로세스는 부모 PID가 같아도 현재 터미널 자손으로 취급하지 않는다', () => {
  const records = [
    row(10, 1, '2026-11-06T15:00:00.000Z'),
    row(11, 10, '2026-11-06T14:00:00.000Z'),
    row(12, 10, '2026-11-06T15:01:00.000Z'),
  ]
  assert.deepEqual(descendantsOf(10, records).map((process) => process.pid), [12])
})
