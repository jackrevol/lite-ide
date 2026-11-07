import type { ResetAnnouncement, ResetAnnouncementState } from '../shared/types.ts'
import { isResetAnnouncementUrl, resetAnnouncementSource } from '../shared/reset-announcements.ts'

const interval = 5 * 60_000
const maxAge = 72 * 60 * 60_000
type Request = (url: string, init?: RequestInit) => Promise<Response>
const timestamp = (value: unknown): number | null =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

export function parseResetAnnouncements(value: unknown, now: number) {
  const data = object(value)
  const generatedAt = timestamp(data.generated_at)
  if (data.schema_version !== 1 || generatedAt === null || !Array.isArray(data.events) ||
    !Object.hasOwn(data, 'scheduled') || data.events.length > 2000 || generatedAt > now + interval)
    throw new Error('리셋 공지 서비스의 응답 형식이 변경되었습니다.')
  const announcements: ResetAnnouncement[] = []
  for (const item of data.events) {
    const event = object(item)
    const publishedAt = timestamp(event.announced_at) ?? timestamp(event.ts)
    if (!isResetAnnouncementUrl(event.url) || publishedAt === null || publishedAt > now + interval ||
      !['regular', 'banked'].includes(String(event.kind))) continue
    announcements.push({
      id: `${event.kind}:${event.url}`, kind: event.kind as 'regular' | 'banked',
      url: event.url, publishedAt,
      text: typeof event.summary === 'string' ? event.summary.slice(0, 1500) : '',
      scheduledAt: null, scheduledDay: null, deliveredAt: timestamp(event.delivered_at),
    })
  }
  if (data.scheduled !== null) {
    const event = object(data.scheduled)
    const publishedAt = timestamp(event.announced_at)
    if (!isResetAnnouncementUrl(event.url) || publishedAt === null ||
      !['announced', 'hinted'].includes(String(event.certainty)))
      throw new Error('리셋 예고 정보를 해석할 수 없습니다.')
    const scheduledAt = timestamp(event.scheduled_for)
    // 오래된 예고를 다음 리셋 일정으로 다시 표시하지 않습니다.
    if (publishedAt <= now + interval && now - publishedAt <= maxAge &&
      (scheduledAt === null || scheduledAt > now))
      announcements.push({
        id: `${event.certainty}:${event.url}:${event.scheduled_for ?? event.day ?? ''}`,
        kind: event.certainty as 'announced' | 'hinted', url: event.url, publishedAt,
        text: '', scheduledAt,
        scheduledDay: typeof event.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(event.day) ? event.day : null,
        deliveredAt: null,
      })
  }
  return { generatedAt, announcements: announcements.sort((a, b) => b.publishedAt - a.publishedAt) }
}

export class ResetAnnouncementService {
  private state: ResetAnnouncementState = {
    checkedAt: null, generatedAt: null, error: null, announcements: [],
  }
  private timer?: ReturnType<typeof setInterval>
  private pending?: Promise<ResetAnnouncementState>
  private generation = 0
  private controller?: AbortController
  private changed: (state: ResetAnnouncementState) => void
  private request: Request
  private now: () => number

  constructor(
    changed: (state: ResetAnnouncementState) => void,
    request: Request = fetch,
    now = Date.now,
  ) {
    this.changed = changed; this.request = request; this.now = now
  }

  status() { return structuredClone(this.state) }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => void this.refresh(), interval)
    this.timer.unref()
    void this.refresh()
  }

  close() {
    this.generation++
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.controller?.abort()
  }

  refresh(): Promise<ResetAnnouncementState> {
    if (this.pending) return this.pending
    const generation = this.generation
    this.pending = this.read(generation).finally(() => { this.pending = undefined })
    return this.pending
  }

  private async read(generation: number) {
    try {
      this.controller = new AbortController()
      const response = await this.request(`${resetAnnouncementSource}/api/v1/resets.json`, {
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15_000)]),
        redirect: 'error', credentials: 'omit',
      })
      if (!response.ok) throw new Error(`리셋 공지 조회 실패 (HTTP ${response.status})`)
      if (Number(response.headers.get('content-length')) > 2 * 1024 * 1024)
        throw new Error('리셋 공지 응답이 너무 큽니다.')
      const reader = response.body!.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.length
          if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('리셋 공지 응답이 너무 큽니다.') }
          chunks.push(value)
        }
      } finally { reader.releaseLock() }
      const now = this.now()
      const parsed = parseResetAnnouncements(JSON.parse(Buffer.concat(chunks).toString('utf8')), now)
      if (generation !== this.generation) return this.status()
      this.state = { checkedAt: now, generatedAt: parsed.generatedAt,
        error: now - parsed.generatedAt > 30 * 60_000
          ? '제공처 데이터가 30분 이상 갱신되지 않았습니다. 나중에 다시 확인합니다.' : null,
        announcements: parsed.announcements.filter((event, index, all) =>
          all.findIndex((item) => item.kind === event.kind) === index) }
      this.changed(this.status())
    } catch (cause) {
      if (generation === this.generation) {
        this.state = { ...this.state, error: cause instanceof Error ? cause.message : String(cause) }
        this.changed(this.status())
      }
    }
    return this.status()
  }
}
