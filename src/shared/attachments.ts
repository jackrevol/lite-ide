export const maxAttachmentCount = 20
export const maxAttachmentBytes = 50 * 1024 * 1024
export const maxAttachmentTotalBytes = 100 * 1024 * 1024
export interface AttachmentTarget { taskId: string; generation: string }
export interface AttachmentUpload { name: string; data: Uint8Array }
export interface StageAttachmentsInput extends AttachmentTarget { files: AttachmentUpload[] }
export interface AttachmentSelection extends AttachmentTarget { ids: string[] }
export interface Attachment {
  id: string
  name: string
  size: number
  digest: string
  path: string
  kind: 'image' | 'file'
  thumbnail?: string
}
export interface AttachmentPreview {
  name: string
  size: number
  image?: string
  text?: string
  truncated?: boolean
}

// 미리보기와 실제 터미널 입력에서 같은 경로·공백 형식을 사용합니다.
export function attachmentInput(file: { path: string; kind: Attachment['kind'] }): string {
  const quoted = JSON.stringify(file.path.replaceAll('\\', '/'))
  return file.kind === 'image' ? quoted : ` ${quoted} `
}

export function initialAttachmentPrompt(prompt: string, files: Attachment[]): string {
  if (!files.length) return prompt
  const paths = files.filter((file) => file.kind === 'file').map((file) => JSON.stringify(file.path.replaceAll('\\', '/')))
  return (prompt.trim() || '첨부 파일을 확인해 주세요.') + (paths.length ? `\n\n첨부 파일:\n${paths.join('\n')}` : '')
}
