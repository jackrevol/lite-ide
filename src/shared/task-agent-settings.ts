import type { TaskAgentSettings } from './types'

export function validSubagentLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value + 1) && value >= 1
}

export function validateTaskAgentSettings(value: unknown): TaskAgentSettings {
  if (value && typeof value === 'object' && 'style' in value) {
    if (value.style === 'single') return { style: 'single' }
    if (value.style === 'delegated') {
      const { model, effort, maxConcurrent } = value as Record<string, unknown>
      if (typeof model === 'string' && /^[A-Za-z0-9._:/-]{0,300}$/.test(model) &&
        typeof effort === 'string' && /^[a-z0-9_-]{0,32}$/.test(effort) &&
        (maxConcurrent === undefined || validSubagentLimit(maxConcurrent))) {
        return { style: 'delegated', model, effort,
          ...(maxConcurrent !== undefined ? { maxConcurrent } : {}) }
      }
    }
  }
  throw new Error('서브에이전트 작업 설정이 올바르지 않습니다.')
}
