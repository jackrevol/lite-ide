import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pathKey, workspaceContains } from './git.ts'
import type { StartupSnapshot } from '../shared/types.ts'
import { resolveStartupScript } from './startup-script.ts'

type Execution = {
  snapshot: StartupSnapshot
  process?: ChildProcess
  exited: Promise<void>
  stopping: boolean
}

export class StartupService {
  private executions = new Map<string, Execution>()
  private attempted = new Set<string>()
  private required = new Set<string>()
  private deleting = new Set<string>()
  private queue: Promise<unknown> = Promise.resolve()
  private loaded: Promise<void>
  private closed = false
  private file: string
  private emit: (snapshot: StartupSnapshot) => void
  constructor(file: string, emit: (snapshot: StartupSnapshot) => void) {
    this.file = file
    this.emit = emit
    this.loaded = readFile(file, 'utf8').then((data) => {
      const saved: unknown = JSON.parse(data)
      if (!saved || typeof saved !== 'object' || !Array.isArray((saved as { attempted?: unknown }).attempted) || !Array.isArray((saved as { required?: unknown }).required))
        throw new Error('Startup 실행 기록이 올바르지 않습니다.')
      const record = saved as { attempted: unknown[]; required: unknown[] }
      for (const workspace of record.attempted) {
        if (typeof workspace !== 'string') throw new Error('Startup 실행 기록이 올바르지 않습니다.')
        this.attempted.add(workspace)
      }
      for (const workspace of record.required) {
        if (typeof workspace !== 'string') throw new Error('Startup 실행 기록이 올바르지 않습니다.')
        this.required.add(workspace)
      }
    }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
    void this.loaded.catch(() => {})
  }
  snapshot(workspace: string): StartupSnapshot | null {
    const value = this.executions.get(pathKey(workspace))?.snapshot
    return value ? { ...value } : this.required.has(pathKey(workspace))
      ? { workspace, status: 'stopped', output: '', startedAt: 0, revision: 0, error: '초기화가 완료되지 않았습니다. Startup을 다시 실행해 주세요.' } : null
  }
  async ready() { await this.loaded }
  async requireReady(workspace: string) {
    await this.loaded
    await this.queue.catch(() => {})
    if ([...this.required].some((directory) => workspaceContains(directory, workspace)))
      throw new Error('Startup 스크립트가 성공적으로 완료된 후 에이전트를 시작할 수 있습니다.')
  }
  private async save() {
    await mkdir(dirname(this.file), { recursive: true })
    await writeFile(`${this.file}.tmp`, JSON.stringify({ attempted: [...this.attempted], required: [...this.required] }), 'utf8')
    await rename(`${this.file}.tmp`, this.file)
  }
  async initialize(workspace: string, scriptPath: string) {
    const initialize = this.queue.catch(() => {}).then(async () => {
      await this.loaded
      if (!scriptPath.trim()) return
      this.required.add(pathKey(workspace))
      await this.save()
    })
    this.queue = initialize
    await initialize
    return this.run(workspace, scriptPath)
  }
  run(workspace: string, scriptPath: string, automatic = false): Promise<StartupSnapshot | null> {
    const operation = this.queue.catch(() => {}).then(async () => {
      await this.loaded
      const key = pathKey(workspace)
      if (this.closed) throw new Error('앱이 종료 중입니다.')
      if (this.deleting.has(key)) throw new Error('삭제 중인 작업입니다.')
      const existing = this.snapshot(workspace)
      if (existing?.status === 'running') return existing
      if (!scriptPath.trim() || (automatic && this.attempted.has(key))) return existing
      // 실행 전 기록을 저장해 창 새로고침과 앱 재시작으로 중복 실행되지 않도록 합니다.
      this.attempted.add(key)
      this.required.add(key)
      await this.save()
      if (this.closed || this.deleting.has(key)) throw new Error('작업을 종료 중입니다.')
      const snapshot: StartupSnapshot = { workspace, status: 'running', output: '', startedAt: Math.max(Date.now(), (existing?.startedAt ?? 0) + 1), revision: 0 }
      let scriptFile: string
      try { scriptFile = await resolveStartupScript(workspace, scriptPath) }
      catch (error) {
        snapshot.status = 'failed'
        snapshot.error = String(error instanceof Error ? error.message : error)
        snapshot.revision++
        this.executions.set(key, { snapshot, stopping: false, exited: Promise.resolve() })
        this.emit({ ...snapshot })
        return { ...snapshot }
      }
      const win = process.platform === 'win32'
      const powershell = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); $OutputEncoding = [Console]::OutputEncoding; $ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; $LASTEXITCODE = 0;\ntry {\n& '${scriptFile.replaceAll("'", "''")}'\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\n} catch { [Console]::Error.WriteLine($_.ToString()); exit 1 }`
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      if (win) for (const name of Object.keys(env)) if (name.toUpperCase() === 'PSMODULEPATH') delete env[name]
      const child = spawn(win ? 'powershell.exe' : process.env.SHELL || '/bin/sh',
        win ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(powershell, 'utf16le').toString('base64')]
          : ['-l', '-e', scriptFile],
        { cwd: workspace, env, windowsHide: true, detached: !win, stdio: ['ignore', 'pipe', 'pipe'] })
      let finish!: () => void
      const execution: Execution = { snapshot, process: child, stopping: false, exited: new Promise((resolve) => { finish = resolve }) }
      this.executions.set(key, execution)
      const publish = () => { snapshot.revision++; this.emit({ ...snapshot }) }
      const append = (data: string) => {
        snapshot.output = (snapshot.output + data).slice(-500_000)
        publish()
      }
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', append)
      child.stderr?.on('data', append)
      child.on('error', (error) => {
        snapshot.error = error.message
        snapshot.status = 'failed'
        publish()
      })
      child.on('close', (code) => {
        snapshot.exitCode = code ?? undefined
        const status = execution.stopping ? 'stopped' : snapshot.error || code !== 0 ? 'failed' : 'completed'
        // 성공 기록 저장까지 마친 후에만 렌더러가 에이전트를 시작할 수 있습니다.
        const completed = this.queue.catch(() => {}).then(async () => {
          if (status === 'completed') {
            this.required.delete(key)
            try { await this.save() }
            catch (error) {
              this.required.add(key)
              snapshot.status = 'failed'
              snapshot.error = `초기화 완료 기록 저장 실패: ${String(error)}`
            }
          }
          if (!snapshot.error) snapshot.status = status
          else snapshot.status = 'failed'
          publish()
        })
        this.queue = completed
        void completed.finally(finish)
      })
      publish()
      return { ...snapshot }
    })
    this.queue = operation
    return operation
  }
  async stop(workspace: string) {
    const execution = this.executions.get(pathKey(workspace))
    if (!execution || execution.snapshot.status !== 'running') return
    if (execution.stopping) return execution.exited
    execution.stopping = true
    try {
      const pid = execution.process?.pid
      if (pid) {
        if (process.platform === 'win32') {
          await new Promise<void>((resolve, reject) => {
            const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
            killer.once('error', reject)
            killer.once('close', (code) => {
              if (code === 0 || execution.snapshot.status !== 'running') resolve()
              else reject(new Error(`Startup 프로세스 종료 실패 (${code})`))
            })
          })
        } else {
          try { process.kill(-pid, 'SIGKILL') }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
        }
      }
      await execution.exited
    } catch (error) {
      execution.stopping = false
      throw error
    }
  }
  async removeWorkspace<T>(workspace: string, action: () => Promise<T>): Promise<T> {
    const key = pathKey(workspace)
    this.deleting.add(key)
    try {
      await this.queue.catch(() => {})
      await this.stop(workspace)
      const result = await action()
      this.executions.delete(key)
      return result
    } finally { this.deleting.delete(key) }
  }
  hasRunning() {
    return [...this.executions.values()].some((execution) => execution.snapshot.status === 'running')
  }
  async close() {
    this.closed = true
    await this.queue.catch(() => {})
    await this.stopAll()
  }
  async stopAll() {
    await this.queue.catch(() => {})
    await Promise.all([...this.executions.values()].map((execution) => this.stop(execution.snapshot.workspace)))
  }
}
