import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { builtinSound, NotificationService, type AttentionNotification } from './notification-service.ts'
import { defaultNotificationSettings, notificationSounds, validateNotificationSettings } from '../shared/notifications.ts'
import type { AgentSession, NotificationSettings, NotificationTarget } from '../shared/types.ts'

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
test('알림/소리 토글, 중복 억제, 클릭 이동과 headless 차단을 처리한다', async () => {
  let settings = { ...defaultNotificationSettings }
  let shown = 0, played = 0, time = 0
  let click = () => {}
  let activated: NotificationTarget | undefined
  const driver = { supported: () => true,
    show: (_title: string, body: string, callback: () => void) => { shown++; click = callback; assert.ok(body.includes('Codex')) },
    play: async (_data: string, volume: number) => { played++; assert.equal(volume, settings.volume / 100) },
    activate: (target: NotificationTarget) => { activated = target },
  }
  const service = new NotificationService('', async () => ({ notifications: settings }), driver, false, () => time)
  const event: AttentionNotification = { workspace: '/project/task', taskId: 'one', kind: 'question', source: 'terminal', identity: '1' }
  service.notify(event); service.notify(event)
  await flush()
  assert.deepEqual([shown, played], [1, 1]); click(); assert.equal(activated?.taskId, 'one')
  service.notify({ ...event, source: 'session', identity: 'rpc-1' }); await flush()
  assert.equal(shown, 1)
  settings = { ...settings, soundEnabled: false }; time = 3000
  service.notify({ ...event, identity: '2' }); await flush()
  assert.deepEqual([shown, played], [2, 1])
  settings = { ...settings, enabled: false }
  service.notify({ ...event, identity: '3' }); await flush()
  assert.deepEqual([shown, played], [2, 1])
  const headless = new NotificationService('', async () => ({ notifications: defaultNotificationSettings }), driver, true)
  headless.notify(event); await headless.preview(defaultNotificationSettings); await flush()
  assert.deepEqual([shown, played], [2, 1]); assert.equal(headless.status().supported, false)
})

test('동일 세션 요청 갱신은 재알림하지 않고 새 요청만 알린다', async () => {
  let shown = 0
  const service = new NotificationService('', async () => ({ notifications: { ...defaultNotificationSettings, soundEnabled: false } }), {
    supported: () => true, show: () => { shown++ }, play: async () => {}, activate: () => {},
  }, false)
  const session = { id: 'session', workspace: '/task', requests: [{ id: 'one', kind: 'questions', title: '', detail: '' }] } as AgentSession
  service.observeSession(session); service.observeSession(session)
  await flush(); assert.equal(shown, 1)
  service.observeSession({ ...session, requests: [...session.requests, { id: 'two', kind: 'approval', title: '', detail: '' }] })
  await flush(); assert.equal(shown, 2)
})

test('알림 전달 실패 후 다음 알림을 처리한다', async () => {
  let count = 0
  const service = new NotificationService('', async () => ({ notifications: defaultNotificationSettings }), {
    supported: () => true, show: () => { if (++count === 1) throw new Error('unavailable') },
    play: async () => {}, activate: () => {},
  }, false)
  const event: AttentionNotification = { workspace: '/task', kind: 'question', identity: '1', source: 'terminal' }
  service.notify(event); service.notify({ ...event, identity: '2' }); await flush()
  assert.equal(count, 2)
})

test('자동 알림의 커스텀 음원이 사라지면 기본 WAV를 재생한다', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lite-notifications-fallback-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let played = ''
  const settings: NotificationSettings = { ...defaultNotificationSettings, sound: 'custom',
    customSound: { fileName: '12345678-1234-1234-1234-123456789abc.wav', name: 'missing.wav' } }
  const service = new NotificationService(directory, async () => ({ notifications: settings }), {
    supported: () => true, show: () => {}, activate: () => {}, play: async (data) => { played = data },
  }, false)
  service.notify({ workspace: '/task', kind: 'question', identity: 'missing', source: 'terminal' })
  for (let attempt = 0; !played && attempt < 50; attempt++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(played, `data:audio/wav;base64,${builtinSound('chime').toString('base64')}`)
})

test('내장음 5종과 커스텀 파일 복사·검증·미리듣기 오류·미참조 정리를 처리한다', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lite-notifications-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'sounds')
  let settings: NotificationSettings = { ...defaultNotificationSettings }
  const played: string[] = []
  const service = new NotificationService(directory, async () => ({ notifications: settings }), {
    supported: () => true, show: () => {}, activate: () => {},
    play: async (data) => { played.push(data) },
  }, false)
  for (const sound of notificationSounds) {
    await service.preview({ ...settings, sound: sound.id })
    assert.equal(builtinSound(sound.id).toString('ascii', 0, 4), 'RIFF')
  }
  assert.equal(new Set(played).size, 5)
  const original = join(root, '사용자 음원.wav')
  await writeFile(original, builtinSound('bell'))
  const custom = await service.importSound(original)
  assert.equal(custom.name, '사용자 음원.wav')
  assert.notEqual(custom.fileName, custom.name)
  assert.deepEqual(await readFile(join(directory, custom.fileName)), await readFile(original))
  settings = { ...settings, sound: 'custom', customSound: custom }
  await rm(original); await service.preview(settings)
  const unused = await service.importSound(join(directory, custom.fileName))
  await service.cleanupSounds()
  assert.deepEqual(await readdir(directory), [custom.fileName])
  await assert.rejects(service.preview({ ...settings, customSound: unused }), /다시 선택/)
  await writeFile(join(root, 'fake.wav'), 'not a wave audio file', 'utf8')
  await assert.rejects(service.importSound(join(root, 'fake.wav')), /지원하는 음원/)
  await writeFile(join(root, 'large.wav'), Buffer.alloc(10 * 1024 * 1024 + 1))
  await assert.rejects(service.importSound(join(root, 'large.wav')), /10MB/)
  await assert.rejects(service.importSound(join(root, 'file.exe')), /WAV/)
  assert.throws(() => validateNotificationSettings({ ...settings, customSound: { name: 'bad', fileName: '../secret.wav' } }))
  assert.throws(() => validateNotificationSettings({ ...settings, volume: 101 }))
  const failing = new NotificationService(directory, async () => ({ notifications: settings }), {
    supported: () => true, show: () => {}, activate: () => {}, play: async () => { throw new Error('decode failed') },
  }, false)
  await assert.rejects(failing.preview(settings), /decode failed/)
})
