import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentSession } from '../../../shared/types'
import { sameWorkspace, workspaceSessions } from './workspace-sessions.ts'

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
