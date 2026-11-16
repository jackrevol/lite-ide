import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentService } from './agent-service.ts'
import { AwakeService } from './awake-service.ts'

test('여러 에이전트 중 실행 중인 작업이 있을 때만 절전을 방지한다', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lite-awake-'))
  const calls: string[] = []
  const awake = new AwakeService({
    start: (type) => { calls.push(type); return 0 },
    stop: (id) => { assert.equal(id, 0); calls.push('stop') },
  })
  const service = new AgentService(join(directory, 'sessions.json'), () => {},
    undefined, undefined, undefined, undefined, (running) => awake.update(running))
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }) })
  await service.all()
  assert.deepEqual(calls, [])
  service.client.start = async () => {}
  service.client.request = async <T>(method: string, params: Record<string, unknown>) =>
    (method === 'thread/start' ? { thread: { id: params.cwd } } : { turn: { id: 'turn' } }) as T
  for (const id of ['one', 'two'])
    await service.send({ sessionId: id, workspace: join(directory, id), text: '작업' })
  assert.deepEqual(calls, ['prevent-display-sleep'])
  service.client.onMessage({ method: 'turn/completed', params: {
    threadId: join(directory, 'one'), turn: { id: 'turn', status: 'completed' },
  } })
  assert.deepEqual(calls, ['prevent-display-sleep'])
  service.client.onMessage({ method: 'thread/status/changed', params: {
    threadId: join(directory, 'two'), status: { type: 'active', activeFlags: ['waitingOnUserInput'] },
  } })
  assert.deepEqual(calls, ['prevent-display-sleep', 'stop'])
  service.client.onMessage({ method: 'thread/status/changed', params: {
    threadId: join(directory, 'two'), status: { type: 'active', activeFlags: [] },
  } })
  assert.deepEqual(calls, ['prevent-display-sleep', 'stop', 'prevent-display-sleep'])
  service.client.onMessage({ method: 'turn/completed', params: {
    threadId: join(directory, 'two'), turn: { id: 'turn', status: 'failed' },
  } })
  assert.equal(calls.at(-1), 'stop')
  await service.send({ sessionId: 'one', workspace: join(directory, 'one'), text: '다시 작업' })
  assert.equal(calls.at(-1), 'prevent-display-sleep')
  await service.close()
  assert.equal(calls.at(-1), 'stop')
  awake.close()
  awake.update(true)
  assert.equal(calls.at(-1), 'stop')
})
