import type { Terminal } from '@xterm/xterm'

export function installSteadyCursor(terminal: Pick<Terminal, 'parser' | 'options' | 'onWriteParsed'>) {
  const defaultStyle = terminal.options.cursorStyle ?? 'block'
  const style = terminal.parser.registerCsiHandler({ intermediates: ' ', final: 'q' }, (params) => {
    const first = params[0] ?? 0
    const value = Array.isArray(first) ? first[0] : first
    // 커서 모양은 CLI 요청을 따르고 깜빡임만 고정합니다. 알 수 없는 모양은 유지합니다.
    if (value === 0) terminal.options.cursorStyle = defaultStyle
    else if (value === 1 || value === 2) terminal.options.cursorStyle = 'block'
    else if (value === 3 || value === 4) terminal.options.cursorStyle = 'underline'
    else if (value === 5 || value === 6) terminal.options.cursorStyle = 'bar'
    terminal.options.cursorBlink = false
    return true
  })
  // 복합 DEC 모드의 위치·표시 처리는 xterm에 맡기고 렌더링 전에 blink 옵션만 복원합니다.
  const parsed = terminal.onWriteParsed(() => {
    if (terminal.options.cursorBlink) terminal.options.cursorBlink = false
  })
  return { dispose() { style.dispose(); parsed.dispose() } }
}
