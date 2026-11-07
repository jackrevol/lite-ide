import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTerminalOutput } from './terminal-output.ts'

test('분할된 커서 숨김·그리기·표시는 중간 화면 없이 원문 그대로 전달한다', () => {
  const writes: string[] = []
  const output = createTerminalOutput((data) => writes.push(data))
  output.write('before')
  output.write('\x1b[?25l\r\x1b[K')
  output.write('한글 입력')
  assert.deepEqual(writes, ['before'])
  output.write('\x1b[?25h')
  assert.deepEqual(writes, ['before', '\x1b[?25l\r\x1b[K한글 입력\x1b[?25h'])
  output.dispose()
})

test('모든 청크 경계에서 복합 DEC 모드와 분할 CSI를 보존한다', () => {
  const frame = '\x1b[?12;25l한글\x1b[?12;25h'
  for (let split = 1; split < frame.length; split++) {
    const writes: string[] = []
    const output = createTerminalOutput((data) => writes.push(data))
    output.write(frame.slice(0, split))
    // 완성된 숨김 명령이 있으면 아직 렌더러에 전달하지 않습니다.
    assert.ok(!writes.join('').includes('\x1b[?12;25l'))
    output.write(frame.slice(split))
    assert.equal(writes.join(''), frame)
    output.dispose()
  }
})

test('지속적인 숨김은 기한 내 반영하고 추가 출력으로 기한을 연장하지 않는다', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const writes: string[] = []
  const output = createTerminalOutput((data) => writes.push(data))
  output.write('\x1b[?25l')
  context.mock.timers.tick(60)
  output.write('working')
  context.mock.timers.tick(20)
  assert.deepEqual(writes, ['\x1b[?25lworking'])
  output.write('more')
  assert.equal(writes.at(-1), 'more')
  output.write('\x1b[?25h')
  assert.equal(writes.at(-1), '\x1b[?25h')
  output.dispose()
})

test('OSC/DCS 안의 가짜 커서 명령은 출력을 지연시키지 않는다', () => {
  for (const control of ['\x1b]title\x1b[?25l\x07', '\x1bPpayload\x1b[?25l\x1b\\']) {
    const writes: string[] = []
    const output = createTerminalOutput((data) => writes.push(data))
    for (const char of control) output.write(char)
    assert.equal(writes.join(''), control)
    output.write('normal')
    assert.equal(writes.at(-1), 'normal')
    output.dispose()
  }
})

test('출력량 제한·종료 flush·dispose 후 타이머 정리를 보장한다', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const writes: string[] = []
  const output = createTerminalOutput((data) => writes.push(data))
  output.write('\x1b[?25l' + 'x'.repeat(262144))
  assert.equal(writes.length, 1)
  output.write('\x1b[?25h')
  output.write('\x1b[?25lending')
  output.flush()
  assert.equal(writes.at(-1), '\x1b[?25lending')
  output.write('\x1b[?25h')
  output.write('\x1b[?25lunused')
  output.dispose()
  context.mock.timers.tick(100)
  assert.ok(!writes.join('').includes('unused'))
})
