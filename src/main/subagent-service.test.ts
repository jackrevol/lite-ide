import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { AgentService } from './agent-service.ts'
import type { AgentSession } from '../shared/types.ts'

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'lite-ide-agents-'))
  const file = join(directory, 'sessions.json')
  const parent: AgentSession = {
    id: 'parent',
    threadId: 'parent-thread',
    title: '부모 작업',
    workspace: directory,
    status: 'completed',
    messages: [],
    requests: [],
    updatedAt: Date.now(),
  }
  await writeFile(file, JSON.stringify([parent]), 'utf8')
  const service = new AgentService(file, () => {})
  await service.all()
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const threads = new Map<string, Record<string, unknown>>()
  service.client.start = async () => {}
  service.client.stop = () => {}
  service.client.write = (message) => {
    replies.push(message)
  }
  const replies: object[] = []
  service.client.request = async <T>(
    method: string,
    params: Record<string, unknown>,
  ) => {
    calls.push({ method, params })
    if (method === 'thread/resume')
      return {
        thread: structuredClone(
          threads.get(String(params.threadId)) ?? { id: params.threadId },
        ),
      } as T
    if (method === 'turn/start') return { turn: { id: 'followup-turn' } } as T
    return {} as T
  }
  const notify = (method: string, params: Record<string, unknown>) =>
    service.client.onMessage({ method, params })
  async function child(
    id = 'child-thread',
    overrides: Record<string, unknown> = {},
  ) {
    const thread = {
      id,
      parentThreadId: 'parent-thread',
      agentNickname: '구현 담당',
      agentRole: 'worker',
      model: 'codex-model',
      preview: '화면을 구현해 주세요.',
      canAcceptDirectInput: true,
      status: { type: 'active', activeFlags: [] },
      turns: [{ id: `${id}-turn`, status: 'inProgress', items: [] }],
      ...overrides,
    }
    threads.set(id, thread)
    notify('thread/started', { thread })
    await service.inspectSubagent(`subagent-${id}`)
    return (await service.all()).find((item) => item.threadId === id)!
  }
  t.after(() => service.close())
  return { service, calls, threads, replies, notify, child, file }
}

test('서브에이전트의 계층·메타데이터·실시간 명령 출력을 부모와 분리해 보관한다', async (t) => {
  const { service, child, notify } = await setup(t)
  const session = await child()
  assert.equal(session.parentSessionId, 'parent')
  assert.equal(session.title, '구현 담당')
  assert.equal(session.role, 'worker')
  assert.equal(session.model, 'codex-model')
  assert.equal(session.turnId, 'child-thread-turn')
  notify('item/started', {
    threadId: session.threadId,
    item: {
      id: 'command',
      type: 'commandExecution',
      command: 'npm test',
      status: 'inProgress',
    },
  })
  notify('item/commandExecution/outputDelta', {
    threadId: session.threadId,
    itemId: 'command',
    delta: '검증 중',
  })
  assert.equal(session.messages[0].detail, '검증 중')
  assert.equal(
    (await service.all()).find((item) => item.id === 'parent')!.messages.length,
    0,
  )
  notify('item/completed', {
    threadId: session.threadId,
    item: {
      id: 'spawn',
      type: 'subAgentActivity',
      kind: 'started',
      agentThreadId: 'nested',
      agentPath: '/구현/검토',
    },
  })
  await service.inspectSubagent('subagent-nested')
  assert.equal(
    (await service.all()).find((item) => item.threadId === 'nested')!
      .parentSessionId,
    session.id,
  )
})

test('기존 협업 도구 이벤트와 구버전 생성 정보를 중복 없이 추적한다', async (t) => {
  const { service, notify } = await setup(t)
  notify('item/completed', {
    threadId: 'parent-thread',
    item: {
      id: 'spawn',
      type: 'collabAgentToolCall',
      tool: 'spawnAgent',
      status: 'completed',
      receiverThreadIds: ['legacy'],
      prompt: '테스트 조사',
      agentsStates: { legacy: { status: 'running' } },
    },
  })
  await service.inspectSubagent('subagent-legacy')
  notify('thread/started', {
    thread: {
      id: 'legacy',
      agentNickname: '조사 담당',
      source: {
        subAgent: { thread_spawn: { parent_thread_id: 'parent-thread' } },
      },
    },
  })
  notify('item/completed', {
    threadId: 'parent-thread',
    item: {
      id: 'wait',
      type: 'collabAgentToolCall',
      tool: 'wait',
      receiverThreadIds: ['legacy'],
      agentsStates: { legacy: { status: 'completed', message: '조사 결과' } },
    },
  })
  const sessions = await service.all()
  assert.equal(sessions.length, 2)
  assert.equal(sessions[1].title, '조사 담당')
  assert.equal(sessions[1].task, '테스트 조사')
  assert.equal(sessions[1].status, 'completed')
  assert.equal(sessions[1].messages.at(-1)!.text, '조사 결과')
})

test('실행 중 추가 지시는 turn/steer로 전달하고 완료 후에는 같은 스레드에서 이어간다', async (t) => {
  const { service, child, calls, threads } = await setup(t)
  const session = await child()
  await service.sendSubagentMessage(session.id, '접근성도 확인해 주세요.')
  const steer = calls.find((call) => call.method === 'turn/steer')!
  assert.equal(steer.params.threadId, 'child-thread')
  assert.equal(steer.params.expectedTurnId, 'child-thread-turn')
  assert.equal(session.messages.at(-1)!.text, '접근성도 확인해 주세요.')
  threads.set('child-thread', {
    id: 'child-thread',
    status: { type: 'idle' },
    turns: [{ id: 'child-thread-turn', status: 'completed', items: [] }],
  })
  await service.sendSubagentMessage(session.id, '후속 작업')
  assert.equal(
    calls.find((call) => call.method === 'turn/start')!.params.threadId,
    'child-thread',
  )
  assert.equal(session.turnId, 'followup-turn')
})

test('자식의 승인·질문을 처리하고 미처리 요청이 있으면 추가 지시를 막는다', async (t) => {
  const { service, child, replies } = await setup(t)
  const session = await child()
  service.client.onMessage({
    id: 'approval',
    method: 'item/commandExecution/requestApproval',
    params: { threadId: session.threadId, command: 'npm test' },
  })
  assert.equal(session.status, 'waiting')
  await assert.rejects(
    service.sendSubagentMessage(session.id, '추가 작업'),
    /먼저 처리/,
  )
  service.answer(session.id, session.requests[0].id, { approved: true })
  assert.deepEqual(replies.at(-1), {
    id: 'approval',
    result: { decision: 'accept' },
  })
  assert.equal(session.status, 'running')
  service.client.onMessage({
    id: 23,
    method: 'item/tool/requestUserInput',
    params: {
      threadId: session.threadId,
      questions: [{ id: 'scope', question: '범위는?' }],
    },
  })
  service.answer(session.id, session.requests[0].id, {
    answers: { scope: '전체' },
  })
  assert.deepEqual(replies.at(-1), {
    id: 23,
    result: { answers: { scope: { answers: ['전체'] } } },
  })
})

test('개별 중단은 자식 턴에만 전달하고 실행 중인 자식이 있으면 부모 삭제를 막는다', async (t) => {
  const { service, child, calls, notify, threads } = await setup(t)
  const session = await child()
  await assert.rejects(service.delete('parent'), /실행 중/)
  await service.interrupt(session.id)
  assert.deepEqual(
    calls.find((call) => call.method === 'turn/interrupt')!.params,
    { threadId: 'child-thread', turnId: 'child-thread-turn' },
  )
  notify('turn/completed', {
    threadId: session.threadId,
    turn: { id: session.turnId, status: 'interrupted' },
  })
  threads.set('child-thread', {
    id: 'child-thread',
    status: { type: 'idle' },
    turns: [{ id: session.turnId, status: 'interrupted', items: [] }],
  })
  await service.delete('parent')
  assert.equal((await service.all()).length, 0)
})

test('조회 실패는 실행 실패로 바꾸지 않고, 조회 중 수신한 완료 상태와 응답을 보존한다', async (t) => {
  const { service, child, notify } = await setup(t)
  const session = await child()
  const updatedAt = session.updatedAt
  await service.inspectSubagent(session.id)
  assert.equal(session.updatedAt, updatedAt)
  service.client.request = async () => {
    throw new Error('조회 연결 오류')
  }
  await assert.rejects(service.inspectSubagent(session.id), /조회 연결 오류/)
  assert.equal(session.status, 'running')
  assert.equal(session.observationError, '조회 연결 오류')
  service.client.request = async <T>() => {
    notify('item/agentMessage/delta', {
      threadId: session.threadId,
      itemId: 'reply',
      delta: '실시간 완료 응답',
    })
    notify('turn/completed', {
      threadId: session.threadId,
      turn: { id: session.turnId, status: 'completed' },
    })
    return {
      thread: {
        status: { type: 'active', activeFlags: [] },
        turns: [
          {
            id: session.turnId,
            status: 'inProgress',
            items: [{ id: 'reply', type: 'agentMessage', text: '과거 응답' }],
          },
        ],
      },
    } as T
  }
  await service.inspectSubagent(session.id)
  assert.equal(session.status, 'completed')
  assert.equal(session.messages.at(-1)!.text, '실시간 완료 응답')
  assert.equal(session.observationError, undefined)
})

test('연결 종료 시 실행 중인 자식과 요청을 정리하고 완료한 부모 상태를 유지한다', async (t) => {
  const { service, child } = await setup(t)
  const session = await child()
  service.client.onMessage({
    id: 'approval',
    method: 'item/commandExecution/requestApproval',
    params: { threadId: session.threadId },
  })
  service.client.onDisconnect('연결 종료')
  assert.equal(session.status, 'failed')
  assert.equal(session.error, '연결 종료')
  assert.equal(session.requests.length, 0)
  assert.equal(
    (await service.all()).find((item) => item.id === 'parent')!.status,
    'completed',
  )
})

test('직접 입력 불가·종료된 에이전트의 제어를 제한하고 재시작 시 계층을 복원한다', async (t) => {
  const { service, child, notify, file } = await setup(t)
  const session = await child('restricted', { canAcceptDirectInput: false })
  await assert.rejects(
    service.sendSubagentMessage(session.id, '새 지시'),
    /직접 지시/,
  )
  notify('thread/closed', { threadId: session.threadId })
  assert.equal(session.closed, true)
  await assert.rejects(
    service.sendSubagentMessage(session.id, '재개'),
    /직접 지시/,
  )
  await child('active-child')
  await service.close()
  const restored = new AgentService(file, () => {})
  t.after(() => restored.close())
  const sessions = await restored.all()
  assert.equal(
    sessions.find((item) => item.threadId === 'active-child')!.status,
    'interrupted',
  )
  assert.equal(
    sessions.find((item) => item.threadId === 'active-child')!.parentSessionId,
    'parent',
  )
})
