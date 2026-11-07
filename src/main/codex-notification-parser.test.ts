import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CodexNotificationParser } from './codex-notification-parser.ts'

test('Codex OSC9의 모든 청크 경계와 BEL/ST 종료를 처리하고 일반 출력은 무시한다', () => {
  const samples = [
    ['Approval requested: cargo test', 'approval'],
    ['Approval requested by server', 'approval'],
    ['Codex wants to edit 2 files', 'approval'],
    ['Plan mode prompt: Implement?', 'plan'],
    ['Question: Which option?', 'question'],
  ]
  for (const [body, kind] of samples) for (const end of ['\x07', '\x1b\\']) {
    const message = `\x1b]9;${body}${end}`
    for (let split = 0; split <= message.length; split++) {
      const received: string[] = []
      const parser = new CodexNotificationParser((value) => received.push(value))
      parser.feed(message.slice(0, split)); parser.feed(message.slice(split))
      assert.deepEqual(received, [kind], `split ${split}: ${body}`)
    }
  }
  const received: string[] = []
  const parser = new CodexNotificationParser((value) => received.push(value))
  parser.feed('Question: ordinary text?\x07\x1b]0;Question: title\x07\x1b]9;Agent turn complete\x07')
  parser.feed(`\x1b]9;Question: ${'x'.repeat(100000)}\x07`)
  parser.feed('\x1b]9;Question: valid\x07')
  assert.deepEqual(received, ['question'])
})

test('재출력은 2초만 억제하고 사용자 입력 뒤와 다음 질문은 다시 알린다', () => {
  let time = 0
  let count = 0
  const parser = new CodexNotificationParser(() => { count++ }, () => time)
  const message = '\x1b]9;Question: repeated\x07'
  parser.feed(message); parser.feed(message)
  assert.equal(count, 1)
  time = 2000; parser.feed(message)
  assert.equal(count, 2)
  parser.answered(); parser.feed(message)
  assert.equal(count, 3)
  const failing = new CodexNotificationParser(() => { throw new Error('OS notification failed') })
  assert.doesNotThrow(() => failing.feed(message))
})
