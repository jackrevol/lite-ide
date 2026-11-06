import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadWorkspace, storageKey } from './workspace-state.ts'

test('이전 로컬 작업은 무시하고 새 Worktree 작업만 한 경로당 하나씩 복원한다', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (key: string) => values.get(key) ?? null },
  })
  try {
    values.set('lite-ide.workspace.v1', JSON.stringify({
      sessions: { '/project': [{ id: 'old', title: '이전 로컬 작업', draft: '이전 입력' }] },
      project: '/project', workspace: '/project',
    }))
    assert.deepEqual(loadWorkspace(), { sessions: {}, selected: {}, project: '', workspace: '', worktreeNames: {}, newTaskMode: 'worktree' })
    const task = {
      id: 'new-task', title: '새 작업', draft: '보관할 입력',
      project: '/project', branch: 'task/new',
    }
    values.set(storageKey, JSON.stringify({
      project: '/project', workspace: '/worktree',
      sessions: {
        '/worktree': [task, { ...task, id: 'second' }],
        '/project': [{ ...task, id: 'root-task' }],
        '/invalid': [{ ...task, id: 'invalid', branch: null }],
      },
    }))
    assert.deepEqual(loadWorkspace(), {
      sessions: { '/worktree': [task] }, selected: {}, project: '/project', workspace: '/worktree', worktreeNames: {}, newTaskMode: 'worktree',
    })
    values.set(storageKey, '{broken')
    assert.deepEqual(loadWorkspace(), { sessions: {}, selected: {}, project: '', workspace: '', worktreeNames: {}, newTaskMode: 'worktree' })
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})
