import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { TerminalEvent, TerminalSnapshot } from '../../../shared/types'
import type { WorkspaceTask } from '../lib/workspace-state'
import { Button } from './ui/button'

export function TaskTerminal({
  task,
  theme,
  onStatus,
  onDraftUsed,
}: {
  task: WorkspaceTask
  theme: string
  onStatus: (snapshot: TerminalSnapshot) => void
  onDraftUsed: () => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal | null>(null)
  const callbacks = useRef({ onStatus, onDraftUsed })
  callbacks.current = { onStatus, onDraftUsed }
  const [attempt, setAttempt] = useState(0)
  const [error, setError] = useState('')
  const [exited, setExited] = useState<number | null>(null)

  useEffect(() => {
    if (terminal.current) terminal.current.options.theme = palette(theme)
  }, [theme])

  useEffect(() => {
    if (!host.current) return
    let disposed = false
    let ready: TerminalSnapshot | undefined
    let pending: TerminalEvent[] = []
    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    setError('')
    setExited(null)
    const term = new Terminal({
      fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.35,
      cursorBlink: true,
      scrollback: 10000,
      theme: palette(theme),
      screenReaderMode: true,
      allowProposedApi: false,
    })
    terminal.current = term
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
    const input = term.onData(write)
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      if ((event.ctrlKey || event.metaKey) && !event.altKey) {
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
      if (ready?.running)
        void window.desktop
          .resizeTerminal(task.id, term.cols, term.rows)
          .catch(report)
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
      if (event.type === 'data') term.write(event.data)
      else {
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
        ready = { ...snapshot }
        term.resize(snapshot.cols, snapshot.rows)
        term.write(snapshot.output, resize)
        for (const event of pending) receive(event)
        pending = []
        host.current?.setAttribute('data-terminal-ready', 'true')
        callbacks.current.onStatus({ ...ready })
        if (!ready.running) setExited(ready.exitCode ?? 0)
        if (!document.querySelector('dialog[open]')) term.focus()
      })
      .catch(report)
    return () => {
      disposed = true
      host.current?.removeAttribute('data-terminal-ready')
      observer.disconnect()
      if (resizeTimer) clearTimeout(resizeTimer)
      unsubscribe()
      input.dispose()
      term.dispose()
      terminal.current = null
    }
  }, [task.id, task.path, task.terminalKind, attempt])

  return (
    <div className="task-terminal">
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
      <div className="terminal-footer">
        <span>
          {task.terminalKind === 'codex'
            ? 'Codex CLI · / 명령어 · ! 셸 명령'
            : window.desktop.platform === 'win32'
              ? 'PowerShell'
              : '로그인 셸'}
        </span>
        <span>Ctrl+C 중단 · Ctrl+Shift+C/V 복사·붙여넣기</span>
      </div>
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
