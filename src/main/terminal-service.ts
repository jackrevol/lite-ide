import * as pty from 'node-pty'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { findCodex } from './codex-client.ts'
import { pathKey } from './git.ts'
import { ProcessService, type TerminalProcessRoot } from './process-service.ts'
import type {
  TerminalEvent,
  TerminalOpen,
  TerminalSnapshot,
  StopProcessInput,
} from '../shared/types.ts'

const outputLimit = 2_000_000
type RunningTerminal = TerminalSnapshot & {
  process?: pty.IPty
  exited?: Promise<void>
}
export type PtyFactory = typeof pty.spawn

export class TerminalService {
  private terminals = new Map<string, RunningTerminal>()
  private opening = new Map<string, Promise<TerminalSnapshot>>()
  private openingWorkspaces = new Set<string>()
  private deleting = new Set<string>()
  private resumed = new Set<string>()
  private loaded: Promise<void>
  private saves = Promise.resolve()
  private closed = false
  private file: string
  private emit: (event: TerminalEvent) => void
  private spawn: PtyFactory
  private codex: () => Promise<string>
  private processes = new ProcessService()

  constructor(
    file: string,
    emit: (event: TerminalEvent) => void,
    spawn: PtyFactory = pty.spawn,
    codex = findCodex,
  ) {
    this.file = file
    this.emit = emit
    this.spawn = spawn
    this.codex = codex
    this.loaded = readFile(file, 'utf8')
      .then((data) => {
        const saved: unknown = JSON.parse(data)
        if (Array.isArray(saved))
          for (const path of saved)
            if (typeof path === 'string') this.resumed.add(path)
      })
      .catch(() => {})
  }

  snapshot(id: string): TerminalSnapshot | null {
    const terminal = this.terminals.get(id)
    if (!terminal) return null
    const { process: _process, exited: _exited, ...snapshot } = terminal
    return snapshot
  }

  hasRunning() {
    return (
      [...this.terminals.values()].some((terminal) => terminal.running) ||
      this.opening.size > 0
    )
  }

  async open(input: TerminalOpen): Promise<TerminalSnapshot> {
    if (this.closed) throw new Error('앱이 종료 중입니다.')
    if (
      !/^[\w-]{1,100}$/.test(input.taskId) ||
      !['codex', 'shell'].includes(input.kind)
    )
      throw new Error('올바른 작업을 선택해 주세요.')
    if (this.deleting.has(pathKey(input.workspace)))
      throw new Error('삭제 중인 작업입니다.')
    const pending = this.opening.get(input.taskId)
    if (pending) {
      await pending
      return this.open(input)
    }
    const existing = this.terminals.get(input.taskId)
    if (existing && pathKey(existing.workspace) !== pathKey(input.workspace))
      throw new Error('작업 경로를 변경할 수 없습니다.')
    if (existing?.running && existing.kind === input.kind)
      return this.snapshot(input.taskId)!
    if (this.openingWorkspaces.has(pathKey(input.workspace)))
      throw new Error('이미 이 작업의 터미널을 시작하고 있습니다.')
    if (
      [...this.terminals.values()].some(
        (terminal) =>
          terminal.taskId !== input.taskId &&
          pathKey(terminal.workspace) === pathKey(input.workspace),
      )
    )
      throw new Error('이미 이 작업에 연결된 터미널이 있습니다.')
    const operation = this.launch(input)
    this.opening.set(input.taskId, operation)
    this.openingWorkspaces.add(pathKey(input.workspace))
    try {
      return await operation
    } finally {
      this.opening.delete(input.taskId)
      this.openingWorkspaces.delete(pathKey(input.workspace))
    }
  }

  private async launch(input: TerminalOpen) {
    await this.loaded
    await this.stop(input.taskId)
    const args: string[] = []
    let binary: string
    let fixture = false
    if (input.kind === 'codex') {
      binary = await this.codex()
      fixture =
        process.env.LITE_IDE_HEADLESS === '1' &&
        !!process.env.LITE_IDE_TEST_TERMINAL
      if (fixture) {
        binary = process.env.LITE_IDE_TEST_NODE || process.execPath
        args.push(
          process.env.LITE_IDE_TEST_TERMINAL!,
          this.resumed.has(pathKey(input.workspace)) ? 'resume' : 'start',
          this.resumed.has(pathKey(input.workspace))
            ? ''
            : (input.prompt ?? ''),
        )
      } else {
        if (input.threadId && !this.resumed.has(pathKey(input.workspace)))
          args.push('resume', input.threadId)
        else if (this.resumed.has(pathKey(input.workspace)))
          args.push('resume', '--last')
        args.push(
          '--config',
          'tui.alternate_screen="always"',
          '--config',
          'tui.fullscreen_transcript=true',
          '--no-daemon',
          '--cd',
          input.workspace,
          '--dangerously-bypass-approvals-and-sandbox',
        )
        if (input.model) args.push('--model', input.model)
        if (input.effort)
          args.push(
            '--config',
            `model_reasoning_effort=${JSON.stringify(input.effort)}`,
          )
        if (input.prompt && !this.resumed.has(pathKey(input.workspace)))
          args.push(input.prompt)
      }
    } else {
      binary =
        process.platform === 'win32'
          ? 'powershell.exe'
          : process.env.SHELL || '/bin/zsh'
      args.push(
        ...(process.platform === 'win32' ? ['-NoLogo', '-NoProfile'] : ['-l']),
      )
    }
    if (this.closed || this.deleting.has(pathKey(input.workspace)))
      throw new Error('작업이 종료되었거나 삭제 중입니다.')
    const terminal: RunningTerminal = {
      taskId: input.taskId,
      generation: crypto.randomUUID(),
      workspace: input.workspace,
      kind: input.kind,
      cols: dimension(input.cols, 80, 20, 500),
      rows: dimension(input.rows, 24, 5, 200),
      output: '',
      sequence: 0,
      running: true,
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      ...(fixture ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    }
    if (!fixture) delete env.ELECTRON_RUN_AS_NODE
    if (input.kind === 'shell' && process.platform === 'win32') {
      // PowerShell 7에서 상속한 모듈 경로가 Windows PowerShell에 섞이지 않게 합니다.
      for (const key of Object.keys(env))
        if (key.toUpperCase() === 'PSMODULEPATH') delete env[key]
    }
    const child = this.spawn(binary, args, {
      name: 'xterm-256color',
      cwd: input.workspace,
      cols: terminal.cols,
      rows: terminal.rows,
      env,
    })
    terminal.process = child
    terminal.pid = child.pid
    terminal.startedAt = Date.now()
    this.terminals.set(input.taskId, terminal)
    const data = child.onData((chunk) => {
      terminal.output = (terminal.output + chunk).slice(-outputLimit)
      this.emit({
        taskId: input.taskId,
        generation: terminal.generation,
        sequence: ++terminal.sequence,
        type: 'data',
        data: chunk,
      })
    })
    terminal.exited = new Promise<void>((resolve) => {
      const exit = child.onExit(({ exitCode }) => {
        terminal.running = false
        terminal.exitCode = exitCode
        terminal.process = undefined
        this.processes.forget(terminal.generation)
        this.emit({
          taskId: input.taskId,
          generation: terminal.generation,
          sequence: ++terminal.sequence,
          type: 'exit',
          exitCode,
        })
        data.dispose()
        exit.dispose()
        resolve()
      })
    })
    if (Number.isSafeInteger(child.pid) && child.pid > 0) {
      await this.processes.register({
        taskId: terminal.taskId,
        generation: terminal.generation,
        workspace: terminal.workspace,
        pid: child.pid,
      }).catch(() => {})
      if (!terminal.running) this.processes.forget(terminal.generation)
    }
    if (input.kind === 'codex') {
      this.resumed.add(pathKey(input.workspace))
      this.persistResume()
    }
    return this.snapshot(input.taskId)!
  }

  private persistResume() {
    const snapshot = JSON.stringify([...this.resumed])
    this.saves = this.saves
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(this.file), { recursive: true })
        await writeFile(`${this.file}.tmp`, snapshot, 'utf8')
        await rename(`${this.file}.tmp`, this.file)
      })
    void this.saves.catch(() => {})
  }

  write(id: string, data: string) {
    if (typeof data !== 'string' || data.length > 65536)
      throw new Error('터미널 입력이 너무 깁니다.')
    const terminal = this.terminals.get(id)
    if (!terminal?.process || !terminal.running)
      throw new Error('터미널이 종료되었습니다. 다시 연결해 주세요.')
    terminal.process.write(data)
  }

  resize(id: string, cols: number, rows: number) {
    const terminal = this.terminals.get(id)
    if (!terminal?.process) return
    terminal.cols = dimension(cols, terminal.cols, 20, 500)
    terminal.rows = dimension(rows, terminal.rows, 5, 200)
    terminal.process.resize(terminal.cols, terminal.rows)
  }

  async stop(id: string) {
    const terminal = this.terminals.get(id)
    if (!terminal?.process) return
    const root = this.processRoots().find((root) => root.generation === terminal.generation)
    if (root)
      await this.processes.stopDescendants(root, () => this.processRoots()).catch(() => {})
    if (!terminal.process) return
    terminal.process.kill()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        terminal.exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  '터미널 종료를 기다리고 있습니다. 다시 시도해 주세요.',
                ),
              ),
            5000,
          )
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private processRoots(workspace?: string): TerminalProcessRoot[] {
    return [...this.terminals.values()].flatMap((terminal) =>
      terminal.running && terminal.process && Number.isSafeInteger(terminal.pid) && terminal.pid! > 0 &&
      (!workspace || pathKey(terminal.workspace) === pathKey(workspace))
        ? [{ taskId: terminal.taskId, generation: terminal.generation, workspace: terminal.workspace, pid: terminal.pid! }]
        : [],
    )
  }

  inspectProcesses(workspace: string) {
    return this.processes.inspect(workspace, this.processRoots(workspace))
  }

  async stopProcess(input: StopProcessInput) {
    await this.processes.stop(() => this.processRoots(input.workspace), input, async () => {
      const terminal = this.terminals.get(input.taskId)
      if (terminal?.generation !== input.generation)
        throw new Error('터미널이 변경되었습니다. 목록을 새로 고쳐 주세요.')
      await this.stop(input.taskId)
    })
    return this.inspectProcesses(input.workspace)
  }

  async removeWorkspace<T>(
    workspace: string,
    remove: () => Promise<T>,
  ): Promise<T> {
    const key = pathKey(workspace)
    if (this.deleting.has(key)) throw new Error('이미 삭제 중인 작업입니다.')
    this.deleting.add(key)
    try {
      await Promise.allSettled([...this.opening.values()])
      for (const terminal of this.terminals.values())
        if (pathKey(terminal.workspace) === key)
          await this.stop(terminal.taskId)
      const result = await remove()
      for (const [id, terminal] of this.terminals)
        if (pathKey(terminal.workspace) === key) this.terminals.delete(id)
      this.resumed.delete(key)
      this.persistResume()
      return result
    } finally {
      this.deleting.delete(key)
    }
  }

  async close() {
    this.closed = true
    await Promise.allSettled([...this.opening.values()])
    await Promise.allSettled(
      [...this.terminals.keys()].map((id) => this.stop(id)),
    )
    await this.saves.catch(() => {})
  }
}

function dimension(value: number, fallback: number, min: number, max: number) {
  return Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.floor(value)))
    : fallback
}
