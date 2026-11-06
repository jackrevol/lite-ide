import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
    assert.ok(children[0].args.includes('--no-daemon'))
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
