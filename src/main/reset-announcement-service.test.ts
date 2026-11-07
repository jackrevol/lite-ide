import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseResetAnnouncements, ResetAnnouncementService } from './reset-announcement-service.ts'

const now = Date.parse('2026-11-07T09:00:00Z')
const url = 'https://x.com/thsottiaux/status/12345'
const event = { kind: 'banked', url, announced_at: '2026-11-06T09:00:00Z', summary: 'Banked 2/2' }
const snapshot = (extra = {}) => ({ schema_version: 1, generated_at: new Date(now).toISOString(),
  events: [event], scheduled: null, ...extra })
const scheduled = { certainty: 'announced', url, announced_at: '2026-11-07T08:00:00Z',
  scheduled_for: '2026-11-07T10:00:00Z', day: '2026-11-07' }

test('초기화권 지급, 리셋 공지, 예고와 암시를 구분하고 날짜의 시간대를 추정하지 않는다', () => {
  const data = parseResetAnnouncements(snapshot({ scheduled, events: [event,
    { ...event, kind: 'regular', delivered_at: '2026-11-06T10:00:00Z' }] }), now)
  assert.deepEqual(data.announcements.map((item) => item.kind), ['announced', 'banked', 'regular'])
  assert.equal(data.announcements[0].scheduledAt, Date.parse(scheduled.scheduled_for))
  assert.equal(data.announcements[1].deliveredAt, null)
  assert.equal(data.announcements[2].deliveredAt, Date.parse('2026-11-06T10:00:00Z'))
  const hint = parseResetAnnouncements(snapshot({ scheduled: { ...scheduled, certainty: 'hinted', scheduled_for: null } }), now).announcements[0]
  assert.equal(hint.kind, 'hinted'); assert.equal(hint.scheduledAt, null)
  assert.equal(hint.scheduledDay, '2026-11-07')
})

test('외부 주소, 오래되거나 지난 예고, 지원하지 않는 응답을 처리한다', () => {
  for (const bad of ['javascript:alert(1)', 'https://x.com.evil.test/thsottiaux/status/1', 'https://x.com/other/status/1']) {
    assert.equal(parseResetAnnouncements(snapshot({ events: [{ ...event, url: bad }] }), now).announcements.length, 0)
    assert.throws(() => parseResetAnnouncements(snapshot({ scheduled: { ...scheduled, url: bad } }), now))
  }
  for (const old of [{ ...scheduled, scheduled_for: '2026-11-07T08:30:00Z' },
    { ...scheduled, announced_at: '2026-11-01T08:00:00Z', scheduled_for: null }])
    assert.deepEqual(parseResetAnnouncements(snapshot({ scheduled: old }), now).announcements.map((item) => item.kind), ['banked'])
  for (const bad of [null, { ...snapshot(), schema_version: 2 }, { ...snapshot(), scheduled: undefined },
    { ...snapshot(), generated_at: 'invalid' }, { ...snapshot(), events: {} }])
    assert.throws(() => parseResetAnnouncements(bad, now))
})

test('조회 중복을 합치고 최신 종류별 공지를 전달하며 실패 후 복구한다', async () => {
  let calls = 0, fail = false
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const service = new ResetAnnouncementService(() => {}, async (input, init) => {
    assert.equal(input, 'https://codexreset.ai/api/v1/resets.json')
    assert.equal(init?.credentials, 'omit')
    calls++; await gate
    return fail ? new Response('', { status: 503 }) : Response.json(snapshot({
      events: [{ ...event, announced_at: '2026-11-01T08:00:00Z' }, event], scheduled,
    }))
  }, () => now)
  const first = service.refresh(); const second = service.refresh()
  assert.equal(first, second); assert.equal(calls, 1); release()
  const state = await first
  assert.equal(state.checkedAt, now); assert.equal(state.error, null)
  assert.equal(state.announcements.length, 2)
  assert.equal(state.announcements[1].publishedAt, Date.parse(event.announced_at))
  state.announcements.length = 0
  assert.equal(service.status().announcements.length, 2)
  fail = true
  assert.match((await service.refresh()).error!, /503/)
  assert.equal(service.status().announcements.length, 2)
  fail = false
  assert.equal((await service.refresh()).error, null)
  service.close()
})

test('오래된 제공처 데이터와 과도한 응답을 오류로 표시한다', async () => {
  const stale = new ResetAnnouncementService(() => {}, async () =>
    Response.json(snapshot({ generated_at: '2026-11-07T08:00:00Z' })), () => now)
  const saved = await stale.refresh()
  assert.match(saved.error!, /30분/)
  assert.equal(saved.checkedAt, now)
  assert.equal(saved.announcements[0].kind, 'banked')
  stale.close()
  for (const response of [
    new Response('x'.repeat(2 * 1024 * 1024 + 1)),
    new Response('invalid JSON'),
  ]) {
    const service = new ResetAnnouncementService(() => {}, async () => response, () => now)
    const state = await service.refresh()
    assert.ok(state.error); assert.equal(state.checkedAt, null)
    service.close()
  }
})

test('종료 시 진행 중인 조회를 취소하고 늦게 도착한 응답을 무시한다', async () => {
  let publish = 0, signal: AbortSignal | undefined
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const service = new ResetAnnouncementService(() => { publish++ }, async (_input, init) => {
    signal = init?.signal ?? undefined
    await gate
    return Response.json(snapshot())
  }, () => now)
  const pending = service.refresh()
  service.close(); assert.equal(signal?.aborted, true)
  release(); await pending
  assert.equal(publish, 0); assert.equal(service.status().checkedAt, null)
})
