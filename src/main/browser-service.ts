import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { validateBrowserSettings, type BrowserSettings, type BrowserCheck } from '../shared/browser.ts'
import { pathKey } from './git.ts'

export const browserServerName = 'lite_ide_browser'

// 개인 Codex 설정은 수정하지 않고 API 또는 CLI의 대화별 설정으로 전달합니다.
export class BrowserService {
  private checking?: Promise<BrowserCheck>
  private directory: string
  private runtime: { command: string; cli: string }
  constructor(
    directory: string,
    runtime: { command: string; cli: string },
  ) {
    this.directory = directory
    this.runtime = runtime
  }

  config(value: BrowserSettings, workspace: string): Record<string, unknown> {
    const { browser } = validateBrowserSettings(value)
    const output = join(this.directory, createHash('sha256').update(pathKey(workspace)).digest('hex').slice(0, 24))
    return {
      [`mcp_servers.${browserServerName}`]: {
        command: this.runtime.command,
        args: [this.runtime.cli, '--browser', browser === 'disabled' ? 'chrome' : browser,
          '--headless', '--isolated', '--output-dir', output],
        env: { ELECTRON_RUN_AS_NODE: '1' },
        enabled: browser !== 'disabled',
        startup_timeout_sec: 20,
        tool_timeout_sec: 60,
      },
    }
  }

  terminalArgs(value: BrowserSettings, workspace: string): string[] {
    // CLI의 -c는 JSON 객체가 아닌 TOML 값을 받습니다. 경로와 문자열은 JSON 인용으로 보존합니다.
    const toml = (value: unknown): string => {
      if (Array.isArray(value)) return `[${value.map(toml).join(',')}]`
      if (value !== null && typeof value === 'object')
        return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`).join(',')}}`
      if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value)
      throw new Error('지원하지 않는 Codex 설정 값입니다.')
    }
    return Object.entries(this.config(value, workspace)).flatMap(([key, value]) => ['--config', `${key}=${toml(value)}`])
  }

  check(value: BrowserSettings): Promise<BrowserCheck> {
    const settings = validateBrowserSettings(value)
    if (settings.browser === 'disabled')
      return Promise.resolve({ ok: false, message: '브라우저 자동 연결이 꺼져 있습니다.' })
    // 중복 클릭으로 브라우저와 프로세스가 여러 개 열리지 않게 합니다.
    if (this.checking) return this.checking
    this.checking = this.probe(settings).finally(() => { this.checking = undefined })
    return this.checking
  }

  private async probe(settings: BrowserSettings): Promise<BrowserCheck> {
    const directory = join(this.directory, 'connection-check')
    await mkdir(directory, { recursive: true })
    const config = this.config(settings, directory)[`mcp_servers.${browserServerName}`] as {
      command: string; args: string[]; env: Record<string, string>
    }
    const child = spawn(config.command, config.args, {
      cwd: directory, env: { ...process.env, ...config.env },
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    })
    let sequence = 0
    let stderr = ''
    let stopped: Error | undefined
    const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>()
    const stop = (error: Error) => {
      stopped = error
      for (const request of pending.values()) request.reject(error)
      pending.clear()
    }
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (text: string) => { stderr = (stderr + text).slice(-2000) })
    child.on('error', stop)
    child.stdin.on('error', stop)
    child.on('exit', () => stop(new Error(stderr.trim() || '브라우저 연결 프로세스가 종료되었습니다.')))
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      try {
        const message = JSON.parse(line)
        const request = pending.get(message.id)
        if (!request) return
        pending.delete(message.id)
        if (message.error) request.reject(new Error(message.error.message))
        else request.resolve(message.result ?? {})
      } catch { /* MCP 이외의 출력은 응답으로 처리하지 않습니다. */ }
    })
    const timer = setTimeout(() => {
      stop(new Error('브라우저 연결 확인 시간이 초과되었습니다. 설치 상태를 확인한 뒤 다시 시도해 주세요.'))
      child.kill()
    }, 25_000)
    const request = (method: string, params: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolve, reject) => {
      if (stopped) { reject(stopped); return }
      const id = ++sequence
      pending.set(id, { resolve, reject })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
    try {
      await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'lite-ide-check', version: '1.0.0' } })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
      const result = await request('tools/call', { name: 'browser_navigate', arguments: { url: 'about:blank' } })
      if (result.isError) {
        const content = result.content as { text?: string }[] | undefined
        throw new Error(content?.map((item) => item.text ?? '').join('\n') || '브라우저를 실행하지 못했습니다.')
      }
      await request('tools/call', { name: 'browser_close', arguments: {} })
      const name = settings.browser === 'chrome' ? 'Chrome' : 'Edge'
      return { ok: true, message: `${name} 백그라운드 실행과 브라우저 도구 연결을 확인했습니다.` }
    } catch (error) {
      return { ok: false, message: `브라우저를 연결하지 못했습니다. 선택한 브라우저가 설치되어 있는지 확인해 주세요.\n${error instanceof Error ? error.message : String(error)}` }
    } finally {
      clearTimeout(timer)
      lines.close()
      child.stdin.end()
      child.kill()
    }
  }
}
