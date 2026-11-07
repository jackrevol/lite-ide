import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import './TaskTerminal.css'
import '@xterm/xterm/css/xterm.css'
import type { TerminalEvent, TerminalSnapshot } from '../../../shared/types'
import type { WorkspaceTask } from '../lib/workspace-state'
import { Button } from './ui/button'
import { installSteadyCursor } from '../lib/steady-cursor'
import { createTerminalOutput } from '../lib/terminal-output'

export function TaskTerminal({
  task,
  theme,
  onStatus,
  onDraftUsed,
  active = true,
}: {
  task: WorkspaceTask
  theme: string
  onStatus: (snapshot: TerminalSnapshot) => void
  onDraftUsed: () => void
  active?: boolean
}) {
  const visible = useRef(active)
  visible.current = active
  const host = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal | null>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const searchQuery = useRef('')
  const searchIndex = useRef(-1)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [searchResult, setSearchResult] = useState({ index: 0, count: 0 })
  const search = (value: string, direction: number) => {
    const term = terminal.current
    if (!term) return
    const matches = terminalMatches(term, value)
    let index = -1
    if (matches.length) {
      index = searchIndex.current < 0
        ? direction < 0 ? matches.length - 1 : 0
        : (searchIndex.current + direction + matches.length) % matches.length
    }
    searchIndex.current = index
    setSearchResult({ index: index + 1, count: matches.length })
    if (index >= 0) {
      const match = matches[index]
      term.select(match.column, match.row, match.length)
      term.scrollToLine(Math.max(0, match.row - 2))
    } else term.clearSelection()
  }
  const openSearch = () => {
    setSearchOpen(true)
    requestAnimationFrame(() => {
      searchInput.current?.focus()
      searchInput.current?.select()
    })
  }
  const closeSearch = () => {
    setSearchOpen(false)
    setQuery('')
    searchQuery.current = ''
    searchIndex.current = -1
    setSearchResult({ index: 0, count: 0 })
    terminal.current?.clearSelection()
    terminal.current?.focus()
  }
  const callbacks = useRef({ onStatus, onDraftUsed })
  callbacks.current = { onStatus, onDraftUsed }
  const [attempt, setAttempt] = useState(0)
  const [error, setError] = useState('')
  const [exited, setExited] = useState<number | null>(null)
  const [starting, setStarting] = useState(true)

  useEffect(() => {
    if (terminal.current) terminal.current.options.theme = palette(theme)
  }, [theme])

  useEffect(() => {
    if (!host.current) return
    let disposed = false
    let ready: TerminalSnapshot | undefined
    let pending: TerminalEvent[] = []
    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    let searchTimer: ReturnType<typeof setTimeout> | undefined
    let modifiedEnter: string | undefined
    setError('')
    setExited(null)
    setStarting(true)
    searchIndex.current = -1
    setSearchResult({ index: 0, count: 0 })
    const term = new Terminal({
      fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.35,
      cursorBlink: false,
      scrollback: 10000,
      theme: palette(theme),
      screenReaderMode: true,
      allowProposedApi: false,
    })
    terminal.current = term
    const steadyCursor = installSteadyCursor(term)
    const output = createTerminalOutput((data) => term.write(data))
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host.current)
    term.textarea?.setAttribute('aria-label', '작업 터미널 입력')
    const report = (cause: unknown) => {
      if (!disposed)
        setError(cause instanceof Error ? cause.message : String(cause))
    }
    const write = (data: string) => {
      // 로컬 에코를 추가하지 않습니다. 입력은 PTY에만 보내고 PTY 출력만 렌더링합니다.
      for (const chunk of data.match(/[\s\S]{1,16384}/gu) ?? [])
        void window.desktop.writeTerminal(task.id, chunk).catch(report)
    }
    const input = term.onData((data) => {
      // xterm이 한글 조합을 먼저 확정한 뒤 내보내는 Enter만 수정 키 시퀀스로 바꿉니다.
      if (data === '\r' && modifiedEnter) {
        const sequence = modifiedEnter
        modifiedEnter = undefined
        write(sequence)
      } else write(data)
    })
    const parsed = term.onWriteParsed(() => {
      if (!searchQuery.current) return
      clearTimeout(searchTimer)
      searchTimer = setTimeout(() => {
        if (disposed || !searchQuery.current) return
        const count = terminalMatches(term, searchQuery.current).length
        searchIndex.current = Math.min(searchIndex.current, count - 1)
        setSearchResult({ index: searchIndex.current + 1, count })
      }, 150)
    })
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      if (!event.isComposing && event.keyCode !== 229 &&
        ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
        // 실제 커서는 PTY가 이동합니다. 숨겨진 입력칸까지 이동하면 다음 한글 조합이 잘립니다.
        event.preventDefault()
      }
      if (
        task.terminalKind === 'codex' &&
        event.key === 'Enter' &&
        (event.shiftKey || event.ctrlKey) &&
        !event.altKey &&
        !event.metaKey &&
        !event.isComposing &&
        event.keyCode !== 229
      ) {
        // false로 종료하면 xterm의 IME 확정을 건너뛰어 마지막 한글이 줄바꿈 뒤에 붙습니다.
        // xterm의 조합 확정·키 처리 경로를 유지하고 onData에서 Enter만 치환합니다.
        event.preventDefault()
        if (window.desktop.platform === 'win32') {
          const modifiers = (event.shiftKey ? 16 : 0) + (event.ctrlKey ? 8 : 0)
          modifiedEnter = `\x1b[13;28;13;1;${modifiers};1_\x1b[13;28;13;0;${modifiers};1_`
        } else {
          const modifier = 1 + (event.shiftKey ? 1 : 0) + (event.ctrlKey ? 4 : 0)
          modifiedEnter = `\x1b[13;${modifier}u`
        }
        // 입력을 처리하지 않는 상태에서 다음 Enter에 수정 키가 남지 않게 합니다.
        queueMicrotask(() => { modifiedEnter = undefined })
        return true
      }
      if ((event.ctrlKey || event.metaKey) && !event.altKey) {
        if (event.key.toLowerCase() === 'f') {
          event.preventDefault()
          openSearch()
          return false
        }
        if (
          [',', 'k', 'n'].includes(event.key.toLowerCase()) ||
          (event.shiftKey && event.key.toLowerCase() === 'b')
        )
          return false
        if (
          event.key.toLowerCase() === 'c' &&
          (event.shiftKey || term.hasSelection())
        ) {
          event.preventDefault()
          if (term.hasSelection())
            void navigator.clipboard
              .writeText(term.getSelection())
              .catch(report)
          return false
        }
        if (
          event.key.toLowerCase() === 'v' &&
          (event.shiftKey || event.metaKey)
        ) {
          event.preventDefault()
          void navigator.clipboard
            .readText()
            .then((text) => {
              if (!disposed) term.paste(text)
            })
            .catch(report)
          return false
        }
      }
      return true
    })
    const resize = () => {
      if (disposed || !host.current?.clientWidth || !host.current.clientHeight)
        return
      fit.fit()
      if (ready?.running && (ready.cols !== term.cols || ready.rows !== term.rows)) {
        ready.cols = term.cols
        ready.rows = term.rows
        void window.desktop
          .resizeTerminal(task.id, term.cols, term.rows)
          .catch(report)
      }
    }
    const observer = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(resize, 30)
    })
    observer.observe(host.current)
    resize()
    const receive = (event: TerminalEvent) => {
      if (!ready) {
        pending.push(event)
        return
      }
      if (
        event.generation !== ready.generation ||
        event.sequence <= ready.sequence
      )
        return
      ready.sequence = event.sequence
      if (event.type === 'data') output.write(event.data)
      else if (event.type === 'status') {
        ready.waitingForInput = event.waitingForInput
        callbacks.current.onStatus({ ...ready })
      }
      else {
        output.flush()
        ready.running = false
        ready.exitCode = event.exitCode
        setExited(event.exitCode)
        callbacks.current.onStatus({ ...ready })
      }
    }
    // 구독 후 스냅샷을 받아, 붙는 동안 발생한 출력을 시퀀스로 병합합니다.
    const unsubscribe = window.desktop.onTerminal((event) => {
      if (!disposed && event.taskId === task.id) receive(event)
    })
    void window.desktop
      .openTerminal({
        taskId: task.id,
        workspace: task.path,
        kind: task.terminalKind,
        cols: term.cols,
        rows: term.rows,
        model: task.model,
        effort: task.effort,
        prompt: task.initialPrompt,
        threadId: task.threadId,
      })
      .then((snapshot) => {
        if (disposed) return
        setStarting(false)
        ready = { ...snapshot }
        term.resize(snapshot.cols, snapshot.rows)
        output.write(snapshot.output)
        output.flush()
        term.write('', resize)
        for (const event of pending) receive(event)
        pending = []
        host.current?.setAttribute('data-terminal-ready', 'true')
        callbacks.current.onStatus({ ...ready })
        if (!ready.running) setExited(ready.exitCode ?? 0)
        if (visible.current && !document.querySelector('dialog[open]')) term.focus()
      })
      .catch((cause: unknown) => {
        if (!disposed) setStarting(false)
        report(cause)
      })
    return () => {
      disposed = true
      host.current?.removeAttribute('data-terminal-ready')
      observer.disconnect()
      if (resizeTimer) clearTimeout(resizeTimer)
      if (searchTimer) clearTimeout(searchTimer)
      parsed.dispose()
      output.dispose()
      steadyCursor.dispose()
      unsubscribe()
      input.dispose()
      term.dispose()
      terminal.current = null
    }
  }, [task.id, task.path, task.terminalKind, attempt])

  return (
    <div className="task-terminal">
      {searchOpen && (
        <div className="terminal-search" role="search" aria-label="터미널 출력 검색">
          <Search size={14} aria-hidden="true" />
          <input ref={searchInput} aria-label="터미널 검색어" placeholder="출력 검색" value={query} onChange={(event) => {
            const value = event.target.value
            setQuery(value)
            searchQuery.current = value
            searchIndex.current = -1
            search(value, 1)
          }} onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return
            if (event.key === 'Enter') {
              event.preventDefault()
              search(query, event.shiftKey ? -1 : 1)
            } else if (event.key === 'Escape') closeSearch()
          }} />
          <span className="terminal-search-count" role="status">{query ? `${searchResult.index} / ${searchResult.count}` : '검색어 입력'}</span>
          <Button variant="ghost" size="icon-xs" title="이전 결과 (Shift+Enter)" aria-label="이전 검색 결과" disabled={!query} onClick={() => search(query, -1)}><ChevronUp /></Button>
          <Button variant="ghost" size="icon-xs" title="다음 결과 (Enter)" aria-label="다음 검색 결과" disabled={!query} onClick={() => search(query, 1)}><ChevronDown /></Button>
          <Button variant="ghost" size="icon-xs" title="검색 닫기 (Esc)" aria-label="터미널 검색 닫기" onClick={closeSearch}><X /></Button>
        </div>
      )}
      {task.draft && (
        <div className="terminal-notice">
          <span>이전 화면에서 작성 중이던 입력이 보관되어 있습니다.</span>
          <button
            onClick={() => {
              terminal.current?.paste(task.draft!)
              callbacks.current.onDraftUsed()
            }}
          >
            입력 가져오기
          </button>
        </div>
      )}
      {starting && task.terminalKind === 'codex' && (
        <div className="terminal-starting" role="status">Codex 업데이트 확인 및 터미널 시작 중…</div>
      )}
      <div className="terminal-host" ref={host} aria-label="작업 터미널" />
      {(error || exited !== null) && (
        <div className="terminal-notice" role={error ? 'alert' : 'status'}>
          <span>
            {error || `터미널이 종료되었습니다. 종료 코드: ${exited}`}
          </span>
          <Button
            variant="outline"
            size="xs"
            onClick={() => setAttempt((value) => value + 1)}
          >
            다시 연결
          </Button>
        </div>
      )}
    </div>
  )
}

function palette(theme: string) {
  return theme === 'dark'
    ? {
        background: '#18181b',
        foreground: '#e4e4e7',
        cursor: '#a1b4ee',
        selectionBackground: '#6376a955',
        black: '#18181b',
        red: '#e58b88',
        green: '#94c79b',
        yellow: '#d6be89',
        blue: '#91b2e4',
        magenta: '#c29fd6',
        cyan: '#8fc7d0',
        white: '#e4e4e7',
      }
    : {
        background: '#ffffff',
        foreground: '#27272a',
        cursor: '#52668c',
        selectionBackground: '#6376a933',
        black: '#27272a',
        red: '#b53e3e',
        green: '#357743',
        yellow: '#8e6d20',
        blue: '#365f9d',
        magenta: '#8655a1',
        cyan: '#267785',
        white: '#f4f4f5',
      }
}


// 줄바꿈으로 감싼 출력도 이어서 찾고, 한글·이모지의 셀 너비로 선택 범위를 계산합니다.
function terminalMatches(term: Terminal, query: string) {
  const matches: { column: number; row: number; length: number }[] = []
  if (!query) return matches
  const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
  const buffer = term.buffer.active
  let text = ''
  let positions: { start: number; end: number }[] = []
  const collect = () => {
    expression.lastIndex = 0
    for (const match of text.matchAll(expression)) {
      const start = positions[match.index]?.start
      const end = positions[match.index + match[0].length - 1]?.end
      if (start !== undefined && end !== undefined)
        matches.push({ column: start % term.cols, row: Math.floor(start / term.cols), length: end - start })
    }
    text = ''
    positions = []
  }
  for (let row = 0; row < buffer.length; row++) {
    const line = buffer.getLine(row)
    if (!line) continue
    if (!line.isWrapped) collect()
    const trimmedLength = line.translateToString(true).length
    let lineText = ''
    for (let column = 0; column < line.length; column++) {
      const cell = line.getCell(column)
      if (!cell || cell.getWidth() === 0) continue
      const chars = cell.getChars() || ' '
      const start = row * term.cols + column
      const end = start + cell.getWidth()
      lineText += chars
      for (let index = 0; index < chars.length; index++) positions.push({ start, end })
    }
    if (!buffer.getLine(row + 1)?.isWrapped) {
      positions.length -= lineText.length - trimmedLength
      lineText = lineText.slice(0, trimmedLength)
    }
    text += lineText
  }
  collect()
  return matches
}
