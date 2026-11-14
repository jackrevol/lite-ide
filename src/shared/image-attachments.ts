export const imageAccept = 'image/png,image/jpeg,image/webp,image/gif'
export const maxImageBytes = 20 * 1024 * 1024
export const maxImageCount = 10

export interface ImageUpload {
  name: string
  data: Uint8Array
}

export interface TerminalImageUpload {
  taskId: string
  generation: string
  images: ImageUpload[]
}
