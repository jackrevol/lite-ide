import {
  execFile, spawn, type ChildProcessWithoutNullStreams,
} from 'node:child_process'
import { promisify } from 'node:util'
import { access, readdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, join } from 'node:path'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import { Duplex } from 'node:stream'
import WebSocket from 'ws'

export type RpcMessage = {
  id?: string | number
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { message: string }
}

export async function findCodex(): Promise<string> {
  if (process.env.LITE_IDE_HEADLESS === '1' && process.env.LITE_IDE_TEST_CODEX)
    return process.env.LITE_IDE_TEST_CODEX
  const directories = [
    ...(process.env.PATH ?? '').split(delimiter),
    join(homedir(), '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ]
  if (process.env.APPDATA) directories.push(join(process.env.APPDATA, 'npm'))
  for (const dir of new Set(directories.filter(Boolean))) {
    const binary = join(
      dir,
      process.platform === 'win32' ? 'codex.exe' : 'codex',
    )
    if (
      await access(binary, constants.X_OK).then(
        () => true,
        () => false,
      )
    )
      return binary
    // npm의 .cmd 래퍼 대신 플랫폼 바이너리를 실행하여 셸 인용 문제를 피합니다.
    const roots = [
      join(dir, 'node_modules', '@openai', 'codex'),
      join(dir, '..', 'lib', 'node_modules', '@openai', 'codex'),
    ]
    for (const root of roots) {
      const platform = process.platform === 'win32' ? 'win32' : process.platform
      for (const vendor of [
        join(
          root,
          'node_modules',
          '@openai',
          `codex-${platform}-${process.arch}`,
          'vendor',
        ),
        join(root, 'vendor'),
      ]) {
        for (const target of await readdir(vendor).catch(
          () => [] as string[],
        )) {
          for (const folder of ['bin', 'codex']) {
            const candidate = join(
              vendor,
              target,
              folder,
              process.platform === 'win32' ? 'codex.exe' : 'codex',
            )
            if (
              await access(candidate, constants.X_OK).then(
                () => true,
                () => false,
              )
            )
              return candidate
          }
        }
      }
    }
  }
  throw new Error(
    'Codex CLI를 찾을 수 없습니다. Codex를 설치한 뒤 다시 연결해 주세요.',
  )
}

export class CodexClient {
  private process?: ChildProcessWithoutNullStreams
  private socket?: WebSocket
  private startup?: Promise<void>
  private sequence = 0
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timer: NodeJS.Timeout
    }
  >()
  onMessage: (message: RpcMessage) => void = () => {}
  onDisconnect: (reason: string) => void = () => {}

  async start(): Promise<void> {
    if (this.startup) return this.startup
    this.startup = this.connect().catch((error) => {
      this.stop()
      throw error
    })
    return this.startup
  }

  private async connect() {
    const binary = await findCodex()
    const fixture =
      process.env.LITE_IDE_HEADLESS === '1' && binary.endsWith('.mjs')
    // 앱은 연결만 소유합니다. 백그라운드 서버의 작업은 앱 업데이트 중에도 유지합니다.
    if (!fixture)
      await promisify(execFile)(binary, ['app-server', 'daemon', 'start'], {
        windowsHide: true,
        timeout: 20000,
      })
    const child = spawn(
      fixture ? process.execPath : binary,
      fixture ? [binary] : ['app-server', 'proxy'],
      {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: fixture
          ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
          : process.env,
      },
    )
    this.process = child
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (data: string) => {
      stderr = (stderr + data).slice(-3000)
    })
    child.stdin.on('error', () => {})
    const receive = (line: string) => {
      let message: RpcMessage
      try {
        message = JSON.parse(line)
      } catch {
        return
      }
      if (!message.method && typeof message.id === 'number') {
        const pending = this.pending.get(message.id)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pending.delete(message.id)
        if (message.error) pending.reject(new Error(message.error.message))
        else pending.resolve(message.result)
      } else this.onMessage(message)
    }
    const disconnected = (reason: string) => {
      if (this.process !== child) return
      const socket = this.socket
      this.process = undefined
      this.socket = undefined
      this.startup = undefined
      socket?.terminate()
      child.stdin.end()
      child.kill()
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error(reason))
      }
      this.pending.clear()
      this.onDisconnect(reason)
    }
    child.once('error', (error) => disconnected(error.message))
    child.once('exit', () =>
      disconnected(
        stderr.trim() || 'Codex 연결이 종료되었습니다. 다시 연결해 주세요.',
      ),
    )
    if (fixture) {
      createInterface({ input: child.stdout }).on('line', receive)
    } else {
      // proxy는 바이트 중계만 하므로 제어 소켓의 WebSocket 핸드셰이크가 필요합니다.
      const socket = new WebSocket('ws://localhost/', {
        createConnection: () =>
          Duplex.from({ readable: child.stdout, writable: child.stdin }),
        handshakeTimeout: 10000,
        perMessageDeflate: false,
      })
      this.socket = socket
      socket.on('message', (data) => receive(data.toString()))
      socket.on('error', (error) => disconnected(error.message))
      socket.on('close', () =>
        disconnected('Codex 연결이 종료되었습니다. 다시 연결해 주세요.'),
      )
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve)
        socket.once('error', reject)
      })
    }
    await this.request('initialize', {
      clientInfo: { name: 'lite_ide', title: 'Lite IDE', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    })
    this.write({ method: 'initialized', params: {} })
  }

  request<T = unknown>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const reason = `${method}: Codex 응답 시간이 초과되어 연결을 종료했습니다.`
        this.pending.delete(id)
        reject(new Error(reason))
        this.stop()
        this.onDisconnect(reason)
      }, 60_000)
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      })
      try {
        this.write({ id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  write(message: object) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message))
      return
    }
    if (!this.process?.stdin.writable)
      throw new Error('Codex에 연결되어 있지 않습니다.')
    this.process.stdin.write(`${JSON.stringify(message)}\n`)
  }

  stop() {
    const child = this.process
    const socket = this.socket
    this.socket = undefined
    this.process = undefined
    this.startup = undefined
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Codex 연결이 종료되었습니다.'))
    }
    this.pending.clear()
    socket?.terminate()
    child?.stdin.end()
    child?.kill()
  }
}
