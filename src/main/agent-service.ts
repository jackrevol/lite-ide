import { mkdir, readFile, rename, writeFile, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pathKey, workspaceContains } from './git.ts'
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
  private deletingSessions = new Set<string>()
  private removalIntents = new Set<string>()
  private nextRequest = 0
  private inspections = new Map<string, Promise<void>>()
  private revisions = new Map<string, number>()
  private pendingUserMessages = new Map<
    string,
    { id: string; text: string }[]
  >()
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
        if (session.status === 'running' || session.status === 'waiting')
          session.status = 'interrupted'
        session.requests = []
        this.sessions.set(session.id, session)
      }
      for (const workspace of this.removalIntents) {
        const removed = await stat(workspace).then(
          () => false,
          (error: NodeJS.ErrnoException) =>
            ['ENOENT', 'ENOTDIR'].includes(error.code ?? ''),
        )
        if (!removed) continue
        const roots = [...this.sessions.values()].filter((item) =>
          workspaceContains(workspace, item.workspace),
        )
        for (const parent of roots) {
          for (const child of this.descendants(parent.id))
            this.sessions.delete(child.id)
          this.sessions.delete(parent.id)
        }
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

  private publish(session: AgentSession, activity = true) {
    this.revisions.set(session.id, (this.revisions.get(session.id) ?? 0) + 1)
    if (activity) session.updatedAt = Date.now()
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
    if (this.deletionBlocked(input.workspace, input.sessionId))
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
    if (
      !previous?.parentSessionId &&
      [...this.sessions.values()].some(
        (session) =>
          !session.parentSessionId &&
          pathKey(session.workspace) === pathKey(input.workspace) &&
          session.id !== input.sessionId,
      )
    )
      throw new Error('이 Worktree에 연결된 기존 작업을 사용해 주세요.')
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
    const userMessageId = crypto.randomUUID()
    session.messages.push({
      id: userMessageId,
      kind: 'user',
      text: input.text,
    })
    this.pendingUserMessages.set(session.id, [
      { id: userMessageId, text: input.text },
    ])
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
            sandbox: 'danger-full-access',
            approvalPolicy: 'never',
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
          approvalPolicy: 'never',
          sandboxPolicy: { type: 'dangerFullAccess' },
          clientUserMessageId: userMessageId,
          input: [{ type: 'text', text: input.text, text_elements: [] }],
          ...(input.model ? { model: input.model } : {}),
          ...(input.effort ? { effort: input.effort } : {}),
        },
      )
      session.turnId = result.turn.id
      this.publish(session, false)
    } catch (error) {
      this.pendingUserMessages.delete(session.id)
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
    if (
      session?.parentSessionId &&
      (!session.turnId || !this.loadedThreads.has(session.threadId!))
    )
      await this.inspectSubagent(id)
    if (!session || !['running', 'waiting'].includes(session.status))
      throw new Error('진행 중인 작업만 중단할 수 있습니다.')
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
    const family = this.descendants(id)
    if (
      [...(session ? [session] : []), ...family].some(
        (item) =>
          this.busy.has(item.id) ||
          ['running', 'waiting'].includes(item.status),
      )
    )
      throw new Error('실행 중인 작업은 삭제할 수 없습니다.')
    for (const child of family) this.sessions.delete(child.id)
    this.sessions.delete(id)
    await this.persist()
  }

  async removeWorkspace(
    workspace: string,
    remove: () => Promise<void | { warning?: string }>,
  ) {
    await this.loaded
    const key = pathKey(workspace)
    if (this.deletingWorkspaces.has(key))
      throw new Error('이미 Worktree를 삭제하고 있습니다.')
    const roots = [...this.sessions.values()].filter((item) =>
      workspaceContains(key, item.workspace),
    )
    const sessions = [
      ...new Map(
        roots
          .flatMap((item) => [item, ...this.descendants(item.id)])
          .map((item) => [item.id, item]),
      ).values(),
    ]
    if (
      sessions.some(
        (item) =>
          this.busy.has(item.id) ||
          this.inspections.has(item.id) ||
          this.deletingSessions.has(item.id) ||
          ['running', 'waiting'].includes(item.status),
      )
    )
      throw new Error('진행 중이거나 시작 중인 작업을 먼저 중단해 주세요.')
    this.deletingWorkspaces.add(key)
    for (const session of sessions) this.deletingSessions.add(session.id)
    let warning: string | undefined
    try {
      // 삭제 의도를 먼저 저장하여 폴더 삭제 후 저장 실패 시에도 관련 대화만 정리합니다.
      this.removalIntents.add(key)
      try {
        await this.persist()
        const result = await remove()
        warning = result?.warning
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
        return warning ? { warning } : {}
      } catch {
        return {
          warning: [
            warning,
            'Worktree 삭제는 완료되었지만 대화 기록 파일을 저장하지 못했습니다. 앱을 종료하기 전에 저장 공간과 권한을 확인해 주세요.',
          ]
            .filter(Boolean)
            .join('\n'),
        }
      }
    } finally {
      this.deletingWorkspaces.delete(key)
      for (const session of sessions) this.deletingSessions.delete(session.id)
    }
  }

  private deletionBlocked(workspace: string, sessionId: string) {
    return (
      this.deletingSessions.has(sessionId) ||
      [...this.deletingWorkspaces].some((root) =>
        workspaceContains(root, workspace),
      )
    )
  }

  private descendants(id: string): AgentSession[] {
    const found = new Set([id])
    const children: AgentSession[] = []
    for (const parentId of found) {
      for (const child of this.sessions.values()) {
        if (child.parentSessionId === parentId && !found.has(child.id)) {
          found.add(child.id)
          children.push(child)
        }
      }
    }
    return children
  }

  private discoverSubagent(parent: AgentSession, threadId: string) {
    if (this.deletionBlocked(parent.workspace, parent.id)) return undefined
    if (!threadId || threadId === parent.threadId) return undefined
    let child = [...this.sessions.values()].find(
      (item) => item.threadId === threadId,
    )
    if (child && !child.parentSessionId) return undefined
    if (!child) {
      child = {
        id: `subagent-${threadId}`,
        threadId,
        parentSessionId: parent.id,
        workspace: parent.workspace,
        title: `서브에이전트 ${threadId.slice(0, 8)}`,
        status: 'idle',
        messages: [],
        requests: [],
        updatedAt: Date.now(),
      }
      this.sessions.set(child.id, child)
    }
    return child
  }

  private updateSubagentMetadata(
    session: AgentSession,
    thread: Record<string, unknown>,
  ) {
    session.nickname = string(thread.agentNickname) || session.nickname
    session.role = string(thread.agentRole) || session.role
    session.model = string(thread.model) || session.model
    session.workspace = string(thread.cwd) || session.workspace
    session.title = session.nickname || string(thread.name) || session.title
    session.task = session.task || string(thread.preview) || undefined
    if (typeof thread.canAcceptDirectInput === 'boolean')
      session.canAcceptDirectInput = thread.canAcceptDirectInput
  }

  async inspectSubagent(id: string): Promise<void> {
    await this.loaded
    const session = this.sessions.get(id)
    if (!session?.parentSessionId || !session.threadId)
      throw new Error('서브에이전트를 찾을 수 없습니다.')
    if (this.deletionBlocked(session.workspace, id))
      throw new Error('삭제 중인 Worktree의 작업은 제어할 수 없습니다.')
    const pending = this.inspections.get(id)
    if (pending) return pending
    const inspection = (async () => {
      await this.client.start()
      const revision = this.revisions.get(id)
      const previousTurnId = session.turnId
      const { thread } = await this.client.request<{
        thread: Record<string, unknown>
      }>('thread/resume', { threadId: session.threadId })
      this.loadedThreads.add(session.threadId!)
      this.updateSubagentMetadata(session, thread)
      // 조회 중 수신한 실시간 메시지와 상태가 과거 스냅샷으로 덮이지 않게 합니다.
      const unchanged = revision === this.revisions.get(id)
      const history = list(thread.turns).flatMap((turn) =>
        list(record(turn).items).flatMap((item) => {
          const normalized = this.normalizeItem(record(item))
          return normalized ? [normalized] : []
        }),
      )
      const live = new Map(session.messages.map((item) => [item.id, item]))
      session.messages = [
        ...history.map(
          (item) => (unchanged ? item : live.get(item.id)) ?? item,
        ),
        ...session.messages.filter(
          (item) => !history.some((entry) => entry.id === item.id),
        ),
      ]
      const lastTurn = record(list(thread.turns).at(-1))
      if (session.turnId === previousTurnId)
        session.turnId = string(lastTurn.id) || session.turnId
      if (unchanged) {
        session.turnId = string(lastTurn.id) || session.turnId
        if (lastTurn.status === 'inProgress') session.status = 'running'
        else if (
          ['completed', 'interrupted', 'failed'].includes(
            string(lastTurn.status),
          )
        )
          session.status = lastTurn.status as AgentSession['status']
        if (lastTurn.status)
          session.error = string(record(lastTurn.error).message) || undefined
        this.applyThreadStatus(session, record(thread.status))
      }
      session.observationError = undefined
      this.publish(session, false)
    })()
      .catch((error: unknown) => {
        session.observationError =
          error instanceof Error ? error.message : String(error)
        this.publish(session, false)
        throw error
      })
      .finally(() => this.inspections.delete(id))
    this.inspections.set(id, inspection)
    return inspection
  }

  private observeSubagent(session: AgentSession) {
    this.publish(session)
    if (!this.loadedThreads.has(session.threadId!))
      void this.inspectSubagent(session.id).catch(() => {})
  }

  async sendSubagentMessage(id: string, text: string) {
    if (typeof text !== 'string' || !text.trim() || text.length > 200_000)
      throw new Error('올바른 작업 내용을 입력해 주세요.')
    await this.inspectSubagent(id)
    const session = this.sessions.get(id)!
    if (this.deletionBlocked(session.workspace, id))
      throw new Error('삭제 중인 Worktree의 작업은 제어할 수 없습니다.')
    if (session.closed || session.canAcceptDirectInput === false)
      throw new Error(
        '이 서브에이전트는 직접 지시를 받을 수 없습니다. 부모 작업에서 지시해 주세요.',
      )
    if (session.requests.length || session.status === 'waiting')
      throw new Error('대기 중인 승인이나 질문을 먼저 처리해 주세요.')
    if (session.status !== 'running')
      return this.send({ sessionId: id, workspace: session.workspace, text })
    if (!session.turnId)
      throw new Error('작업을 시작하는 중입니다. 잠시 후 다시 보내 주세요.')
    if (this.busy.has(id)) throw new Error('이미 지시를 보내고 있습니다.')
    this.busy.add(id)
    const userMessageId = crypto.randomUUID()
    session.messages.push({ id: userMessageId, kind: 'user', text })
    const pendingMessages = this.pendingUserMessages.get(id) ?? []
    pendingMessages.push({ id: userMessageId, text })
    this.pendingUserMessages.set(id, pendingMessages)
    try {
      await this.client.request('turn/steer', {
        threadId: session.threadId,
        clientUserMessageId: userMessageId,
        expectedTurnId: session.turnId,
        input: [{ type: 'text', text, text_elements: [] }],
      })
      this.publish(session)
    } catch (error) {
      this.pendingUserMessages.set(
        id,
        (this.pendingUserMessages.get(id) ?? []).filter(
          (item) => item.id !== userMessageId,
        ),
      )
      throw error
    } finally {
      this.busy.delete(id)
    }
  }

  private applyThreadStatus(
    session: AgentSession,
    status: Record<string, unknown>,
  ) {
    if (status.type === 'active')
      session.status = list(status.activeFlags).length ? 'waiting' : 'running'
    else if (status.type === 'systemError') session.status = 'failed'
    if (session.requests.length) session.status = 'waiting'
  }

  private trackSubagents(parent: AgentSession, item: Record<string, unknown>) {
    if (item.type === 'subAgentActivity') {
      const child = this.discoverSubagent(parent, string(item.agentThreadId))
      if (!child) return
      child.nickname = string(item.agentPath) || child.nickname
      child.title = child.nickname || child.title
      child.model = string(item.model) || child.model
      if (item.kind === 'started') {
        child.closed = false
        child.status = 'running'
      } else if (item.kind === 'completed') child.status = 'completed'
      else if (item.kind === 'interrupted') child.status = 'interrupted'
      this.observeSubagent(child)
    } else if (item.type === 'collabAgentToolCall') {
      const states = record(item.agentsStates)
      const ids = new Set([
        ...list(item.receiverThreadIds).map(string),
        ...Object.keys(states),
      ])
      for (const threadId of ids) {
        const child = this.discoverSubagent(parent, threadId)
        if (!child) continue
        if (item.tool === 'spawnAgent') {
          child.task = string(item.prompt) || child.task
          child.model = string(item.model) || child.model
        }
        const state = record(states[threadId])
        const statuses: Record<string, AgentSession['status']> = {
          pendingInit: 'idle',
          running: 'running',
          completed: 'completed',
          interrupted: 'interrupted',
          errored: 'failed',
          shutdown: 'interrupted',
          notFound: 'failed',
        }
        if (statuses[string(state.status)])
          child.status = statuses[string(state.status)]
        if (state.status)
          child.closed =
            state.status === 'shutdown' || state.status === 'notFound'
        if (child.requests.length) child.status = 'waiting'
        if (state.message) {
          const id = `collab-result-${threadId}`
          const message: AgentMessage = {
            id,
            kind: 'assistant',
            text: string(state.message),
          }
          const index = child.messages.findIndex((entry) => entry.id === id)
          if (index < 0) child.messages.push(message)
          else child.messages[index] = message
        }
        this.observeSubagent(child)
      }
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
    if (message.method === 'thread/started') {
      const thread = record(params.thread)
      const source = record(record(record(thread.source).subAgent).thread_spawn)
      const parentThreadId =
        string(thread.parentThreadId) || string(source.parent_thread_id)
      const parent = [...this.sessions.values()].find(
        (item) => item.threadId === parentThreadId,
      )
      if (parent) {
        const child = this.discoverSubagent(parent, string(thread.id))
        if (child) {
          this.updateSubagentMetadata(child, thread)
          this.applyThreadStatus(child, record(thread.status))
          this.observeSubagent(child)
        }
      }
      return
    }
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
    if (message.method === 'serverRequest/resolved') {
      for (const request of session.requests) {
        if (this.requests.get(request.id)?.id === params.requestId) {
          this.requests.delete(request.id)
          session.requests = session.requests.filter(
            (item) => item.id !== request.id,
          )
        }
      }
      if (session.status === 'waiting' && !session.requests.length)
        session.status = 'running'
    } else if (message.method === 'thread/status/changed') {
      this.applyThreadStatus(session, record(params.status))
    } else if (message.method === 'thread/closed') {
      session.closed = true
      if (['running', 'waiting', 'idle'].includes(session.status))
        session.status = 'interrupted'
      for (const request of session.requests) this.requests.delete(request.id)
      session.requests = []
      this.loadedThreads.delete(threadId)
    } else if (message.method === 'turn/started') {
      session.turnId = string(record(params.turn).id)
      session.status = 'running'
      session.closed = false
    } else if (message.method === 'turn/completed') {
      this.pendingUserMessages.delete(session.id)
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
      this.trackSubagents(session, record(params.item))
      const item = this.normalizeItem(record(params.item))
      if (item) {
        let index = session.messages.findIndex((entry) => entry.id === item.id)
        if (item.kind === 'user') {
          const pending = this.pendingUserMessages.get(session.id) ?? []
          const echoed =
            pending.find((entry) => entry.id === item.id) ??
            pending.find((entry) => entry.text === item.text)
          if (echoed) {
            if (index < 0)
              index = session.messages.findIndex(
                (entry) => entry.id === echoed.id,
              )
            this.pendingUserMessages.set(
              session.id,
              pending.filter((entry) => entry !== echoed),
            )
          }
        }
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
      case 'userMessage':
        return {
          id,
          kind: 'user',
          text: list(item.content)
            .map((part) => string(record(part).text))
            .filter(Boolean)
            .join('\n'),
        }
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
      case 'collabAgentToolCall': {
        const names: Record<string, string> = {
          spawnAgent: '서브에이전트 생성',
          sendInput: '서브에이전트 지시',
          sendMessage: '서브에이전트 메시지',
          followupTask: '서브에이전트 후속 작업',
          wait: '서브에이전트 대기',
          closeAgent: '서브에이전트 종료',
          resumeAgent: '서브에이전트 재개',
          interruptAgent: '서브에이전트 중단',
          listAgents: '서브에이전트 목록 조회',
        }
        return {
          id,
          kind: 'tool',
          text: names[string(item.tool)] || string(item.tool),
          detail: string(item.prompt),
          status,
        }
      }
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
