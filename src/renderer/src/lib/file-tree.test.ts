import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildFileTree } from './file-tree.ts'

test('변경 경로를 중복 없는 폴더로 구성하고 폴더를 먼저 정렬하며 Git 상태를 보존한다', () => {
  const tree = buildFileTree([
    { path: 'z.txt', status: ' D' },
    { path: 'src/nested/한글.ts', status: '??' },
    { path: 'src/a.ts', status: ' M' },
    { path: 'a.txt', status: 'A ' },
  ])
  assert.deepEqual(tree.map((node) => node.name), ['src', 'a.txt', 'z.txt'])
  assert.deepEqual(tree[0].children.map((node) => node.name), ['nested', 'a.ts'])
  assert.equal(tree[0].children[0].children[0].file?.status, '??')
  assert.equal(tree[2].file?.status, ' D')
})

test('전체 경로를 대소문자 구분 없이 검색하고 일치한 파일의 상위 폴더를 유지한다', () => {
  const files = [{ path: 'src/nested/File.ts', status: ' M' }, { path: 'other.txt', status: '??' }]
  const tree = buildFileTree(files, 'NESTED/file')
  assert.equal(tree.length, 1)
  assert.equal(tree[0].children[0].children[0].file?.path, files[0].path)
  assert.deepEqual(buildFileTree(files, '없음'), [])
})
