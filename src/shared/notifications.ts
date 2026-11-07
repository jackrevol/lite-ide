import type { NotificationSettings, NotificationSound } from './types.ts'

export const notificationSounds: { id: Exclude<NotificationSound, 'custom'>; name: string }[] = [
  { id: 'chime', name: '차임' },
  { id: 'bell', name: '벨' },
  { id: 'glass', name: '유리' },
  { id: 'pulse', name: '펄스' },
  { id: 'gentle', name: '잔잔한 알림' },
]
export const defaultNotificationSettings: NotificationSettings = {
  enabled: true, soundEnabled: true, sound: 'chime', volume: 70,
}

export function validateNotificationSettings(value: unknown): NotificationSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('알림 설정이 올바르지 않습니다.')
  const input = value as NotificationSettings
  if (typeof input.enabled !== 'boolean' || typeof input.soundEnabled !== 'boolean' ||
    ![...notificationSounds.map((sound) => sound.id), 'custom'].includes(input.sound) ||
    !Number.isFinite(input.volume) || input.volume < 0 || input.volume > 100)
    throw new Error('알림 설정 값이 올바르지 않습니다.')
  const custom = input.customSound
  if (custom !== undefined && (!custom || typeof custom.name !== 'string' || !custom.name ||
    custom.name.length > 255 || /[\x00-\x1f\x7f]/.test(custom.name) ||
    typeof custom.fileName !== 'string' || !/^[a-f0-9-]{36}\.(wav|mp3|ogg)$/.test(custom.fileName)))
    throw new Error('사용자 알림음이 올바르지 않습니다.')
  if (input.sound === 'custom' && !custom)
    throw new Error('사용자 알림음 파일을 먼저 선택해 주세요.')
  return {
    enabled: input.enabled, soundEnabled: input.soundEnabled, sound: input.sound,
    volume: input.volume,
    ...(custom ? { customSound: { fileName: custom.fileName, name: custom.name } } : {}),
  }
}
