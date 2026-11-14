import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { maxImageBytes, maxImageCount, type ImageUpload } from '../shared/image-attachments.ts'

function extension(data: Uint8Array): string {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png'
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg'
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'gif'
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp'
  throw new Error('PNG, JPEG, WebP, GIF 이미지만 첨부할 수 있습니다.')
}

// 첨부 원본은 프로젝트 변경 사항에 섞지 않고 앱 데이터에 보존합니다.
export async function storeImages(directory: string, images: ImageUpload[]): Promise<string[]> {
  if (!Array.isArray(images) || !images.length || images.length > maxImageCount)
    throw new Error(`이미지는 한 번에 ${maxImageCount}개까지 첨부할 수 있습니다.`)
  let size = 0
  const files = images.map((image) => {
    if (!image || typeof image.name !== 'string' || !(image.data instanceof Uint8Array) || !image.data.byteLength)
      throw new Error('올바른 이미지 파일을 선택해 주세요.')
    size += image.data.byteLength
    if (size > maxImageBytes) throw new Error('이미지 첨부는 한 번에 총 20MB까지 가능합니다.')
    return join(directory, `${crypto.randomUUID()}.${extension(image.data)}`)
  })
  await mkdir(directory, { recursive: true })
  const saved: string[] = []
  try {
    for (const [index, file] of files.entries()) {
      await writeFile(file, images[index].data, { flag: 'wx', mode: 0o600 })
      saved.push(file)
    }
    return saved
  } catch (error) {
    await removeImages(saved)
    throw error
  }
}

export async function removeImages(files: string[]): Promise<void> {
  await Promise.all(files.map((file) => rm(file, { force: true })))
}
