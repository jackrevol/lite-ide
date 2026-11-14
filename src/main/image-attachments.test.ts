import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { storeImages } from './image-attachments.ts'
import { maxImageBytes } from '../shared/image-attachments.ts'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')

test('이미지는 프로젝트 밖에 고유한 파일로 복사하고 이름과 확장자를 신뢰하지 않는다', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lite-images-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const files = await storeImages(directory, [
    { name: '../../한글 이미지.exe', data: png }, { name: 'same.png', data: png },
  ])
  assert.equal(files.length, 2)
  assert.notEqual(files[0], files[1])
  for (const file of files) {
    assert.match(basename(file), /^[a-f0-9-]+\.png$/)
    assert.deepEqual(await readFile(file), png)
  }
})

test('잘못된 형식·개수·크기는 파일을 남기지 않고 거부한다', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lite-invalid-images-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  for (const images of [[], Array.from({ length: 11 }, () => ({ name: 'a.png', data: png })),
    [{ name: 'a.png', data: png }, { name: 'fake.png', data: Buffer.from('not an image') }],
    [{ name: 'big.png', data: new Uint8Array(maxImageBytes + 1) }],
  ]) await assert.rejects(storeImages(directory, images))
  assert.deepEqual(await readdir(directory), [])
})
