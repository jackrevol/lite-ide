import assert from 'node:assert/strict'
import { appendFile, mkdtemp, writeFile } from 'node:fs/promises'
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

test('Worktree 하위 cwd와 다른 cwd의 활성 자식을 보호하고 완료한 계층은 함께 정리한다', async (t) => {
  const { service, child, notify } = await setup(t)
  const parent = (await service.all()).find((item) => item.id === 'parent')!
  const nested = await child('nested-cwd', {
    cwd: join(parent.workspace, 'subdir'),
  })
  let removed = false
  await assert.rejects(
    service.removeWorkspace(parent.workspace, async () => {
      removed = true
    }),
    /진행 중이거나 시작 중/,
  )
  notify('turn/completed', {
    threadId: nested.threadId,
    turn: { id: nested.turnId, status: 'completed' },
  })
  const external = await child('external-cwd', {
    cwd: join(parent.workspace, '..', 'other-workspace'),
  })
  await assert.rejects(
    service.removeWorkspace(parent.workspace, async () => {
      removed = true
    }),
    /진행 중이거나 시작 중/,
  )
  assert.equal(removed, false)
  notify('turn/completed', {
    threadId: external.threadId,
    turn: { id: external.turnId, status: 'completed' },
  })
  const result = await service.removeWorkspace(parent.workspace, async () => ({
    warning: '연결 브랜치 삭제 실패',
  }))
  assert.match(result.warning ?? '', /브랜치 삭제 실패/)
  assert.deepEqual(await service.all(), [])
})

test('Worktree 삭제 잠금은 하위 cwd 시작과 다른 cwd 자식의 개별 제어를 차단한다', async (t) => {
  const { service, child, notify } = await setup(t)
  const parent = (await service.all()).find((item) => item.id === 'parent')!
  const external = await child('external-cwd', {
    cwd: join(parent.workspace, '..', 'other-workspace'),
  })
  notify('turn/completed', {
    threadId: external.threadId,
    turn: { id: external.turnId, status: 'completed' },
  })
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const removal = service.removeWorkspace(parent.workspace, async () => {
    entered()
    await gate
  })
  try {
    await started
    await assert.rejects(
      service.send({
        sessionId: 'new-child',
        workspace: join(parent.workspace, 'subdir'),
        text: '새 작업',
      }),
      /삭제 중/,
    )
    await assert.rejects(
      service.sendSubagentMessage(external.id, '추가 지시'),
      /삭제 중/,
    )
    await assert.rejects(service.inspectSubagent(external.id), /삭제 중/)
  } finally {
    release()
    await removal
  }
})

test('자식 조회가 진행 중이면 Worktree 삭제를 거부하고 갱신된 활성 상태를 보존한다', async (t) => {
  const { service, child, notify } = await setup(t)
  const parent = (await service.all()).find((item) => item.id === 'parent')!
  const session = await child()
  notify('turn/completed', {
    threadId: session.threadId,
    turn: { id: session.turnId, status: 'completed' },
  })
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  service.client.request = async <T>() => {
    await gate
    return {
      thread: {
        id: session.threadId,
        status: { type: 'active', activeFlags: [] },
      },
    } as T
  }
  const inspection = service.inspectSubagent(session.id)
  try {
    await Promise.resolve()
    await Promise.resolve()
    await assert.rejects(
      service.removeWorkspace(parent.workspace, async () => {}),
      /진행 중이거나 시작 중/,
    )
  } finally {
    release()
    await inspection
  }
  assert.equal(session.status, 'running')
  await assert.rejects(
    service.removeWorkspace(parent.workspace, async () => {}),
    /진행 중이거나 시작 중/,
  )
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

test('CLI 세션과 순서가 섞인 자식 계층을 읽기 전용으로 발견하고 다른 Worktree는 제외한다', async (t) => {
  const { service, calls } = await setup(t)
  const workspace = (await service.all())[0].workspace
  const root = {
    id: 'cli-thread', cwd: workspace, source: 'cli', name: 'CLI 작업',
    updatedAt: 100, status: { type: 'notLoaded' },
    turns: [{ id: 'cli-turn', status: 'inProgress', items: [
      { id: 'cli-prompt', type: 'userMessage', content: [{ type: 'text', text: '분석해 주세요.' }] },
      { id: 'cli-reply', type: 'agentMessage', text: '분석 중입니다.' },
      { id: 'cli-command', type: 'commandExecution', command: 'npm test', aggregatedOutput: '검증 출력', status: 'inProgress' },
    ] }],
  }
  const child = {
    id: 'cli-child', cwd: join(workspace, '..', 'child-worktree'), parentThreadId: root.id,
    agentNickname: '조사 담당', agentRole: 'worker', updatedAt: 101,
    canAcceptDirectInput: true, status: { type: 'notLoaded' },
    turns: [{ id: 'child-turn', status: 'completed', items: [
      { id: 'child-answer', type: 'agentMessage', text: '조사 완료' },
    ] }],
  }
  const nested = {
    id: 'cli-nested', cwd: workspace,
    source: { subAgent: { thread_spawn: { parent_thread_id: child.id } } },
    status: { type: 'notLoaded' }, turns: [],
  }
  const threads = new Map([root, child, nested].map((item) => [item.id, item]))
  service.client.request = async <T>(method: string, params: Record<string, unknown>) => {
    calls.push({ method, params })
    if (method === 'thread/list') return { data: params.ancestorThreadId
      ? [nested, child, { id: 'unrelated-child', parentThreadId: 'other-root', cwd: workspace }]
      : [root, { ...root, id: 'other-worktree', cwd: join(workspace, '..', 'other') }], nextCursor: null } as T
    if (method === 'thread/read') return { thread: threads.get(String(params.threadId)) } as T
    throw new Error(`Unexpected method: ${method}`)
  }
  await service.observeWorkspace(workspace)
  await service.observeWorkspace(workspace)
  const sessions = await service.all()
  assert.equal(sessions.length, 4)
  const observed = sessions.find((item) => item.threadId === root.id)!
  assert.equal(observed.id, 'cli-cli-thread')
  assert.equal(observed.status, 'running')
  assert.equal(observed.updatedAt, 100_000)
  assert.deepEqual(observed.messages.map((item) => item.text), ['분석해 주세요.', '분석 중입니다.', 'npm test'])
  assert.equal(observed.messages[2].detail, '검증 출력')
  const observedChild = sessions.find((item) => item.threadId === child.id)!
  assert.equal(observedChild.parentSessionId, observed.id)
  assert.equal(observedChild.nickname, '조사 담당')
  assert.equal(observedChild.workspace, child.cwd)
  assert.equal(observedChild.status, 'completed')
  assert.equal(observedChild.messages[0].text, '조사 완료')
  assert.equal(sessions.find((item) => item.threadId === nested.id)!.parentSessionId, observedChild.id)
  assert.ok(sessions.filter((item) => item.id !== 'parent').every((item) => item.canAcceptDirectInput === false))
  assert.ok(calls.every((call) => call.method !== 'thread/resume'))
  assert.ok(calls.filter((call) => call.method === 'thread/read').every((call) => call.params.includeTurns === true))
  await service.inspectSubagent(observed.id)
  await assert.rejects(service.sendSubagentMessage(observedChild.id, '추가 지시'), /직접 지시/)
  await assert.rejects(service.send({ sessionId: observed.id, workspace, text: '직접 시작' }), /Codex 터미널/)
  await assert.rejects(service.interrupt(observedChild.id), /Codex 터미널/)
})

test('CLI 관측은 동시 조회를 합치고 페이지를 끝까지 읽으며 실패를 실행 실패로 바꾸지 않는다', async (t) => {
  const { service, calls } = await setup(t)
  const workspace = (await service.all())[0].workspace
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const root = {
    id: 'paged-cli', cwd: workspace, source: 'cli',
    status: { type: 'notLoaded' },
    turns: [{ id: 'turn', status: 'inProgress', items: [] }],
  }
  let fail = false
  service.client.request = async <T>(method: string, params: Record<string, unknown>) => {
    calls.push({ method, params })
    if (fail) throw new Error('관측 연결 실패')
    await gate
    if (method === 'thread/read') return { thread: root } as T
    if (params.ancestorThreadId) return { data: [] } as T
    return (params.cursor ? { data: [root] } : { data: [], nextCursor: 'second-page' }) as T
  }
  const first = service.observeWorkspace(workspace)
  const second = service.observeWorkspace(workspace)
  release()
  await Promise.all([first, second])
  assert.equal(calls.filter((call) => call.method === 'thread/list' && !call.params.ancestorThreadId).length, 2)
  const observed = (await service.all()).find((item) => item.threadId === root.id)!
  assert.equal(observed.status, 'running')
  fail = true
  await assert.rejects(service.observeWorkspace(workspace), /관측 연결 실패/)
  assert.equal(observed.status, 'running')
  assert.equal(observed.observationError, '관측 연결 실패')
  service.client.onDisconnect('관측 서버 종료')
  assert.equal(observed.status, 'running')
  assert.equal(observed.observationError, '관측 서버 종료')
  fail = false
  await service.observeWorkspace(workspace)
  assert.equal(observed.observationError, undefined)
})

test('저장한 CLI 계층은 재시작 후에도 resume하지 않고 read로 조회한다', async (t) => {
  const { service, file } = await setup(t)
  const workspace = (await service.all())[0].workspace
  const root = { id: 'stored-cli', cwd: workspace, source: 'cli', turns: [] }
  service.client.request = async <T>(method: string, params: Record<string, unknown>) => {
    if (method === 'thread/read') return { thread: root } as T
    return { data: params.ancestorThreadId ? [] : [root] } as T
  }
  await service.observeWorkspace(workspace)
  await service.close()
  const restored = new AgentService(file, () => {})
  t.after(() => restored.close())
  restored.client.start = async () => {}
  restored.client.stop = () => {}
  restored.client.request = async <T>(method: string) => {
    assert.equal(method, 'thread/read')
    return { thread: root } as T
  }
  await restored.inspectSubagent('cli-stored-cli')
  assert.equal((await restored.all()).find((item) => item.threadId === root.id)!.canAcceptDirectInput, false)
})

test('CLI 원본 rollout으로 진행 상태를 복구하고 부분 기록은 다음 조회까지 보존한다', async (t) => {
  const { service } = await setup(t)
  const workspace = (await service.all())[0].workspace
  const path = join(workspace, 'rollout.jsonl')
  const event = (type: string) => JSON.stringify({
    timestamp: '2026-11-06T15:00:00Z',
    type: 'event_msg', payload: { type, turn_id: 'live-cli-turn', text: '한글 기록' },
  })
  const completion = event('task_complete')
  await writeFile(path, `${event('task_started')}\ninvalid-json\n${completion.slice(0, -5)}`, 'utf8')
  const root = {
    id: 'live-cli', cwd: workspace, source: 'cli', path,
    status: { type: 'notLoaded' },
    turns: [{ id: 'live-cli-turn', status: 'interrupted', items: [] }],
  }
  service.client.request = async <T>(method: string, params: Record<string, unknown>) =>
    (method === 'thread/read' ? { thread: root }
      : { data: params.ancestorThreadId ? [] : [root] }) as T
  await service.observeWorkspace(workspace)
  const observed = (await service.all()).find((item) => item.threadId === root.id)!
  assert.equal(observed.status, 'running')
  assert.equal(observed.turnId, 'live-cli-turn')
  await appendFile(path, completion.slice(-5), 'utf8')
  await service.observeWorkspace(workspace)
  assert.equal(observed.status, 'running')
  await appendFile(path, '\n', 'utf8')
  await service.observeWorkspace(workspace)
  assert.equal(observed.status, 'completed')
  await appendFile(path, `${event('task_started')}\n${event('turn_aborted')}\n`, 'utf8')
  await service.observeWorkspace(workspace)
  assert.equal(observed.status, 'interrupted')
  // 로그가 회전하거나 잘려도 이전 파일의 상태를 재사용하지 않습니다.
  await writeFile(path, `${event('task_started')}\n`, 'utf8')
  await service.observeWorkspace(workspace)
  assert.equal(observed.status, 'running')
})

test('CLI 관측의 활성 상태와 조회 중 작업은 Worktree 삭제를 차단하지 않는다', async (t) => {
  const { service } = await setup(t)
  const workspace = (await service.all())[0].workspace
  const root = {
    id: 'external-running', cwd: workspace, source: 'cli',
    updatedAt: Date.now() / 1000 - 10,
    turns: [{ id: 'turn', status: 'inProgress', items: [] }],
  }
  service.client.request = async <T>(method: string, params: Record<string, unknown>) =>
    (method === 'thread/read' ? { thread: root }
      : { data: params.ancestorThreadId ? [] : [root] }) as T
  await service.observeWorkspace(workspace)
  const observed = (await service.all()).find((item) => item.threadId === root.id)!
  await service.terminalExited(workspace)
  assert.equal(observed.status, 'running')
  assert.match(observed.observationError!, /현재 실행 여부/)
  await service.inspectSubagent(observed.id)
  assert.match(observed.observationError!, /현재 실행 여부/)
  root.updatedAt = Date.now() / 1000 + 1
  await service.inspectSubagent(observed.id)
  assert.equal(observed.status, 'running')
  assert.equal(observed.observationError, undefined)

  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { entered = resolve })
  service.client.request = async <T>() => {
    entered()
    await gate
    return { thread: root } as T
  }
  const inspection = service.inspectSubagent(observed.id)
  await started
  let removed = false
  await service.removeWorkspace(workspace, async () => { removed = true })
  assert.equal(removed, true)
  assert.equal(observed.status, 'running')
  release()
  await inspection
  assert.deepEqual(await service.all(), [])
})

test('삭제와 경합한 CLI 목록 조회는 삭제 완료 후 세션을 다시 생성하지 않는다', async (t) => {
  const { service } = await setup(t)
  const workspace = (await service.all())[0].workspace
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { entered = resolve })
  service.client.request = async <T>(method: string) => {
    assert.equal(method, 'thread/list')
    entered()
    await gate
    return { data: [{ id: 'late-cli', cwd: workspace, source: 'cli' }] } as T
  }
  const observation = service.observeWorkspace(workspace)
  await started
  await service.removeWorkspace(workspace, async () => {})
  release()
  await observation
  assert.deepEqual(await service.all(), [])
})

test('CLI 자식 조회 도중 삭제되면 남은 자식 목록을 다시 연결하지 않는다', async (t) => {
  const { service } = await setup(t)
  const workspace = (await service.all())[0].workspace
  const root = { id: 'deleting-cli', cwd: workspace, source: 'cli', turns: [] }
  const children = ['child-a', 'child-b'].map((id) => ({
    id, cwd: workspace, parentThreadId: root.id, turns: [],
  }))
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { entered = resolve })
  service.client.request = async <T>(method: string, params: Record<string, unknown>) => {
    if (method === 'thread/list')
      return { data: params.ancestorThreadId ? children : [root] } as T
    if (params.threadId === root.id) return { thread: root } as T
    assert.equal(params.threadId, 'child-b')
    entered()
    await gate
    return { thread: children[1] } as T
  }
  const observation = service.observeWorkspace(workspace)
  await started
  await service.removeWorkspace(workspace, async () => {})
  release()
  await observation
  assert.deepEqual(await service.all(), [])
})
