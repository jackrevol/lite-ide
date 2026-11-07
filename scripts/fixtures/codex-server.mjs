import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const threads = new Map()
const notify = (method, params) => {
  const thread = threads.get(params.threadId)
  if (thread) {
    if (method === 'turn/started') {
      thread.status = { type: 'active', activeFlags: [] }
      thread.turns.push({ ...params.turn, status: 'inProgress', items: [] })
    } else if (method === 'turn/completed') {
      Object.assign(thread.turns.at(-1), params.turn)
      thread.status = { type: 'idle' }
    } else if (method === 'item/started' || method === 'item/completed') {
      const items = thread.turns.at(-1).items
      const index = items.findIndex((item) => item.id === params.item.id)
      if (index < 0) items.push(params.item)
      else items[index] = params.item
    }
  }
  send({ method, params })
}
const pending = new Map()
const timers = new Map()
let turnNumber = 0
let usedPercent = 25
let failedFirstStart = false
const fixtureNow = Math.floor(Date.now() / 1000)
const usageSnapshot = () => ({
  limitId: 'codex',
  limitName: 'Codex',
  planType: 'pro',
  primary: {
    usedPercent,
    windowDurationMins: 300,
    resetsAt: fixtureNow + 7200,
  },
  secondary: {
    usedPercent: 60,
    windowDurationMins: 10080,
    resetsAt: fixtureNow + 172800,
  },
})
function finish(threadId, turnId, text, status = 'completed') {
  const id = randomUUID()
  notify('item/started', {
    threadId,
    item: { id, type: 'agentMessage', text: '' },
  })
  notify('item/agentMessage/delta', {
    threadId,
    itemId: id,
    delta: text.slice(0, 8),
  })
  setTimeout(() => {
    notify('item/agentMessage/delta', {
      threadId,
      itemId: id,
      delta: text.slice(8),
    })
    notify('item/completed', {
      threadId,
      item: { id, type: 'agentMessage', text },
    })
    notify('turn/completed', {
      threadId,
      turn: { id: turnId, status, error: null },
    })
  }, 80)
}
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  const p = message.params ?? {}
  const reply = (result) => send({ id: message.id, result })
  // 관찰을 위한 자식 스레드 재연결은 기존 실행 정책을 변경하지 않습니다.
  const observingSubagent =
    message.method === 'thread/resume' &&
    threads.has(p.threadId) &&
    Object.keys(p).length === 1
  if (
    !observingSubagent &&
    ['thread/start', 'thread/resume', 'turn/start'].includes(message.method) &&
    (p.approvalPolicy !== 'never' ||
      (message.method === 'turn/start'
        ? p.sandboxPolicy?.type !== 'dangerFullAccess'
        : p.sandbox !== 'danger-full-access'))
  ) {
    send({
      id: message.id,
      error: { code: -32602, message: 'YOLO 정책이 적용되지 않았습니다.' },
    })
    return
  }
  if (!message.method) {
    const request = pending.get(message.id)
    if (request) {
      pending.delete(message.id)
      finish(
        request.threadId,
        request.turnId,
        message.result?.decision === 'decline'
          ? '실행을 거절했습니다.'
          : '요청을 처리했습니다.',
      )
    }
    return
  }
  switch (message.method) {
    case 'thread/list':
      if (process.env.LITE_IDE_FIXTURE_TAB_POLLING === '1') {
        if (!p.ancestorThreadId && p.cwd) {
          threads.set('polling-parent', { id: 'polling-parent', cwd: p.cwd, name: '주기적 관찰을 계속하는 부모 작업', updatedAt: fixtureNow, status: { type: 'active', activeFlags: [] }, turns: [{ id: 'polling-turn', status: 'inProgress', items: [
            { id: 'past-spawn', type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['polling-child'], agentsStates: { 'polling-child': { status: 'running' } } },
            { id: 'past-start', type: 'subAgentActivity', kind: 'started', agentThreadId: 'polling-child', agentPath: '과거 시작 이름' },
          ] }] })
          threads.set('polling-child', { id: 'polling-child', parentThreadId: 'polling-parent', cwd: p.cwd, agentNickname: '완료한 현재 검증 담당', updatedAt: fixtureNow + 1, status: { type: 'idle' }, turns: [{ id: 'polling-child-turn', status: 'completed', items: [] }] })
        }
        reply({ data: p.ancestorThreadId ? [threads.get('polling-child')].filter(Boolean) : [threads.get('polling-parent')].filter(Boolean), nextCursor: null })
      } else reply({ data: [], nextCursor: null })
      break
    case 'initialize':
      reply({ userAgent: 'fixture' })
      break
    case 'account/read':
      reply({ account: { type: 'chatgpt' }, requiresOpenaiAuth: true })
      break
    case 'account/rateLimits/read': {
      const scenario = process.env.LITE_IDE_FIXTURE_USAGE
      if (scenario === 'error') {
        send({
          id: message.id,
          error: { code: -32000, message: '사용량 조회 테스트 오류' },
        })
        break
      }
      const rateLimits =
        scenario === 'empty'
          ? { ...usageSnapshot(), primary: null, secondary: null }
          : usageSnapshot()
      reply({
        rateLimits,
        rateLimitsByLimitId: { codex: rateLimits },
        rateLimitResetCredits:
          scenario === 'empty'
            ? null
            : {
                availableCount: scenario === 'zero' ? 0 : 3,
                credits:
                  scenario === 'partial'
                    ? null
                    : scenario === 'zero'
                      ? []
                      : [
                          {
                            id: 'later',
                            status: 'available',
                            grantedAt: fixtureNow - 86400,
                            expiresAt: fixtureNow + 864000,
                            title: '나중에 만료',
                          },
                          {
                            id: 'expired',
                            status: 'available',
                            grantedAt: fixtureNow - 86400,
                            expiresAt: fixtureNow - 30,
                            title: '만료됨',
                          },
                          {
                            id: 'nearest',
                            status: 'available',
                            grantedAt: fixtureNow - 86400,
                            expiresAt: fixtureNow + 86400,
                            title: '먼저 만료되는 초기화권',
                          },
                          {
                            id: 'used',
                            status: 'redeemed',
                            grantedAt: fixtureNow - 86400,
                            expiresAt: fixtureNow + 60,
                            title: '이미 사용됨',
                          },
                        ],
              },
      })
      break
    }
    case 'model/list':
      reply({
        data: [
          {
            model: 'fixture-model',
            displayName: 'Codex Test',
            isDefault: true,
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [
              { reasoningEffort: 'medium' },
              { reasoningEffort: 'high' },
            ],
          },
          {
            model: 'fixture-model-alt',
            displayName: 'Codex Alternate',
            isDefault: false,
            defaultReasoningEffort: 'low',
            supportedReasoningEfforts: [
              { reasoningEffort: 'low' },
              { reasoningEffort: 'high' },
            ],
          },
        ],
      })
      break
    case 'thread/start':
      reply({ thread: { id: randomUUID() } })
      break
    case 'thread/read':
    case 'thread/resume':
      reply({ thread: threads.get(p.threadId) ?? { id: p.threadId } })
      break
    case 'turn/start': {
      if (p.input[0].text === '시작 재시도 테스트' && !failedFirstStart) {
        failedFirstStart = true
        send({
          id: message.id,
          error: { code: -32000, message: '첫 시작 실패 테스트' },
        })
        break
      }
      usedPercent = Math.min(100, usedPercent + 5)
      notify('account/rateLimits/updated', { rateLimits: usageSnapshot() })
      const threadId = p.threadId,
        turnId = randomUUID(),
        text = p.input[0].text
      reply({ turn: { id: turnId } })
      notify('turn/started', { threadId, turn: { id: turnId } })
      if (threads.has(threadId))
        notify('item/completed', {
          threadId,
          item: {
            id: p.clientUserMessageId,
            type: 'userMessage',
            content: [{ type: 'text', text }],
          },
        })
      if (text === '서브에이전트 테스트') {
        for (const [nickname, role, task, state] of [
          ['구현 담당', 'worker', '로그인 화면 구현', 'running'],
          ['검증 담당', 'reviewer', '테스트 실행 승인 확인', 'waiting'],
          ['조사 담당', 'explorer', '프로젝트 구조 조사', 'completed'],
        ]) {
          const childId = randomUUID()
          const childTurn = randomUUID()
          const thread = {
            id: childId,
            parentThreadId: threadId,
            cwd: process.cwd(),
            agentNickname: nickname,
            agentRole: role,
            model: 'fixture-model',
            canAcceptDirectInput: true,
            preview: task,
            status: { type: 'active', activeFlags: [] },
            turns: [],
          }
          threads.set(childId, thread)
          notify('thread/started', { thread })
          notify('item/completed', {
            threadId,
            item: {
              id: randomUUID(),
              type: 'collabAgentToolCall',
              tool: 'spawnAgent',
              status: 'completed',
              senderThreadId: threadId,
              receiverThreadIds: [childId],
              prompt: task,
              model: 'fixture-model',
              agentsStates: { [childId]: { status: 'running', message: null } },
            },
          })
          notify('turn/started', { threadId: childId, turn: { id: childTurn } })
          notify('item/completed', {
            threadId: childId,
            item: {
              id: randomUUID(),
              type: 'userMessage',
              content: [{ type: 'text', text: task }],
            },
          })
          if (state === 'running') {
            notify('item/started', {
              threadId: childId,
              item: {
                id: randomUUID(),
                type: 'commandExecution',
                command: 'npm run typecheck',
                status: 'inProgress',
                aggregatedOutput: '타입 확인 중',
              },
            })
          } else if (state === 'waiting') {
            const id = `subagent-approval-${++turnNumber}`
            pending.set(id, { threadId: childId, turnId: childTurn })
            thread.status = {
              type: 'active',
              activeFlags: ['waitingOnApproval'],
            }
            send({
              id,
              method: 'item/commandExecution/requestApproval',
              params: {
                threadId: childId,
                turnId: childTurn,
                command: 'npm test',
                reason: '서브에이전트 테스트 실행',
              },
            })
          } else {
            finish(childId, childTurn, '프로젝트 구조 조사를 완료했습니다.')
          }
        }
        finish(threadId, turnId, '서브에이전트가 작업을 나누어 진행합니다.')
      } else if (text === '승인 요청' || text === '질문 요청') {
        const id = `request-${++turnNumber}`
        pending.set(id, { threadId, turnId })
        send({
          id,
          method:
            text === '질문 요청'
              ? 'item/tool/requestUserInput'
              : 'item/commandExecution/requestApproval',
          params: {
            threadId,
            turnId,
            reason: '테스트 명령 실행',
            command: 'git status',
            questions:
              text === '질문 요청'
                ? [
                    {
                      id: 'scope',
                      question: '어떤 범위로 진행할까요?',
                      options: [
                        {
                          label: '전체',
                          description: '전체 범위를 확인합니다.',
                        },
                      ],
                    },
                  ]
                : undefined,
          },
        })
      } else if (text === '연결 종료 테스트') {
        setTimeout(() => process.exit(1), 50)
      } else if (text === '중단 테스트') {
        timers.set(
          threadId,
          setTimeout(() => finish(threadId, turnId, '늦은 응답'), 60_000),
        )
      } else if (text === '오류 테스트') {
        notify('turn/completed', {
          threadId,
          turn: {
            id: turnId,
            status: 'failed',
            error: { message: '테스트 연결 오류' },
          },
        })
      } else {
        notify('item/completed', {
          threadId,
          item: {
            type: 'commandExecution',
            id: randomUUID(),
            command: 'git status --short',
            status: 'completed',
            aggregatedOutput: ' M hello.txt',
          },
        })
        finish(
          threadId,
          turnId,
          `작업을 완료했습니다.\n\n**${text}**\n\n${text === '모델 전달 확인' ? `model=${p.model}; effort=${p.effort}\n\n` : ''}\`\`\`typescript\nconst ready = true\n\`\`\``,
        )
      }
      break
    }
    case 'turn/steer': {
      const thread = threads.get(p.threadId)
      if (
        !thread ||
        thread.turns.at(-1)?.id !== p.expectedTurnId ||
        thread.turns.at(-1)?.status !== 'inProgress'
      ) {
        send({
          id: message.id,
          error: { message: '진행 중인 턴이 일치하지 않습니다.' },
        })
      } else {
        reply({ turnId: p.expectedTurnId })
        notify('item/completed', {
          threadId: p.threadId,
          item: {
            id: p.clientUserMessageId,
            type: 'userMessage',
            content: [{ type: 'text', text: p.input[0].text }],
          },
        })
        notify('item/completed', {
          threadId: p.threadId,
          item: {
            id: randomUUID(),
            type: 'agentMessage',
            text: `추가 지시를 받았습니다: ${p.input[0].text}`,
          },
        })
      }
      break
    }
    case 'turn/interrupt':
      clearTimeout(timers.get(p.threadId))
      reply({})
      notify('turn/completed', {
        threadId: p.threadId,
        turn: { id: p.turnId, status: 'interrupted', error: null },
      })
      break
  }
})
process.stdin.on('end', () => process.exit(0))
