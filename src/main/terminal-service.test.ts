import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { IPty } from 'node-pty'
import { TerminalService, type PtyFactory } from './terminal-service.ts'
import { ProcessService, type ProcessRecord } from './process-service.ts'
import type { TerminalEvent } from '../shared/types.ts'
import type { AttentionNotification } from './notification-service.ts'

test('선택하지 않은 Codex 터미널도 OSC9를 수신하고 셸 출력은 알리지 않는다', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lite-terminal-attention-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const sends: ((text: string) => void)[] = []
  const launches: string[][] = []
  const factory: PtyFactory = (_file, args) => {
    launches.push(args as string[])
    let exit = (_event: { exitCode: number }) => {}
    return { onData: (receive: (text: string) => void) => { sends.push(receive); return { dispose() {} } },
      onExit: (receive: typeof exit) => { exit = receive; return { dispose() {} } },
      write() {}, resize() {}, kill: () => exit({ exitCode: 0 }),
    } as unknown as IPty
  }
  const attention: AttentionNotification[] = []
  const events: TerminalEvent[] = []
  const service = new TerminalService(join(directory, 'resume.json'), (event) => events.push(event), factory, async () => '/codex',
    undefined, undefined, undefined, (event) => attention.push(event))
  t.after(() => service.close())
  const input = { taskId: 'one', workspace: join(directory, 'one'), kind: 'codex' as const, cols: 80, rows: 24 }
  await service.open(input)
  await service.open({ ...input, taskId: 'background', workspace: join(directory, 'background') })
  sends[1]('\x1b]9;Quest'); sends[1]('ion: reply?\x07')
  assert.equal(attention[0].taskId, 'background')
  assert.equal(attention[0].kind, 'question')
  assert.equal(service.snapshot('background')!.waitingForInput, true)
  assert.ok(events.some((event) => event.type === 'status' && event.taskId === 'background' && event.waitingForInput))
  assert.equal(service.snapshot('background')!.output, '\x1b]9;Question: reply?\x07')
  assert.doesNotThrow(() => structuredClone(service.snapshot('background')))
  assert.ok(launches[0].includes('tui.notifications=["approval-requested","plan-mode-prompt","async-question"]'))
  assert.ok(launches[0].includes('tui.notification_method="osc9"'))
  assert.ok(launches[0].includes('tui.notification_condition="always"'))
  await service.open({ ...input, kind: 'shell' })
  sends[2]('\x1b]9;Question: shell?\x07')
  assert.equal(attention.length, 1)
  service.write('background', '1')
  assert.equal(service.snapshot('background')!.waitingForInput, true)
  service.write('background', '\x1b[B')
  assert.equal(service.snapshot('background')!.waitingForInput, true)
  service.write('background', '\r')
  assert.equal(service.snapshot('background')!.waitingForInput, false)
  assert.ok(events.some((event) => event.type === 'status' && !event.waitingForInput))
  sends[1]('\x1b]9;Question: reply?\x07')
  assert.equal(attention.length, 2)
})

test('터미널은 작업 경로당 하나이며 입력을 에코하지 않고 전환 시 이전 프로세스를 종료한다', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lite-terminal-'))
  const events: TerminalEvent[] = []
  const children: {
    send: (text: string) => void
    writes: string[]
    args: string[]
    killed: boolean
    size: number[]
    resizeCalls: number
  }[] = []
  const factory: PtyFactory = (_file, args) => {
    let data: (text: string) => void = () => {}
    let exit: (event: { exitCode: number; signal?: number }) => void = () => {}
    const child = {
      send: (text: string) => data(text),
      writes: [] as string[],
      args: args as string[],
      killed: false,
      size: [] as number[],
      resizeCalls: 0,
    }
    children.push(child)
    return {
      onData: (callback: typeof data) => {
        data = callback
        return { dispose() {} }
      },
      onExit: (callback: typeof exit) => {
        exit = callback
        return { dispose() {} }
      },
      write: (text: string) => child.writes.push(text),
      resize: (cols: number, rows: number) => {
        child.size = [cols, rows]
        child.resizeCalls++
      },
      kill: () => {
        child.killed = true
        exit({ exitCode: 0 })
      },
    } as unknown as IPty
  }
  const service = new TerminalService(
    join(directory, 'resume.json'),
    (event) => events.push(event),
    factory,
    async () => '/codex',
  )
  const input = {
    taskId: 'one',
    workspace: directory,
    kind: 'codex' as const,
    cols: 90,
    rows: 30,
    model: 'model',
    effort: 'high',
    prompt: '첫 요청',
  }
  try {
    const [a, b] = await Promise.all([service.open(input), service.open(input)])
    assert.equal(a.generation, b.generation)
    assert.equal(children.length, 1)
    assert.ok(!children[0].args.includes('--no-daemon'))
    assert.ok(!children[0].args.includes('--no-alt-screen'))
    assert.ok(children[0].args.includes('tui.alternate_screen="always"'))
    assert.ok(children[0].args.includes('tui.fullscreen_transcript=true'))
    service.write('one', 'echo once\r')
    assert.deepEqual(children[0].writes, ['echo once\r'])
    assert.equal(events.length, 0)
    children[0].send('echo once\r\n')
    assert.equal(service.snapshot('one')?.output, 'echo once\r\n')
    assert.equal(service.snapshot('one')?.sequence, 1)
    await assert.rejects(
      service.open({ ...input, taskId: 'two' }),
      /이미 이 작업/,
    )
    await assert.rejects(
      service.open({ ...input, workspace: join(directory, 'other') }),
      /경로/,
    )
    const shell = await service.open({ ...input, kind: 'shell' })
    assert.equal(children[0].killed, true)
    assert.notEqual(shell.generation, a.generation)
    service.resize('one', input.cols, input.rows)
    assert.equal(children[1].resizeCalls, 0)
    service.resize('one', 10000, 1)
    assert.deepEqual(children[1].size, [500, 5])
    service.resize('one', 10000, 1)
    assert.equal(children[1].resizeCalls, 1)
    await service.open(input)
    assert.equal(children[1].killed, true)
    assert.ok(
      children[2].args.includes('resume') &&
        children[2].args.includes('--last'),
    )
    assert.ok(!children[2].args.includes('첫 요청'))
    assert.ok(children[2].args.includes('tui.fullscreen_transcript=true'))
    await assert.rejects(
      service.removeWorkspace(directory, async () => {
        await service.open(input)
        return 1
      }),
      /삭제 중/,
    )
    const removed = await service.removeWorkspace(directory, async () => 42)
    assert.equal(removed, 42)
    assert.equal(service.snapshot('one'), null)
    await service.close()
    assert.deepEqual(
      JSON.parse(await readFile(join(directory, 'resume.json'), 'utf8')),
      [],
    )
  } finally {
    await service.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('업데이트 후 선택하지 않은 작업까지 같은 Codex 세션으로 복원하고 첫 요청을 재전송하지 않는다', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lite-terminal-update-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'resume.json')
  const launches: { args: string[]; cwd: string }[] = []
  const factory: PtyFactory = (_file, args, options) => {
    launches.push({ args: args as string[], cwd: options!.cwd! })
    let exit = (_event: { exitCode: number }) => {}
    return {
      onData: () => ({ dispose() {} }),
      onExit: (callback: typeof exit) => { exit = callback; return { dispose() {} } },
      kill: () => exit({ exitCode: 0 }),
      write() {},
      resize() {},
    } as unknown as IPty
  }
  let created = 0
  const threads = new Map<string, string>()
  const interrupted: string[] = []
  const create = () => new TerminalService(file, () => {}, factory, async () => '/codex', async (input) => {
    if (!threads.has(input.workspace)) threads.set(input.workspace, `thread-${++created}`)
    return threads.get(input.workspace)!
  }, async (id) => { interrupted.push(id) })
  const service = create()
  const input = { taskId: 'first', workspace: join(directory, 'first'), kind: 'codex' as const, cols: 90, rows: 30, prompt: '첫 요청' }
  try {
    await service.open(input)
    await service.open({ ...input, taskId: 'background', workspace: join(directory, 'background') })
    await service.open({ ...input, taskId: 'stopped', workspace: join(directory, 'stopped') })
    await service.stop('stopped')
    assert.deepEqual(interrupted, ['thread-3'])
    service.resize('first', 120, 40)
    assert.equal(service.hasRunning(), true)
    await service.prepareForUpdate()
    assert.equal(service.hasRunning(), true)
    await service.close()
    assert.deepEqual(interrupted, ['thread-3'])
    const restored = create()
    try {
      const validated: string[] = []
      await restored.restoreAfterUpdate(async (path) => { validated.push(path) })
      assert.equal(restored.snapshot('first')?.running, true)
      assert.equal(restored.snapshot('background')?.running, true)
      assert.equal(restored.snapshot('stopped'), null)
      assert.equal(restored.snapshot('first')?.cols, 120)
      assert.deepEqual(validated, [input.workspace, join(directory, 'background')])
      assert.equal(created, 3)
      for (let index = 0; index < 2; index++) {
        const launch = launches[index + 3]
        assert.deepEqual(launch.args.slice(0, 2), ['resume', `thread-${index + 1}`])
        assert.ok(!launch.args.includes('--last'))
        assert.ok(!launch.args.includes('--no-daemon'))
        assert.ok(!launch.args.includes('첫 요청'))
      }
      assert.deepEqual(JSON.parse(await readFile(file + '.update.json', 'utf8')), [])
      await restored.prepareForUpdate()
      await restored.cancelUpdateRestore()
      assert.equal(await readFile(file + '.update.json', 'utf8').catch(() => null), null)
    } finally { await restored.close() }
  } finally { await service.close() }
})

test('복원할 작업 경로를 검증하고 실패한 세션만 다음 실행에 다시 연결한다', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lite-terminal-restore-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'resume.json')
  const input = { taskId: 'missing', workspace: directory, kind: 'codex', cols: 80, rows: 24 }
  await writeFile(file + '.update.json', JSON.stringify([input]), 'utf8')
  const service = new TerminalService(file, () => {}, () => { throw new Error('실행하면 안 됩니다.') })
  try {
    await service.restoreAfterUpdate(async () => { throw new Error('사용할 수 없는 경로') })
    assert.equal(service.hasRunning(), false)
    assert.deepEqual(JSON.parse(await readFile(file + '.update.json', 'utf8')), [input])
  } finally { await service.close() }
})

test('업데이트 복원은 Codex 자손을 보존하고 새 generation에 등록하며 명시적 중단은 세션부터 중단한다', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lite-terminal-process-restore-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'resume.json')
  let records: ProcessRecord[] = []
  let nextPid = 100
  const actions: string[] = []
  const record = (pid: number, ppid: number): ProcessRecord => ({
    pid, ppid, identity: `process-${pid}`, startedAt: `process-${pid}`,
    command: `codex ${pid}`, state: 'running',
  })
  const processes = new ProcessService(async () => records, async (process) => {
    actions.push(`descendant:${process.pid}`)
    records = records.filter((row) => row.pid !== process.pid)
  })
  const factory: PtyFactory = () => {
    const pid = nextPid
    nextPid += 100
    records.push(record(pid, 1), record(pid + 1, pid))
    let exit = (_event: { exitCode: number }) => {}
    return {
      pid,
      onData: () => ({ dispose() {} }),
      onExit: (callback: typeof exit) => { exit = callback; return { dispose() {} } },
      kill: () => {
        actions.push(`pty:${pid}`)
        records = records.filter((row) => row.pid !== pid)
        exit({ exitCode: 0 })
      },
      write() {},
      resize() {},
    } as unknown as IPty
  }
  const create = () => new TerminalService(
    file, () => {}, factory, async () => '/codex', async () => 'same-thread',
    async (threadId) => { actions.push(`interrupt:${threadId}`) }, processes,
  )
  const service = create()
  const input = { taskId: 'restored', workspace: directory, kind: 'codex' as const, cols: 80, rows: 24 }
  let restored: TerminalService | undefined
  try {
    const before = await service.open(input)
    const oldRoot = (await service.inspectProcesses(directory)).processes.find((row) => row.root)!
    assert.deepEqual((await service.inspectProcesses(directory)).processes.map((row) => row.pid), [100, 101])
    await service.prepareForUpdate()
    await service.close()
    assert.deepEqual(actions, ['pty:100'])
    assert.deepEqual((await processes.inspect(directory, [oldRoot])).processes, [])
    restored = create()
    await restored.restoreAfterUpdate(async () => {})
    const after = restored.snapshot(input.taskId)!
    assert.notEqual(after.generation, before.generation)
    const snapshot = await restored.inspectProcesses(directory)
    assert.deepEqual(snapshot.processes.map((row) => row.pid), [200, 201])
    await assert.rejects(restored.stopProcess(oldRoot), /터미널/)
    const newRoot = snapshot.processes.find((row) => row.root)!
    await assert.rejects(restored.stopProcess({ ...newRoot, identity: 'old-identity' }), /소유/)
    assert.deepEqual(actions, ['pty:100'])
    await restored.stopProcess(newRoot)
    assert.deepEqual(actions, ['pty:100', 'interrupt:same-thread', 'descendant:201', 'pty:200'])
    assert.equal(restored.snapshot(input.taskId)?.running, false)
    assert.deepEqual((await restored.inspectProcesses(directory)).processes, [])
  } finally {
    await restored?.close()
    await service.close()
  }
})

test('세션 중단을 기다리는 동안 PTY가 먼저 종료되어도 중복 종료하지 않는다', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lite-terminal-interrupt-exit-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let exit = (_event: { exitCode: number }) => {}
  let kills = 0
  const factory: PtyFactory = () => ({
    onData: () => ({ dispose() {} }),
    onExit: (callback: typeof exit) => { exit = callback; return { dispose() {} } },
    kill: () => { kills++; exit({ exitCode: 0 }) },
    write() {},
    resize() {},
  } as unknown as IPty)
  const service = new TerminalService(
    join(directory, 'resume.json'), () => {}, factory, async () => '/codex',
    async () => 'thread', async () => { exit({ exitCode: 0 }) },
  )
  try {
    await service.open({ taskId: 'one', workspace: directory, kind: 'codex', cols: 80, rows: 24 })
    await service.stop('one')
    assert.equal(kills, 0)
    assert.equal(service.snapshot('one')?.running, false)
  } finally { await service.close() }
})
