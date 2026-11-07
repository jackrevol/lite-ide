import type { AttentionKind } from './notification-service.ts'

// PTY 청크 경계와 무관하게 OSC만 읽고 일반 터미널 텍스트는 해석하지 않습니다.
export class CodexNotificationParser {
  private state: 'text' | 'escape' | 'osc' | 'osc-escape' = 'text'
  private body = ''
  private overflow = false
  private seen = new Map<string, number>()
  private receive: (kind: AttentionKind) => void
  private now: () => number
  constructor(receive: (kind: AttentionKind) => void, now = Date.now) { this.receive = receive; this.now = now }
  answered() { this.seen.clear() }
  feed(chunk: string) {
    for (const character of chunk) {
      if (this.state === 'text') { if (character === '\x1b') this.state = 'escape'; continue }
      if (this.state === 'escape') {
        if (character === ']') { this.state = 'osc'; this.body = ''; this.overflow = false }
        else if (character !== '\x1b') this.state = 'text'
        continue
      }
      if (character === '\x07' || (this.state === 'osc-escape' && character === '\\')) {
        if (!this.overflow) this.complete()
        this.state = 'text'; this.body = ''; continue
      }
      if (character === '\x1b') { this.state = 'osc-escape'; continue }
      if (this.state === 'osc-escape') {
        // 중단된 OSC 이후 새 이스케이프 시퀀스로 재동기화합니다.
        this.state = character === ']' ? 'osc' : 'text'; this.body = ''; this.overflow = false; continue
      }
      if (this.body.length < 4096) this.body += character
      else this.overflow = true
    }
  }
  private complete() {
    if (!this.body.startsWith('9;')) return
    const time = this.now()
    const previous = this.seen.get(this.body)
    if (previous !== undefined && time - previous < 2000) return
    const text = this.body.slice(2)
    const kind: AttentionKind | undefined = /^(Approval requested: |Approval requested by |Codex wants to edit )/.test(text)
      ? 'approval' : text.startsWith('Plan mode prompt: ') ? 'plan' : text.startsWith('Question: ') ? 'question' : undefined
    if (!kind) return
    if (this.seen.size >= 100) this.seen.clear()
    this.seen.set(this.body, time)
    try { this.receive(kind) } catch { /* 알림 실패 후에도 터미널 출력을 계속 처리합니다. */ }
  }
}
