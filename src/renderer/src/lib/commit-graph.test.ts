import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildCommitGraph } from './commit-graph.ts'

test('분기와 병합의 모든 부모를 연결하고 합류 후 남은 레인을 유지한다', () => {
  const graph = buildCommitGraph([
    { hash: 'merge', parents: ['main', 'feature'], subject: '병합' },
    { hash: 'feature', parents: ['base'], subject: '기능' },
    { hash: 'main', parents: ['base'], subject: '메인' },
    { hash: 'base', parents: [], subject: '시작' },
  ])
  assert.deepEqual(graph[0].lines, [{ from: 0, to: 0, parent: true }, { from: 0, to: 1, parent: true }])
  assert.equal(graph[1].column, 1)
  assert.deepEqual(graph[1].lines, [{ from: 0, to: 0, parent: false }, { from: 1, to: 1, parent: true }])
  assert.deepEqual(graph[2].lines, [{ from: 1, to: 0, parent: false }, { from: 0, to: 0, parent: true }])
  assert.equal(graph[3].column, 0)
  assert.deepEqual(graph[3].lines, [])
})

test('서로 무관한 커밋과 잘린 이력의 부모도 유효한 레인으로 반환한다', () => {
  assert.deepEqual(buildCommitGraph([]), [])
  const graph = buildCommitGraph([
    { hash: 'a', parents: ['missing'], subject: '' },
    { hash: 'b', parents: [], subject: '' },
  ])
  assert.equal(graph[1].column, 1)
  assert.equal(graph[1].width, 2)
  assert.ok(graph.every((row) => row.lines.every((line) => line.from >= 0 && line.to >= 0)))
})
