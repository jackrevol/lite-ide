import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { IPty } from 'node-pty'
import { TerminalService, type PtyFactory } from './terminal-service.ts'
import type { TerminalEvent } from '../shared/types.ts'

test('터미널은 작업 경로당 하나이며 입력을 에코하지 않고 전환 시 이전 프로세스를 종료한다', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lite-terminal-'))
  const events: TerminalEvent[] = []
  const children: {
    send: (text: string) => void
    writes: string[]
    args: string[]
    killed: boolean
    size: number[]
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
    service.resize('one', 10000, 1)
    assert.deepEqual(children[1].size, [500, 5])
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
