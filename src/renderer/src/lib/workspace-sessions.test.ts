import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentSession, TerminalSnapshot } from '../../../shared/types'
import { agentSessionStatus, sameWorkspace, workspaceSessions, workspaceTaskStatus } from './workspace-sessions.ts'

const session = (id: string, workspace: string, parentSessionId?: string): AgentSession => ({
  id, workspace, parentSessionId, title: id, status: 'idle', messages: [], requests: [], updatedAt: 0,
})

test('선택한 Worktree의 부모·서브에이전트 세션만 탭에 표시한다', () => {
  const sessions = [
    session('child', '/trees/one', 'parent'),
    session('other', '/trees/two'),
    session('other-child', '/trees/two', 'parent'),
    session('nested', '/trees/one/nested'),
    session('parent', '/trees/one'),
  ]
  assert.deepEqual(workspaceSessions(sessions, '/trees/one/', 'darwin').map((item) => item.id), ['parent', 'child'])
  assert.deepEqual(workspaceSessions(sessions, '', 'darwin'), [])
})

test('Windows 경로 구분자·대소문자만 정규화하며 접두사가 같은 다른 Worktree는 제외한다', () => {
  assert.equal(sameWorkspace('C:\\Trees\\One', 'c:/trees/one/', 'win32'), true)
  assert.equal(sameWorkspace('/trees/One', '/trees/one', 'darwin'), false)
  assert.equal(sameWorkspace('/trees/one', '/trees/one-two', 'darwin'), false)
})

const terminal: TerminalSnapshot = {
  taskId: 'task', generation: 'generation', workspace: '/trees/one', kind: 'codex',
  running: true, output: '', sequence: 0, cols: 80, rows: 24,
}

test('작업 상태를 표시하며 터미널 연결 해제와 셸 전환은 과거 세션 상태보다 우선한다', () => {
  const root = { ...session('parent', terminal.workspace), status: 'running' as const }
  const status = (value?: TerminalSnapshot) => workspaceTaskStatus([root], terminal.workspace, 'darwin', value)
  assert.equal(status(terminal).state, 'running')
  assert.equal(status().state, 'disconnected')
  assert.equal(status({ ...terminal, running: false }).state, 'disconnected')
  assert.equal(status({ ...terminal, kind: 'shell' }).state, 'disconnected')
  assert.equal(status({ ...terminal, waitingForInput: true }).state, 'waiting')
  for (const state of ['idle', 'waiting', 'completed', 'failed', 'interrupted'] as const) {
    const result = workspaceTaskStatus([{ ...root, status: state }], terminal.workspace, 'darwin', terminal)
    assert.equal(result.state, ['idle', 'failed', 'interrupted'].includes(state) ? 'completed' : state)
    if (state === 'failed') assert.equal(result.detail, '작업 실패')
    if (state === 'interrupted') assert.equal(result.detail, '작업 중단')
  }
})

test('터미널이 계속 켜져 있어도 작업 완료·실패·중단을 실행 중과 구분한다', () => {
  const root = session('parent', terminal.workspace)
  for (const state of ['running', 'completed', 'failed', 'interrupted', 'idle', 'waiting'] as const) {
    const current = { ...root, status: state }
    const status = workspaceTaskStatus([current], terminal.workspace, 'darwin', terminal)
    assert.equal(status.state, ['idle', 'failed', 'interrupted'].includes(state) ? 'completed' : state)
    assert.deepEqual(status, agentSessionStatus(current))
  }
  assert.equal(agentSessionStatus({ ...root, status: 'running', observationError: 'offline' }).state, 'disconnected')
})

test('현재 부모 작업의 상태만 반영하며 자식과 과거 대화의 상태가 섞이지 않는다', () => {
  const root = { ...session('parent', terminal.workspace), status: 'completed' as const, updatedAt: 20 }
  const sessions: AgentSession[] = [
    root,
    { ...session('old', terminal.workspace), status: 'running', updatedAt: 10 },
    { ...session('child', terminal.workspace, root.id), status: 'running', updatedAt: 30 },
    { ...session('other', '/trees/two'), status: 'waiting', updatedAt: 40 },
    { ...session('closed', terminal.workspace), status: 'running', closed: true, updatedAt: 50 },
  ]
  assert.deepEqual(workspaceTaskStatus(sessions, terminal.workspace, 'darwin', terminal),
    { state: 'completed', label: '작업 완료됨' })
  assert.equal(workspaceTaskStatus([{ ...root, observationError: 'offline' }], terminal.workspace, 'darwin', terminal).state, 'disconnected')
  assert.equal(workspaceTaskStatus([{ ...root, status: 'running', requests: [{ id: 'request', kind: 'questions', title: '질문', detail: '' }] }], terminal.workspace, 'darwin', terminal).state, 'waiting')
  assert.deepEqual(workspaceTaskStatus([], terminal.workspace, 'darwin', terminal),
    { state: 'disconnected', label: '연결 안 됨', detail: '세션 상태 확인 중' })
})

test('질문 없는 초기 상태와 실행 상태를 답변 대기로 표시하지 않는다', () => {
  const root = session('parent', terminal.workspace)
  const status = (sessions: AgentSession[], value = terminal) =>
    workspaceTaskStatus(sessions, terminal.workspace, 'darwin', value)
  assert.equal(status([]).state, 'disconnected')
  assert.deepEqual(status([root]), { state: 'completed', label: '작업 완료됨', detail: '입력 대기 중' })
  assert.deepEqual(status([{ ...root, status: 'running' }]), { state: 'running', label: '작업 중' })
  assert.equal(status([root], { ...terminal, waitingForInput: true }).state, 'waiting')
  assert.equal(status([{ ...root, requests: [{ id: 'q', kind: 'questions', title: '질문', detail: '' }] }]).state, 'waiting')
  assert.equal(status([{ ...root, requests: [{ id: 'a', kind: 'approval', title: '승인', detail: '' }] }]).state, 'waiting')
})

test('CLI가 닫힌 뒤에도 확인된 Worked 결과를 상태 미확인으로 숨기지 않는다', () => {
  const root = { ...session('worked', terminal.workspace), closed: true, status: 'completed' as const }
  assert.deepEqual(workspaceTaskStatus([root], terminal.workspace, 'darwin', terminal),
    { state: 'completed', label: '작업 완료됨' })
  assert.equal(workspaceTaskStatus([{ ...root, status: 'running' }], terminal.workspace, 'darwin', terminal).state, 'disconnected')
})

test('화면 상태는 네 가지로 통일하고 실패·중단·관측 실패의 상세 원인은 보존한다', () => {
  const root = session('four-states', terminal.workspace)
  const results = ['idle', 'running', 'waiting', 'completed', 'failed', 'interrupted'].map((status) =>
    agentSessionStatus({ ...root, status: status as AgentSession['status'] }))
  results.push(agentSessionStatus({ ...root, observationError: '연결 오류' }))
  assert.deepEqual([...new Set(results.map((status) => status.label))].sort(),
    ['연결 안 됨', '작업 중', '질문 대기 중', '작업 완료됨'].sort())
  assert.deepEqual([...new Set(results.map((status) => status.state))].sort(),
    ['disconnected', 'running', 'waiting', 'completed'].sort())
  assert.equal(results[4].detail, '작업 실패')
  assert.equal(results[5].detail, '작업 중단')
  assert.match(results[6].detail!, /연결 오류/)
})
