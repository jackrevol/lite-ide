import { mkdir, readFile, rename, writeFile, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pathKey } from './git.ts'
import { CodexClient, type RpcMessage } from './codex-client.ts'
import type {
  AgentMessage,
  AgentSession,
  CodexStatus,
  CodexUsage,
  RequestAnswer,
  SendMessage,
} from '../shared/types'

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
const string = (value: unknown) => (typeof value === 'string' ? value : '')
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

export class AgentService {
  readonly client = new CodexClient()
  private sessions = new Map<string, AgentSession>()
  private requests = new Map<string, RpcMessage>()
  private loaded: Promise<void>
  private saveQueue = Promise.resolve()
  private saveTimer?: NodeJS.Timeout
  private loadedThreads = new Set<string>()
  private busy = new Set<string>()
  private deletingWorkspaces = new Set<string>()
  private removalIntents = new Set<string>()
  private nextRequest = 0
  private file: string
  private emit: (session: AgentSession) => void
  private onUsageChanged: () => void

  constructor(
    file: string,
    emit: (session: AgentSession) => void,
    onDisconnect: (reason: string) => void = () => {},
    onUsageChanged: () => void = () => {},
  ) {
    this.file = file
    this.emit = emit
    this.onUsageChanged = onUsageChanged
    this.loaded = this.load()
    this.client.onMessage = (message) => this.handle(message)
    this.client.onDisconnect = (reason) => {
      onDisconnect(reason)
      this.loadedThreads.clear()
      this.requests.clear()
      for (const session of this.sessions.values()) {
        if (session.status === 'running' || session.status === 'waiting') {
          session.status = 'failed'
          session.error = reason
          session.requests = []
          this.publish(session)
        }
      }
    }
  }

  private async load() {
    try {
      const data: unknown = JSON.parse(await readFile(this.file, 'utf8'))
      this.removalIntents = new Set(
        list(record(data).removalIntents).filter(
          (item): item is string => typeof item === 'string',
        ),
      )
      for (const entry of list(
        Array.isArray(data) ? data : record(data).sessions,
      )) {
        const session = entry as AgentSession
        if (
          typeof session.id !== 'string' ||
          typeof session.workspace !== 'string' ||
          !Array.isArray(session.messages)
        )
          continue
        if (
          this.removalIntents.has(pathKey(session.workspace)) &&
          (await stat(session.workspace).then(
            () => false,
            (error: NodeJS.ErrnoException) =>
              ['ENOENT', 'ENOTDIR'].includes(error.code ?? ''),
          ))
        )
          continue
        if (session.status === 'running' || session.status === 'waiting')
          session.status = 'interrupted'
        session.requests = []
        this.sessions.set(session.id, session)
      }
    } catch {
      /* 첫 실행 또는 손상된 기록은 빈 세션 목록으로 복구합니다. */
    }
  }

  private persist() {
    const snapshot = JSON.stringify({
      sessions: [...this.sessions.values()],
      removalIntents: [...this.removalIntents],
    })
    this.saveQueue = this.saveQueue
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(this.file), { recursive: true })
        await writeFile(`${this.file}.tmp`, snapshot, 'utf8')
        await rename(`${this.file}.tmp`, this.file)
      })
    void this.saveQueue.catch((error: unknown) => {
      for (const session of this.sessions.values()) {
        session.error = `대화 저장 실패: ${error instanceof Error ? error.message : String(error)}`
        this.emit(session)
      }
    })
    return this.saveQueue
  }

  private publish(session: AgentSession) {
    session.updatedAt = Date.now()
    this.emit(session)
    if (!this.saveTimer)
      this.saveTimer = setTimeout(() => {
        this.saveTimer = undefined
        this.persist()
      }, 200)
  }

  async all() {
    await this.loaded
    return [...this.sessions.values()]
  }

  async status(): Promise<CodexStatus> {
    try {
      await this.client.start()
      const [account, catalog] = await Promise.all([
        this.client.request<{ account: unknown; requiresOpenaiAuth: boolean }>(
          'account/read',
          {},
        ),
        this.client.request<{ data: Record<string, unknown>[] }>('model/list', {
          limit: 100,
        }),
      ])
      return {
        connected: true,
        authenticated: !!account.account || !account.requiresOpenaiAuth,
        models: catalog.data
          .filter((model) => !model.hidden)
          .map((model) => ({
            id: string(model.model),
            name: string(model.displayName),
            isDefault: model.isDefault === true,
            efforts: list(model.supportedReasoningEfforts).map((effort) =>
              string(record(effort).reasoningEffort),
            ),
            defaultEffort: string(model.defaultReasoningEffort),
          })),
      }
    } catch (error) {
      return {
        connected: false,
        authenticated: false,
        models: [],
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async login() {
    await this.client.start()
    return this.client.request<{ authUrl: string }>('account/login/start', {
      type: 'chatgpt',
    })
  }

  async usage(): Promise<CodexUsage> {
    await this.client.start()
    return this.client.request<CodexUsage>('account/rateLimits/read', {
      excludeResetCreditDetails: false,
    })
  }

  async send(input: SendMessage) {
    await this.loaded
    if (this.deletingWorkspaces.has(pathKey(input.workspace)))
      throw new Error('삭제 중인 Worktree에서는 작업을 시작할 수 없습니다.')
    if (
      typeof input.sessionId !== 'string' ||
      !/^[\w-]{1,100}$/.test(input.sessionId) ||
      typeof input.text !== 'string' ||
      !input.text.trim() ||
      input.text.length > 200_000 ||
      (input.title !== undefined && typeof input.title !== 'string')
    )
      throw new Error('올바른 작업 내용을 입력해 주세요.')
    if (this.busy.has(input.sessionId))
      throw new Error('이미 작업을 시작하고 있습니다.')
    const previous = this.sessions.get(input.sessionId)
    if (previous && pathKey(previous.workspace) !== pathKey(input.workspace))
      throw new Error('작업의 프로젝트 경로가 일치하지 않습니다.')
    if (previous && ['running', 'waiting'].includes(previous.status))
      throw new Error('진행 중인 작업을 먼저 중단해 주세요.')
    this.busy.add(input.sessionId)
    const session: AgentSession = previous ?? {
      id: input.sessionId,
      workspace: input.workspace,
      title:
        input.title?.trim().slice(0, 100) ||
        input.text.trim().split('\n')[0].slice(0, 60),
      status: 'idle',
      messages: [],
      requests: [],
      updatedAt: Date.now(),
    }
    this.sessions.set(session.id, session)
    session.status = 'running'
    session.error = undefined
    session.requests = []
    session.turnId = undefined
    session.messages.push({
      id: crypto.randomUUID(),
      kind: 'user',
      text: input.text,
    })
    this.publish(session)
    try {
      await this.client.start()
      if (!session.threadId || !this.loadedThreads.has(session.threadId)) {
        const result = await this.client.request<{ thread: { id: string } }>(
          session.threadId ? 'thread/resume' : 'thread/start',
          {
            ...(session.threadId
              ? { threadId: session.threadId, excludeTurns: true }
              : {}),
            cwd: input.workspace,
            model: input.model || null,
            sandbox: 'workspace-write',
            approvalPolicy: 'on-request',
            approvalsReviewer: 'user',
          },
        )
        session.threadId = result.thread.id
        this.loadedThreads.add(result.thread.id)
      }
      const result = await this.client.request<{ turn: { id: string } }>(
        'turn/start',
        {
          threadId: session.threadId,
          input: [{ type: 'text', text: input.text, text_elements: [] }],
          ...(input.model ? { model: input.model } : {}),
          ...(input.effort ? { effort: input.effort } : {}),
        },
      )
      session.turnId = result.turn.id
      this.publish(session)
    } catch (error) {
      session.status = 'failed'
      session.error = error instanceof Error ? error.message : String(error)
      this.publish(session)
      throw error
    } finally {
      this.busy.delete(input.sessionId)
    }
  }

  async interrupt(id: string) {
    const session = this.sessions.get(id)
    if (!session?.threadId || !session.turnId)
      throw new Error('작업을 시작하는 중입니다. 잠시 후 다시 중단해 주세요.')
    await this.client.request('turn/interrupt', {
      threadId: session.threadId,
      turnId: session.turnId,
    })
  }

  async rename(id: string, title: string) {
    await this.loaded
    const session = this.sessions.get(id)
    if (!session || typeof title !== 'string' || !title.trim())
      throw new Error('작업 이름을 입력해 주세요.')
    session.title = title.trim().slice(0, 100)
    this.publish(session)
  }

  async delete(id: string) {
    await this.loaded
    const session = this.sessions.get(id)
    if (
      this.busy.has(id) ||
      (session && ['running', 'waiting'].includes(session.status))
    )
      throw new Error('실행 중인 작업은 삭제할 수 없습니다.')
    this.sessions.delete(id)
    await this.persist()
  }

  async removeWorkspace(workspace: string, remove: () => Promise<void>) {
    await this.loaded
    const key = pathKey(workspace)
    if (this.deletingWorkspaces.has(key))
      throw new Error('이미 Worktree를 삭제하고 있습니다.')
    const sessions = [...this.sessions.values()].filter(
      (item) => pathKey(item.workspace) === key,
    )
    if (
      sessions.some(
        (item) =>
          this.busy.has(item.id) ||
          ['running', 'waiting'].includes(item.status),
      )
    )
      throw new Error('진행 중이거나 시작 중인 작업을 먼저 중단해 주세요.')
    this.deletingWorkspaces.add(key)
    try {
      // 삭제 의도를 먼저 저장하여 폴더 삭제 후 저장 실패 시에도 관련 대화만 정리합니다.
      this.removalIntents.add(key)
      try {
        await this.persist()
        await remove()
      } catch (error) {
        this.removalIntents.delete(key)
        await this.persist().catch(() => {})
        throw error
      }
      for (const session of sessions) {
        this.sessions.delete(session.id)
        if (session.threadId) this.loadedThreads.delete(session.threadId)
      }
      this.removalIntents.delete(key)
      try {
        await this.persist()
        return {}
      } catch {
        return {
          warning:
            'Worktree 삭제는 완료되었지만 대화 기록 파일을 저장하지 못했습니다. 앱을 종료하기 전에 저장 공간과 권한을 확인해 주세요.',
        }
      }
    } finally {
      this.deletingWorkspaces.delete(key)
    }
  }

  answer(sessionId: string, requestId: string, answer: RequestAnswer) {
    const session = this.sessions.get(sessionId)
    const request = this.requests.get(requestId)
    if (
      !session ||
      !request ||
      !session.requests.some((item) => item.id === requestId)
    )
      throw new Error('이미 처리된 요청입니다.')
    let result: object
    if (request.method === 'item/tool/requestUserInput') {
      const answers: Record<string, { answers: string[] }> = {}
      for (const question of list(request.params?.questions)) {
        const id = string(record(question).id)
        if (!answer.answers?.[id]?.trim())
          throw new Error('모든 질문에 답변해 주세요.')
        answers[id] = { answers: [answer.answers[id]] }
      }
      result = { answers }
    } else if (request.method === 'item/permissions/requestApproval') {
      const requested = record(request.params?.permissions)
      result = {
        permissions:
          answer.approved === true
            ? {
                ...(requested.network ? { network: requested.network } : {}),
                ...(requested.fileSystem
                  ? { fileSystem: requested.fileSystem }
                  : {}),
              }
            : {},
        scope: 'turn',
      }
    } else
      result = { decision: answer.approved === true ? 'accept' : 'decline' }
    this.client.write({ id: request.id, result })
    this.requests.delete(requestId)
    session.requests = session.requests.filter((item) => item.id !== requestId)
    session.status = session.requests.length ? 'waiting' : 'running'
    this.publish(session)
  }

  private handle(message: RpcMessage) {
    if (
      message.method === 'account/rateLimits/updated' ||
      message.method === 'account/updated'
    ) {
      // 갱신 알림은 일부 값만 포함하므로 전체 한도를 다시 조회합니다.
      this.onUsageChanged()
      return
    }
    const params = message.params ?? {}
    const threadId = string(params.threadId)
    const session = [...this.sessions.values()].find(
      (item) => item.threadId === threadId,
    )
    if (message.id !== undefined && message.method) {
      if (
        session &&
        [
          'item/commandExecution/requestApproval',
          'item/fileChange/requestApproval',
          'item/tool/requestUserInput',
          'item/permissions/requestApproval',
        ].includes(message.method)
      ) {
        const id = String(++this.nextRequest)
        this.requests.set(id, message)
        session.requests.push({
          id,
          kind:
            message.method === 'item/tool/requestUserInput'
              ? 'questions'
              : 'approval',
          title:
            message.method === 'item/fileChange/requestApproval'
              ? '파일 변경 승인'
              : message.method === 'item/tool/requestUserInput'
                ? 'Codex의 질문'
                : message.method === 'item/permissions/requestApproval'
                  ? '추가 권한 승인'
                  : '명령 실행 승인',
          detail: [
            string(params.reason),
            string(params.command),
            params.permissions
              ? JSON.stringify(params.permissions, null, 2)
              : '',
          ]
            .filter(Boolean)
            .join('\n'),
          questions: list(params.questions).map((item) => {
            const q = record(item)
            return {
              id: string(q.id),
              question: string(q.question),
              options: list(q.options).map((o) => ({
                label: string(record(o).label),
                description: string(record(o).description),
              })),
            }
          }),
        })
        session.status = 'waiting'
        this.publish(session)
      } else {
        // 지원하지 않는 요청은 명시적으로 반환하여 서버가 무기한 기다리지 않게 합니다.
        this.client.write({
          id: message.id,
          error: {
            code: -32601,
            message: `Unsupported client request: ${message.method}`,
          },
        })
      }
      return
    }
    if (!session) return
    if (message.method === 'turn/started') {
      session.turnId = string(record(params.turn).id)
      session.status = 'running'
    } else if (message.method === 'turn/completed') {
      const turn = record(params.turn)
      session.status =
        turn.status === 'failed'
          ? 'failed'
          : turn.status === 'interrupted'
            ? 'interrupted'
            : 'completed'
      session.error = string(record(turn.error).message) || undefined
      for (const request of session.requests) this.requests.delete(request.id)
      session.requests = []
    } else if (message.method === 'item/agentMessage/delta') {
      const id = string(params.itemId)
      let item = session.messages.find((entry) => entry.id === id)
      if (!item) {
        item = { id, kind: 'assistant', text: '' }
        session.messages.push(item)
      }
      item.text += string(params.delta)
    } else if (
      message.method === 'item/started' ||
      message.method === 'item/completed'
    ) {
      const item = this.normalizeItem(record(params.item))
      if (item) {
        const index = session.messages.findIndex(
          (entry) => entry.id === item.id,
        )
        if (index >= 0) session.messages[index] = item
        else session.messages.push(item)
      }
    } else if (message.method === 'item/commandExecution/outputDelta') {
      const item = session.messages.find((entry) => entry.id === params.itemId)
      if (item)
        item.detail = ((item.detail ?? '') + string(params.delta)).slice(
          -100_000,
        )
    } else if (message.method === 'error') {
      session.error = string(record(params.error).message)
    } else return
    this.publish(session)
  }

  private normalizeItem(
    item: Record<string, unknown>,
  ): AgentMessage | undefined {
    const id = string(item.id)
    const status = string(item.status)
    switch (item.type) {
      case 'agentMessage':
        return { id, kind: 'assistant', text: string(item.text) }
      case 'reasoning':
        return {
          id,
          kind: 'reasoning',
          text: list(item.summary).map(string).join('\n'),
        }
      case 'commandExecution':
        return {
          id,
          kind: 'command',
          text: string(item.command),
          detail: string(item.aggregatedOutput).slice(-100_000),
          status,
        }
      case 'fileChange':
        return {
          id,
          kind: 'files',
          text: list(item.changes)
            .map((c) => string(record(c).path))
            .join('\n'),
          status,
        }
      case 'mcpToolCall':
      case 'dynamicToolCall':
        return {
          id,
          kind: 'tool',
          text: `${string(item.server)} ${string(item.tool)}`.trim(),
          status,
        }
      case 'plan':
        return { id, kind: 'assistant', text: string(item.text) }
      default:
        return undefined
    }
  }

  async close() {
    this.client.stop()
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.persist()
    await this.saveQueue.catch(() => {})
  }
}
