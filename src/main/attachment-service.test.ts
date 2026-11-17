import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AttachmentService, attachmentName } from './attachment-service.ts'
import { initialAttachmentPrompt, maxAttachmentBytes, maxAttachmentTotalBytes } from '../shared/attachments.ts'

const target = { taskId: 'task', generation: 'generation' }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')

test('파일 종류와 원본 이름·내용을 보존하고 첨부 준비는 Codex 입력을 변경하지 않는다', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lite-attachments-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const service = new AttachmentService(directory)
  const uploads = [
    { name: '../../한글 이미지.exe', data: png },
    { name: '설명.md', data: Buffer.from('# 설명\n<script>text only</script>') },
    { name: 'data.csv', data: Buffer.from('name,value\n한글,1') },
    { name: '문서.pdf', data: Buffer.from('%PDF-fixture') },
    { name: 'archive.zip', data: Buffer.from([80, 75, 3, 4, 0]) },
    { name: 'empty.txt', data: Buffer.alloc(0) },
  ]
  const files = await service.stage({ ...target, files: uploads })
  assert.equal(files[0].kind, 'image')
  assert.equal(files[0].name, '한글 이미지.png')
  assert.ok(files.slice(1).every((file) => file.kind === 'file'))
  assert.equal(service.list(target).length, uploads.length)
  const firstPrompt = initialAttachmentPrompt('첫 요청', files)
  assert.ok(firstPrompt.startsWith('첫 요청\n\n첨부 파일:\n'))
  assert.equal(firstPrompt.includes(files[0].name), false)
  assert.deepEqual(firstPrompt.split('\n').slice(3).map((line) => JSON.parse(line)), files.slice(1).map((file) => file.path.replaceAll('\\', '/')))
  assert.equal(initialAttachmentPrompt('', [files[0]]), '첨부 파일을 확인해 주세요.')
  assert.equal(initialAttachmentPrompt('', []), '')
  assert.deepEqual(service.list({ ...target, generation: 'other' }), [])
  assert.equal((await service.preview(target, files[1].id)).text, uploads[1].data.toString())
  assert.equal((await service.preview(target, files[3].id)).text, undefined)
  assert.equal((await service.preview(target, files[5].id)).text, '')
  await assert.rejects(service.preview({ ...target, taskId: 'other' }, files[1].id), /다른 작업/)
  await service.discard({ ...target, ids: [files[4].id] })
  assert.equal(await stat(join(directory, files[4].id)).catch(() => null), null)
  const ids = files.filter((file) => file.id !== files[4].id).map((file) => file.id)
  await assert.rejects(service.deliver({ ...target, ids }, () => { throw new Error('전달 실패') }), /전달 실패/)
  assert.equal(service.list(target).length, ids.length)
  let delivered: { path: string; kind: string }[] = []
  await service.deliver({ ...target, ids }, (items) => { delivered = items })
  assert.equal(delivered.length, ids.length)
  assert.deepEqual(delivered, files.filter((file) => ids.includes(file.id)).map((file) => ({ path: file.path, kind: file.kind })))
  assert.deepEqual(await readFile(delivered[0].path), png)
  assert.equal(delivered[1].path.endsWith('설명.md'), true)
  assert.deepEqual(service.list(target), [])
  await assert.rejects(service.deliver({ ...target, ids }, () => {}), /없거나/)
})

test('큰 텍스트 미리보기는 제한하고 전체 원본을 전달한다', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lite-attachment-preview-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const service = new AttachmentService(directory)
  const data = Buffer.from('한글'.repeat(20000))
  const [file] = await service.stage({ ...target, files: [{ name: 'large.log', data }] })
  const preview = await service.preview(target, file.id)
  assert.equal(preview.truncated, true)
  assert.ok(preview.text!.length < data.toString().length)
  await service.deliver({ ...target, ids: [file.id] }, (items) => { assert.ok(items[0].path.endsWith('large.log')) })
  assert.deepEqual(await readFile(join(directory, file.id, file.name)), data)
})

test('같은 작업의 재연결은 준비된 파일을 복원하고 다른 작업은 접근하지 못한다', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lite-attachment-restore-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const service = new AttachmentService(directory)
  const [file] = await service.stage({ ...target, files: [{ name: 'keep.txt', data: Buffer.from('keep') }] })
  assert.deepEqual(service.restore({ taskId: 'other-task', generation: 'new' }), [])
  const renewed = { ...target, generation: 'new' }
  assert.equal(service.restore(renewed)[0].id, file.id)
  await assert.rejects(service.discard({ ...target, ids: [file.id] }), /다른 작업/)
  assert.equal((await service.preview(renewed, file.id)).text, 'keep')
  await service.discard({ ...renewed, ids: [file.id] })
  assert.deepEqual(await readdir(directory), [])
})

test('파일을 제거하는 동안 전송이 경합해도 삭제될 경로를 Codex로 전달하지 않는다', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lite-attachment-remove-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const service = new AttachmentService(directory)
  const [file] = await service.stage({ ...target, files: [{ name: 'remove.txt', data: Buffer.from('remove') }] })
  const selection = { ...target, ids: [file.id] }
  const removal = service.discard(selection)
  await assert.rejects(service.deliver(selection, () => assert.fail('제거 중인 파일을 전달하면 안 됩니다.')), /처리하고/)
  await removal
  assert.deepEqual(service.list(target), [])
})

test('동시 첨부 제한·파일 검증과 이름 정규화로 잘못된 파일을 남기지 않는다', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lite-attachment-limits-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const service = new AttachmentService(directory)
  const tiny = { name: 'tiny.txt', data: Buffer.from('x') }
  for (const files of [[], Array.from({ length: 21 }, () => tiny),
    [tiny, { name: 'fake.png', data: Buffer.from('not an image') }],
    [{ name: 'big.bin', data: new Uint8Array(maxAttachmentBytes + 1) }],
    Array.from({ length: 3 }, () => ({ name: 'total.bin', data: new Uint8Array(maxAttachmentTotalBytes / 2) })),
  ]) await assert.rejects(service.stage({ ...target, files }))
  assert.deepEqual(await readdir(directory), [])
  const results = await Promise.allSettled([service.stage({ ...target, files: Array(11).fill(tiny) }),
    service.stage({ ...target, files: Array(11).fill(tiny) })])
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1)
  assert.equal(service.list(target).length, 11)
  assert.equal(attachmentName('../../CON.txt'), '_CON.txt')
  assert.equal(attachmentName('..\\name?.md'), 'name_.md')
  assert.ok(Buffer.byteLength(attachmentName('한'.repeat(200) + '.txt')) <= 180)
})
