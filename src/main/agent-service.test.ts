import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentService } from './agent-service.ts'
import type { AgentSession } from '../shared/types.ts'

test('Worktree 삭제 잠금은 동시 시작을 차단하고 삭제한 대화를 영속 제거한다', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lite-ide-session-delete-'))
  const file = join(directory, 'sessions.json')
  const session: AgentSession = {
    id: 'saved-session',
    workspace: directory,
    title: '보존된 이름',
    status: 'completed',
    messages: [],
    requests: [],
    updatedAt: Date.now(),
  }
  await writeFile(file, JSON.stringify([session]), 'utf8')
  const service = new AgentService(file, () => {})
  let release!: () => void
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  try {
    await service.all()
    const alias =
      process.platform === 'win32' ? directory.toUpperCase() : directory
    const removing = service.removeWorkspace(alias, async () => {
      entered()
      await gate
      return { warning: '연결된 로컬 브랜치 삭제 실패' }
    })
    await started
    await assert.rejects(
      service.send({
        sessionId: 'new-session',
        workspace: directory,
        text: '실행 요청',
      }),
      /삭제 중/,
    )
    await assert.rejects(
      service.removeWorkspace(directory, async () => {}),
      /이미 Worktree/,
    )
    release()
    assert.match((await removing).warning ?? '', /브랜치 삭제 실패/)
    assert.deepEqual(await service.all(), [])
    const saved = JSON.parse(await readFile(file, 'utf8'))
    assert.deepEqual(saved.sessions, [])
    const restored = new AgentService(file, () => {})
    assert.deepEqual(await restored.all(), [])
    await restored.close()
  } finally {
    release()
    await service.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('작업 시작 응답을 기다리는 동안 Worktree와 작업 삭제를 거부한다', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lite-ide-session-starting-'))
  const service = new AgentService(join(directory, 'sessions.json'), () => {})
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  service.client.start = () => {
    entered()
    return gate
  }
  try {
    await service.all()
    const sending = service.send({
      sessionId: 'starting-session',
      workspace: directory,
      text: '시작 중 요청',
    })
    const rejected = assert.rejects(sending, /Codex에 연결되어 있지 않습니다/)
    await started
    await assert.rejects(
      service.removeWorkspace(directory, async () => {}),
      /진행 중이거나 시작 중/,
    )
    await assert.rejects(service.delete('starting-session'), /실행 중/)
    release()
    await rejected
  } finally {
    release()
    await service.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('삭제 의도 없는 오프라인 대화는 보존하고 삭제 실패 시 대화를 유지한다', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lite-ide-session-restore-'))
  const file = join(directory, 'sessions.json')
  const session: AgentSession = {
    id: 'offline-session',
    workspace: join(directory, 'offline'),
    title: '오프라인 대화',
    status: 'completed',
    messages: [],
    requests: [],
    updatedAt: Date.now(),
  }
  await writeFile(file, JSON.stringify([session]), 'utf8')
  const service = new AgentService(file, () => {})
  try {
    assert.equal((await service.all()).length, 1)
    await assert.rejects(
      service.removeWorkspace(session.workspace, async () => {
        throw new Error('Git 삭제 실패')
      }),
      /Git 삭제 실패/,
    )
    assert.equal((await service.all()).length, 1)
    const saved = JSON.parse(await readFile(file, 'utf8'))
    assert.deepEqual(saved.removalIntents, [])
  } finally {
    await service.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('폴더 삭제 뒤 저장에 실패한 기록은 해당 삭제 경로에 한해 재시작에서 제외한다', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lite-ide-session-intent-'))
  const file = join(directory, 'sessions.json')
  const workspace = join(directory, 'removed')
  const session: AgentSession = {
    id: 'removed-session',
    workspace,
    title: '삭제된 대화',
    status: 'completed',
    messages: [],
    requests: [],
    updatedAt: Date.now(),
  }
  const key = process.platform === 'win32' ? workspace.toLowerCase() : workspace
  await writeFile(
    file,
    JSON.stringify({ sessions: [session], removalIntents: [key] }),
    'utf8',
  )
  const service = new AgentService(file, () => {})
  try {
    assert.deepEqual(await service.all(), [])
  } finally {
    await service.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('삭제 후 저장 실패는 부분 성공으로 보고하고 삭제 의도로 재시작 복원을 막는다', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lite-ide-session-partial-'))
  const workspace = join(directory, 'workspace')
  await mkdir(workspace)
  const file = join(directory, 'sessions.json')
  const session: AgentSession = {
    id: 'partial-session',
    workspace,
    title: '삭제할 대화',
    status: 'completed',
    messages: [],
    requests: [],
    updatedAt: Date.now(),
  }
  await writeFile(file, JSON.stringify([session]), 'utf8')
  const service = new AgentService(file, () => {})
  const storage = service as unknown as { persist: () => Promise<void> }
  const persist = storage.persist.bind(service)
  let saves = 0
  try {
    await service.all()
    storage.persist = () =>
      ++saves === 1 ? persist() : Promise.reject(new Error('디스크 저장 실패'))
    const result = await service.removeWorkspace(workspace, async () => {
      await rm(workspace, { recursive: true })
      return { warning: '연결된 로컬 브랜치 삭제 실패' }
    })
    assert.match(result.warning ?? '', /Worktree 삭제는 완료/)
    assert.match(result.warning ?? '', /브랜치 삭제 실패/)
    assert.deepEqual(await service.all(), [])
    const restored = new AgentService(file, () => {})
    assert.deepEqual(await restored.all(), [])
    await restored.close()
  } finally {
    storage.persist = persist
    await service.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('삭제 의도를 저장하지 못하면 폴더 삭제를 실행하지 않는다', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'lite-ide-session-save-failure-'),
  )
  const service = new AgentService(join(directory, 'sessions.json'), () => {})
  const storage = service as unknown as { persist: () => Promise<void> }
  const persist = storage.persist.bind(service)
  let removed = false
  try {
    await service.all()
    storage.persist = () => Promise.reject(new Error('디스크 저장 실패'))
    await assert.rejects(
      service.removeWorkspace(directory, async () => {
        removed = true
      }),
      /디스크 저장 실패/,
    )
    assert.equal(removed, false)
  } finally {
    storage.persist = persist
    await service.close()
    await rm(directory, { recursive: true, force: true })
  }
})
