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
