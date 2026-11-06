import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const notify = (method, params) => send({ method, params })
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
    case 'thread/resume':
      reply({ thread: { id: p.threadId } })
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
      if (text === '승인 요청' || text === '질문 요청') {
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
