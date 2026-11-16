export const browserOptions = [
  { value: 'chrome', label: 'Google Chrome (기본)' },
  { value: 'msedge', label: 'Microsoft Edge' },
  { value: 'disabled', label: '사용 안 함' },
] as const

export type BrowserSettings = { browser: typeof browserOptions[number]['value'] }
export type BrowserCheck = { ok: boolean; message: string }
export const defaultBrowserSettings: BrowserSettings = { browser: 'chrome' }

export function validateBrowserSettings(value: unknown): BrowserSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    !browserOptions.some((option) => option.value === (value as BrowserSettings).browser))
    throw new Error('사용할 브라우저를 목록에서 선택해 주세요.')
  return { browser: (value as BrowserSettings).browser }
}
