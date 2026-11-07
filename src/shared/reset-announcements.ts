import type { ResetAnnouncement } from './types.ts'

export const resetAnnouncementSource = 'https://codexreset.ai'
export const resetAnnouncementLabels: Record<ResetAnnouncement['kind'], string> = {
  announced: '리셋 예고', hinted: '리셋 암시', regular: '리셋 공지', banked: '초기화권 지급 공지',
}

export function isResetAnnouncementUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https:\/\/x\.com\/thsottiaux\/status\/\d+$/.test(value)
}
