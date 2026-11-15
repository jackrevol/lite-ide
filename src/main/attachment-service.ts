import { mkdir, open, rm, stat, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { maxAttachmentBytes, maxAttachmentCount, maxAttachmentTotalBytes } from '../shared/attachments.ts'
import type { Attachment, AttachmentPreview, AttachmentSelection, AttachmentTarget, StageAttachmentsInput } from '../shared/attachments.ts'

type Stored = { target: AttachmentTarget; attachment: Attachment; path: string; ready: boolean; delivering: boolean; removing?: boolean }
export type DeliveredAttachment = { path: string; kind: Attachment['kind'] }

function imageExtension(data: Uint8Array): string | undefined {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return '.png'
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return '.jpg'
  if (['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('ascii'))) return '.gif'
  if (b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp'
  return undefined
}

export function attachmentName(name: string): string {
  let leaf = (name.split(/[\\/]/).at(-1) || 'attachment').normalize('NFC')
    .replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_').replace(/[. ]+$/, '')
  if (!leaf || leaf === '.' || leaf === '..') leaf = 'attachment'
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(leaf)) leaf = `_${leaf}`
  const extension = Array.from(extname(leaf)).slice(0, 16).join('')
  let stem = leaf.slice(0, leaf.length - extname(leaf).length)
  while (Buffer.byteLength(stem + extension, 'utf8') > 180) stem = Array.from(stem).slice(0, -1).join('')
  return (stem || 'attachment') + extension
}

export class AttachmentService {
  private drafts = new Map<string, Stored>()
  private directory: string
  private imagePreview?: (path: string, size: number) => string
  constructor(directory: string, imagePreview?: (path: string, size: number) => string) {
    this.directory = directory
    this.imagePreview = imagePreview
  }

  list(target: AttachmentTarget): Attachment[] {
    return [...this.drafts.values()].filter((item) => item.ready && !item.removing &&
      item.target.taskId === target.taskId && item.target.generation === target.generation)
      .map((item) => ({ ...item.attachment }))
  }

  restore(target: AttachmentTarget): Attachment[] {
    for (const item of this.drafts.values())
      if (item.target.taskId === target.taskId && item.ready && !item.delivering && !item.removing) item.target = { ...target }
    return this.list(target)
  }

  private owned(target: AttachmentTarget, id: string): Stored {
    const item = this.drafts.get(id)
    if (!item || item.target.taskId !== target.taskId || item.target.generation !== target.generation)
      throw new Error('첨부 파일이 없거나 다른 작업의 파일입니다. 다시 첨부해 주세요.')
    return item
  }

  async stage(input: StageAttachmentsInput): Promise<Attachment[]> {
    if (!input || typeof input.taskId !== 'string' || typeof input.generation !== 'string' ||
      !Array.isArray(input.files) || !input.files.length || input.files.length > maxAttachmentCount)
      throw new Error(`파일은 최대 ${maxAttachmentCount}개까지 첨부할 수 있습니다.`)
    const current = [...this.drafts.values()].filter((item) => item.target.taskId === input.taskId && item.target.generation === input.generation)
    let total = current.reduce((sum, item) => sum + item.attachment.size, 0)
    if (current.length + input.files.length > maxAttachmentCount)
      throw new Error(`파일은 최대 ${maxAttachmentCount}개까지 첨부할 수 있습니다.`)
    const entries = input.files.map((file): Stored => {
      if (!file || typeof file.name !== 'string' || !(file.data instanceof Uint8Array))
        throw new Error('올바른 첨부 파일을 선택해 주세요.')
      if (file.data.byteLength > maxAttachmentBytes) throw new Error('파일 하나는 50MB까지 첨부할 수 있습니다.')
      total += file.data.byteLength
      if (total > maxAttachmentTotalBytes) throw new Error('첨부 파일의 합계는 100MB까지 가능합니다.')
      const image = imageExtension(file.data)
      let name = attachmentName(file.name)
      if (!image && /\.(png|jpe?g|gif|webp)$/i.test(name)) throw new Error(`${name}: 이미지를 읽을 수 없습니다.`)
      if (image && extname(name).toLowerCase().replace('.jpeg', '.jpg') !== image)
        name = name.slice(0, name.length - extname(name).length) + image
      const id = crypto.randomUUID()
      return { target: { taskId: input.taskId, generation: input.generation },
        attachment: { id, name, size: file.data.byteLength, digest: createHash('sha256').update(file.data).digest('hex'), kind: image ? 'image' : 'file' },
        path: join(this.directory, id, name), ready: false, delivering: false }
    })
    // 첫 await 전에 예약하여 동시 업로드도 전체 개수와 크기 제한을 지킵니다.
    for (const item of entries) this.drafts.set(item.attachment.id, item)
    try {
      for (const [index, item] of entries.entries()) {
        await mkdir(join(this.directory, item.attachment.id), { recursive: true })
        await writeFile(item.path, input.files[index].data, { flag: 'wx', mode: 0o600 })
        if (item.attachment.kind === 'image' && this.imagePreview)
          item.attachment.thumbnail = this.imagePreview(item.path, 96)
        item.ready = true
      }
      return entries.map((item) => ({ ...item.attachment }))
    } catch (error) {
      await this.discard({ ...input, ids: entries.map((item) => item.attachment.id) })
      throw error
    }
  }

  async discard(input: AttachmentSelection): Promise<void> {
    const items = input.ids.map((id) => this.owned(input, id))
    if (items.some((item) => item.delivering || item.removing)) throw new Error('처리 중인 첨부 파일은 잠시 후 제거해 주세요.')
    for (const item of items) item.removing = true
    try {
      for (const item of items) {
        await rm(join(this.directory, item.attachment.id), { recursive: true, force: true })
        this.drafts.delete(item.attachment.id)
      }
    } finally { for (const item of items) item.removing = false }
  }

  async deliver(input: AttachmentSelection, send: (files: DeliveredAttachment[]) => void): Promise<void> {
    if (!Array.isArray(input.ids) || !input.ids.length || new Set(input.ids).size !== input.ids.length)
      throw new Error('전달할 첨부 파일을 선택해 주세요.')
    const items = input.ids.map((id) => this.owned(input, id))
    if (items.some((item) => !item.ready || item.delivering || item.removing)) throw new Error('첨부 파일을 처리하고 있습니다. 잠시 후 다시 시도해 주세요.')
    for (const item of items) item.delivering = true
    try {
      for (const item of items) if (!(await stat(item.path)).isFile()) throw new Error(`${item.attachment.name}: 파일을 읽을 수 없습니다.`)
      send(items.map((item) => ({ path: item.path, kind: item.attachment.kind })))
      // 전달한 원본은 Codex 대화 재개 시에도 읽을 수 있도록 보존합니다.
      for (const item of items) this.drafts.delete(item.attachment.id)
    } finally { for (const item of items) item.delivering = false }
  }

  async preview(target: AttachmentTarget, id: string): Promise<AttachmentPreview> {
    const item = this.owned(target, id)
    if (!item.ready) throw new Error('파일을 준비하고 있습니다.')
    const result: AttachmentPreview = { name: item.attachment.name, size: item.attachment.size }
    if (item.attachment.kind === 'image' && this.imagePreview)
      return { ...result, image: this.imagePreview(item.path, 1280) }
    if (/\.(pdf|zip|docx?|xlsx?|pptx?|gz|7z|exe|dll)$/i.test(item.attachment.name)) return result
    const handle = await open(item.path, 'r')
    try {
      const buffer = Buffer.alloc(Math.min(item.attachment.size, 64 * 1024))
      const { bytesRead } = await handle.read(buffer)
      const bytes = buffer.subarray(0, bytesRead)
      if (bytes.includes(0)) return result
      const truncated = item.attachment.size > bytesRead
      try { return { ...result, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: truncated }), truncated } }
      catch { return result }
    } finally { await handle.close() }
  }
}
