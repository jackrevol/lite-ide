import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { AttachmentService, attachmentName } from './attachment-service.ts'
import { maxAttachmentBytes, maxAttachmentTotalBytes } from '../shared/attachments.ts'

const target = { taskId: 'task', generation: 'generation' }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')

test('문장 속 파일·이미지 번호를 MCP로 조회하고 앱 재시작 후에도 원본과 번호를 보존한다', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lite-inline-attachments-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const service = new AttachmentService(directory)
  const files = await service.stage({ ...target, files: [
    { name: '설명.md', data: Buffer.from('문서 원본') }, { name: '이미지.png', data: png },
  ] })
  assert.deepEqual(files.map((file) => file.reference), ['[파일#1]', '[파일#2]'])
  let placed: string[] = []
  await service.place({ ...target, ids: files.map((file) => file.id) }, (references) => { placed = references })
  assert.deepEqual(placed, ['[파일#1]', '[파일#2]'])
  assert.ok(service.restore(target).every((file) => file.placed))
  await service.deliver({ ...target, ids: files.map((file) => file.id) }, () => {})
  const restored = new AttachmentService(directory)
  const [next] = await restored.stage({ ...target, files: [{ name: '다음.txt', data: Buffer.from('next') }] })
  assert.equal(next.reference, '[파일#3]')
  const child = spawn(process.execPath, ['resources/attachment-mcp.cjs', service.manifestPath(target.taskId)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => { child.stdin.end(); child.kill() })
  const lines = createInterface({ input: child.stdout })
  const pending = new Map<number, (value: any) => void>()
  lines.on('line', (line) => { const reply = JSON.parse(line); pending.get(reply.id)?.(reply.result); pending.delete(reply.id) })
  let sequence = 0
  const request = (method: string, params: unknown = {}) => new Promise<any>((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => reject(new Error('첨부 MCP 응답 시간 초과')), 5000)
    pending.set(id, (result) => { clearTimeout(timer); resolve(result) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  assert.ok((await request('initialize', { protocolVersion: '2024-11-05' })).capabilities.tools)
  assert.equal((await request('tools/list')).tools[0].name, 'resolve_attachment')
  const lookup = (reference: string) => request('tools/call', { name: 'resolve_attachment', arguments: { reference } })
  const document = await lookup('[파일#1]')
  assert.equal(JSON.parse(document.content[0].text).path, files[0].path)
  assert.equal(await readFile(JSON.parse(document.content[0].text).path, 'utf8'), '문서 원본')
  const image = await lookup('[파일#2]')
  assert.equal(image.content[1].type, 'image')
  assert.equal(image.content[1].mimeType, 'image/png')
  assert.deepEqual(Buffer.from(image.content[1].data, 'base64'), png)
  assert.equal((await lookup('[파일#999]')).isError, true)
  assert.equal((await lookup('../other-task.json')).isError, true)
  await restored.discard({ ...target, ids: [next.id] })
  assert.equal((await lookup('[파일#3]')).isError, true)
})

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
  assert.deepEqual(service.list({ ...target, generation: 'other' }), [])
  assert.equal(await readFile(files[1].path, 'utf8'), uploads[1].data.toString())
  assert.equal(await readFile(files[5].path, 'utf8'), '')
  await assert.rejects(service.place({ ...target, taskId: 'other', ids: [files[1].id] }, () => {}), /다른 작업/)
  await service.discard({ ...target, ids: [files[4].id] })
  assert.equal(await stat(join(directory, files[4].id)).catch(() => null), null)
  const ids = files.filter((file) => file.id !== files[4].id).map((file) => file.id)
  await assert.rejects(service.deliver({ ...target, ids }, () => { throw new Error('전달 실패') }), /전달 실패/)
  assert.equal(service.list(target).length, ids.length)
  let delivered: { path: string; kind: string }[] = []
  await service.deliver({ ...target, ids }, (items) => { delivered = items })
  assert.equal(delivered.length, ids.length)
  assert.deepEqual(delivered, files.filter((file) => ids.includes(file.id)).map((file) => ({ path: file.path, kind: file.kind, reference: file.reference })))
  assert.deepEqual(await readFile(delivered[0].path), png)
  assert.equal(delivered[1].path.endsWith('설명.md'), true)
  assert.deepEqual(service.list(target), [])
  await assert.rejects(service.deliver({ ...target, ids }, () => {}), /없거나/)
})

test('큰 텍스트도 전체 원본을 보존하여 전달한다', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lite-attachment-preview-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const service = new AttachmentService(directory)
  const data = Buffer.from('한글'.repeat(20000))
  const [file] = await service.stage({ ...target, files: [{ name: 'large.log', data }] })
  await service.deliver({ ...target, ids: [file.id] }, (items) => { assert.ok(items[0].path.endsWith('large.log')) })
  assert.deepEqual(await readFile(join(directory, file.id, file.name)), data)
})

test('이미지 전달용 미리보기는 원본 파일명과 충돌해도 원본을 덮어쓰지 않는다', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lite-image-original-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const preview = Buffer.from('resized preview')
  const service = new AttachmentService(directory, () => `data:image/png;base64,${preview.toString('base64')}`)
  const [file] = await service.stage({ ...target, files: [{ name: 'codex-preview.png', data: png }] })
  assert.deepEqual(await readFile(file.path), png)
  const manifest = JSON.parse(await readFile(service.manifestPath(target.taskId), 'utf8'))
  assert.notEqual(manifest.files[file.reference].imagePath, file.path)
  assert.deepEqual(await readFile(manifest.files[file.reference].imagePath), preview)
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
  assert.equal(await readFile(file.path, 'utf8'), 'keep')
  await service.discard({ ...renewed, ids: [file.id] })
  assert.deepEqual((await readdir(directory)).filter((name) => name !== 'references'), [])
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
  assert.deepEqual((await readdir(directory)).filter((name) => name !== 'references'), [])
  const results = await Promise.allSettled([service.stage({ ...target, files: Array(11).fill(tiny) }),
    service.stage({ ...target, files: Array(11).fill(tiny) })])
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1)
  assert.equal(service.list(target).length, 11)
  assert.equal(attachmentName('../../CON.txt'), '_CON.txt')
  assert.equal(attachmentName('..\\name?.md'), 'name_.md')
  assert.ok(Buffer.byteLength(attachmentName('한'.repeat(200) + '.txt')) <= 180)
})
