import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Terminal } from '@xterm/xterm'
import { installSteadyCursor } from './steady-cursor.ts'

test('CLI 커서 모양·기본 복원을 보존하며 blink 요청만 고정하고 구독을 정리한다', () => {
  let handler!: (params: (number | number[])[]) => boolean | Promise<boolean>
  let parsed!: () => void
  let disposed = 0
  const options: Terminal['options'] = { cursorStyle: 'block', cursorBlink: false }
  const terminal = {
    options,
    parser: { registerCsiHandler: (identifier: unknown, callback: typeof handler) => {
      assert.deepEqual(identifier, { intermediates: ' ', final: 'q' })
      handler = callback
      return { dispose() { disposed++ } }
    } },
    onWriteParsed: (callback: () => void) => { parsed = callback; return { dispose() { disposed++ } } },
  } as Pick<Terminal, 'parser' | 'options' | 'onWriteParsed'>
  const cleanup = installSteadyCursor(terminal)
  for (const [value, expected] of [[1, 'block'], [3, 'underline'], [5, 'bar'], [2, 'block'], [4, 'underline'], [6, 'bar'], [9, 'bar'], [0, 'block']] as const) {
    assert.equal(handler([value]), true)
    assert.equal(options.cursorStyle, expected)
    assert.equal(options.cursorBlink, false)
  }
  options.cursorBlink = true
  parsed()
  assert.equal(options.cursorBlink, false)
  assert.equal(options.cursorStyle, 'block')
  cleanup.dispose()
  assert.equal(disposed, 2)
})
