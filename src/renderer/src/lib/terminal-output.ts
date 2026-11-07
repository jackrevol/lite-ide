// ConPTY/CLI의 다시 그리기는 커서 숨김과 표시가 서로 다른 청크로 도착할 수 있습니다.
// 짧은 숨김 구간은 한 번에 쓰고, 실제 숨김은 제한 시간 후 그대로 반영합니다.
export function createTerminalOutput(write: (data: string) => void, delay = 80) {
  let state: 'text' | 'escape' | 'csi' | 'string' | 'stringEscape' = 'text'
  let csi = ''
  let osc = false
  let hidden = false
  let holding = false
  let pending = ''
  let timer: ReturnType<typeof setTimeout> | undefined

  const flush = () => {
    clearTimeout(timer)
    timer = undefined
    holding = false
    const data = pending
    pending = ''
    if (data) write(data)
  }
  const scan = (data: string) => {
    for (const char of data) {
      // 문자열 제어 시퀀스 안의 텍스트를 커서 명령으로 해석하지 않습니다.
      if (state === 'string' || state === 'stringEscape') {
        if (char === '\x9c' || (osc && char === '\x07') ||
          (state === 'stringEscape' && char === '\\') || char === '\x18' || char === '\x1a') state = 'text'
        else state = char === '\x1b' ? 'stringEscape' : 'string'
        continue
      }
      if (char === '\x18' || char === '\x1a') { state = 'text'; continue }
      if (char === '\x1b') { state = 'escape'; continue }
      if (char === '\x9b') { state = 'csi'; csi = ''; continue }
      if (state === 'escape') {
        if (char === '[') { state = 'csi'; csi = '' }
        else if (']PX^_'.includes(char)) { state = 'string'; osc = char === ']' }
        else if (char >= '0' && char <= '~') state = 'text'
      } else if (state === 'csi') {
        if (char >= '@' && char <= '~') {
          if ((char === 'h' || char === 'l') && /^\?[\d;]+$/.test(csi) &&
            csi.slice(1).split(';').some((param) => Number(param) === 25)) {
            if (char === 'l' && !hidden) {
              holding = true
              // 연속 출력이 와도 대기 시간을 연장하지 않습니다.
              timer ??= setTimeout(flush, delay)
            } else if (char === 'h') holding = false
            hidden = char === 'l'
          }
          state = 'text'
        } else if (char >= ' ' && char <= '?') {
          csi += char
          if (csi.length > 256) state = 'text'
        }
      }
    }
  }
  return {
    write(data: string) {
      scan(data)
      pending += data
      if (!holding || pending.length >= 262144) flush()
    },
    flush,
    dispose() { clearTimeout(timer); pending = '' },
  }
}
