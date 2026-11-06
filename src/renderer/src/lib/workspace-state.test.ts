import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadWorkspace, storageKey } from './workspace-state.ts'

test('이전 작업과 Worktree 별칭을 하나의 작업으로 이전하고 중복 경로를 제거한다', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (key: string) => values.get(key) ?? null },
  })
  try {
    const empty = { tasks: [], project: '', taskId: '' }
    values.set(
      'lite-ide.workspace.v1',
      JSON.stringify({ sessions: { '/project': [{ id: 'old' }] } }),
    )
    assert.deepEqual(loadWorkspace(), empty)
    values.set(
      'lite-ide.workspace.v2',
      JSON.stringify({
        project: '/project',
        workspace: '/tree',
        worktreeNames: { '/tree': '하나의 이름' },
        sessions: {
          '/tree': [
            {
              id: 'one',
              title: '이전 이름',
              draft: '보관한 입력',
              project: '/project',
              branch: 'task/one',
            },
          ],
          '/project': [
            {
              id: 'root',
              project: '/project',
              branch: 'main',
              title: '원본 폴더',
            },
          ],
        },
      }),
    )
    const migrated = loadWorkspace()
    assert.equal(migrated.tasks.length, 1)
    assert.deepEqual(migrated.tasks[0], {
      id: 'one',
      name: '하나의 이름',
      project: '/project',
      path: '/tree',
      branch: 'task/one',
      model: '',
      effort: '',
      terminalKind: 'codex',
      draft: '보관한 입력',
    })
    assert.equal(migrated.taskId, 'one')
    const task = migrated.tasks[0]
    values.set(
      storageKey,
      JSON.stringify({
        tasks: [
          task,
          { ...task, id: 'second' },
          { ...task, path: '/other' },
          { ...task, id: 'root', path: '/project' },
        ],
        project: '/project',
        taskId: 'one',
      }),
    )
    assert.equal(loadWorkspace().tasks.length, 1)
    values.set(storageKey, '{broken')
    assert.deepEqual(loadWorkspace(), empty)
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})
