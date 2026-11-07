import { mkdir, open, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentSession, NotificationSettings, NotificationTarget } from '../shared/types.ts'
import { validateNotificationSettings } from '../shared/notifications.ts'

const maxSoundBytes = 10 * 1024 * 1024
export type AttentionKind = 'approval' | 'question' | 'plan'
export interface AttentionNotification extends NotificationTarget {
  kind: AttentionKind
  identity: string
  source: 'terminal' | 'session'
  scope?: string
}
interface NotificationDriver {
  supported(): boolean
  show(title: string, body: string, click: () => void): void
  play(dataUrl: string, volume: number): Promise<void>
  activate(target: NotificationTarget): void
}

export class NotificationService {
  private seen = new Set<string>()
  private recent = new Map<string, { source: string; time: number }>()
  private pending = Promise.resolve()
  private sessionRequests = new Map<string, Set<string>>()
  private directory: string
  private settings: () => Promise<{ notifications: NotificationSettings }>
  private driver: NotificationDriver
  private headless: boolean
  private now: () => number
  constructor(
    directory: string,
    settings: () => Promise<{ notifications: NotificationSettings }>,
    driver: NotificationDriver,
    headless = process.env.LITE_IDE_HEADLESS === '1',
    now = Date.now,
  ) {
    this.directory = directory; this.settings = settings; this.driver = driver
    this.headless = headless; this.now = now
  }

  status() { return { supported: this.headless ? false : this.driver.supported() } }

  async cleanupSounds() {
    const { notifications } = await this.settings()
    const files = await readdir(this.directory).catch(() => [])
    for (const file of files) {
      if (/^[a-f0-9-]{36}\.(wav|mp3|ogg)$/.test(file) && file !== notifications.customSound?.fileName)
        await rm(join(this.directory, file), { force: true })
    }
  }

  observeSession(session: AgentSession, terminalOwnsWorkspace = false) {
    const previous = this.sessionRequests.get(session.id) ?? new Set<string>()
    this.sessionRequests.set(session.id, new Set(session.requests.map((request) => request.id)))
    // 관리 CLI는 OSC가 우선이며 직접 RPC를 받는 하위 세션은 독립적으로 알립니다.
    if (terminalOwnsWorkspace && !session.parentSessionId) return
    for (const request of session.requests) {
      if (previous.has(request.id)) continue
      this.notify({ workspace: session.workspace, sessionId: session.id,
        kind: request.kind === 'questions' ? 'question' : 'approval',
        identity: `${session.id}:${request.id}`, source: 'session',
        ...(session.parentSessionId ? { scope: session.id } : {}) })
    }
  }

  notify(event: AttentionNotification) {
    const identity = `${event.source}:${event.identity}`
    if (this.seen.has(identity)) return
    this.seen.add(identity)
    if (this.seen.size > 4000) this.seen.delete(this.seen.values().next().value!)
    const key = `${process.platform === 'win32' ? event.workspace.toLowerCase() : event.workspace}:${event.scope ?? ''}:${event.kind === 'plan' ? 'question' : event.kind}`
    const time = this.now()
    const recent = this.recent.get(key)
    this.recent.set(key, { source: event.source, time })
    for (const [entry, value] of this.recent) if (time - value.time > 5000) this.recent.delete(entry)
    if (recent && recent.source !== event.source && time - recent.time < 2500) return
    if (this.headless) return
    this.pending = this.pending.catch(() => {}).then(async () => {
      const { notifications: settings } = await this.settings()
      if (!settings.enabled) return
      const body = `${basename(event.workspace)} · ${event.kind === 'approval'
        ? 'Codex가 승인을 기다리고 있습니다.' : event.kind === 'plan'
          ? 'Codex가 계획 확인을 기다리고 있습니다.' : 'Codex가 답변을 기다리고 있습니다.'}`
      if (this.driver.supported())
        this.driver.show('Lite IDE · 응답이 필요합니다', body, () => this.driver.activate(event))
      if (settings.soundEnabled) void this.preview(settings).catch(() => {
        if (settings.sound === 'custom')
          void this.preview({ ...settings, sound: 'chime' }).catch(() => {})
      })
    })
    // 운영체제 알림/오디오 실패가 Codex 실행을 방해하지 않게 합니다.
    void this.pending.catch(() => {})
  }

  async importSound(path: string) {
    const extension = extname(path).toLowerCase().slice(1)
    if (!['wav', 'mp3', 'ogg'].includes(extension))
      throw new Error('WAV, MP3, OGG 파일을 선택해 주세요.')
    const data = await readSound(path)
    validateAudio(data, extension)
    await mkdir(this.directory, { recursive: true })
    const fileName = `${randomUUID()}.${extension}`
    await writeFile(join(this.directory, fileName), data, { flag: 'wx' })
    return { fileName, name: basename(path) }
  }

  async preview(value: NotificationSettings) {
    const settings = validateNotificationSettings(value)
    let data: Buffer
    let mime = 'audio/wav'
    if (settings.sound === 'custom') {
      const fileName = settings.customSound!.fileName
      data = await readSound(join(this.directory, fileName)).catch(() => {
        throw new Error('사용자 알림음 파일을 읽을 수 없습니다. 파일을 다시 선택해 주세요.')
      })
      const extension = extname(fileName).slice(1)
      validateAudio(data, extension)
      mime = extension === 'mp3' ? 'audio/mpeg' : extension === 'ogg' ? 'audio/ogg' : 'audio/wav'
    } else data = builtinSound(settings.sound)
    if (this.headless) return
    await this.driver.play(`data:${mime};base64,${data.toString('base64')}`, settings.volume / 100)
  }
}

async function readSound(path: string) {
  const file = await open(path, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size < 12 || info.size > maxSoundBytes)
      throw new Error('알림음은 10MB 이하의 음원 파일이어야 합니다.')
    const buffer = Buffer.alloc(info.size + 1)
    let total = 0
    while (total < buffer.length) {
      const { bytesRead } = await file.read(buffer, total, buffer.length - total, total)
      if (!bytesRead) break
      total += bytesRead
    }
    if (total !== info.size) throw new Error('파일이 변경되었습니다. 다시 선택해 주세요.')
    return buffer.subarray(0, total)
  } finally { await file.close() }
}

function validateAudio(data: Buffer, extension: string) {
  const valid = extension === 'wav' ? data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WAVE'
    : extension === 'ogg' ? data.toString('ascii', 0, 4) === 'OggS'
      : data.toString('ascii', 0, 3) === 'ID3' || (data[0] === 0xff && (data[1] & 0xe0) === 0xe0)
  if (!valid) throw new Error('지원하는 음원 파일인지 확인해 주세요. WAV, MP3, OGG 파일을 사용할 수 있습니다.')
}

export function builtinSound(sound: Exclude<NotificationSettings['sound'], 'custom'>) {
  const notes = { chime: [659, 880], bell: [784], glass: [1175, 1568], pulse: [523, 523, 784], gentle: [440, 554, 659] }[sound]
  const rate = 22050
  const duration = notes.length * 0.18 + 0.18
  const samples = Math.floor(rate * duration)
  const data = Buffer.alloc(44 + samples * 2)
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8)
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22)
  data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28)
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36)
  data.writeUInt32LE(samples * 2, 40)
  for (let index = 0; index < samples; index++) {
    const time = index / rate
    const value = notes.reduce((sum, note, n) => {
      const elapsed = time - n * 0.18
      return sum + (elapsed >= 0 ? Math.sin(2 * Math.PI * note * elapsed) * Math.min(1, elapsed / 0.008) * Math.exp(-elapsed * 12) : 0)
    }, 0)
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value * 0.28)) * 32767), 44 + index * 2)
  }
  return data
}
