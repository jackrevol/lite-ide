import { execFile } from 'node:child_process'
import { access, readFile, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { findCodex } from './codex-client.ts'
import { isNewerVersion } from './update-service.ts'

type Command = { binary: string; args: string[]; env: NodeJS.ProcessEnv }

// npm 설치는 래퍼가 설치 방식과 패키지 경로를 전달해야 자체 업데이트가 가능합니다.
export async function codexUpdateCommand(binary: string): Promise<Command> {
  let directory = dirname(await realpath(binary))
  while (true) {
    const wrapper = join(directory, 'bin', 'codex.js')
    const metadata = await readFile(join(directory, 'package.json'), 'utf8')
      .then((data) => JSON.parse(data) as { name?: string })
      .catch(() => null)
    if (metadata?.name === '@openai/codex' &&
      await access(wrapper).then(() => true, () => false)) {
      return {
        binary: process.execPath,
        args: [wrapper, 'update'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CODEX_NON_INTERACTIVE: '1', CI: '1' },
      }
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_NON_INTERACTIVE: '1', CI: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  for (const key of ['CODEX_MANAGED_BY_NPM', 'CODEX_MANAGED_BY_BUN',
    'CODEX_MANAGED_BY_PNPM', 'CODEX_MANAGED_BY_VITE_PLUS', 'CODEX_MANAGED_PACKAGE_ROOT'])
    delete env[key]
  return { binary, args: ['update'], env }
}

function run(command: Command, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(command.binary, command.args, {
      env: command.env, windowsHide: true, encoding: 'utf8', timeout,
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout) => error ? reject(error) : resolve(stdout))
    // 패키지 관리자의 입력 대기가 새 세션 시작을 막지 않도록 합니다.
    child.stdin?.end()
  })
}

interface CodexUpdateOptions {
  find: () => Promise<string>
  version: (binary: string) => Promise<string>
  latest: () => Promise<string>
  install: (binary: string) => Promise<void>
  warn: (message: string) => void
  skip: () => boolean
}

export class CodexUpdateService {
  private pending?: Promise<string>
  private options: CodexUpdateOptions

  constructor(options: Partial<CodexUpdateOptions> = {}) {
    this.options = {
      find: findCodex,
      version: async (binary) => {
        const env = { ...process.env }
        delete env.ELECTRON_RUN_AS_NODE
        const output = await run({ binary, args: ['--version'], env }, 5000)
        const version = /^codex-cli\s+(\d+\.\d+\.\d+)\s*$/m.exec(output)?.[1]
        if (!version) throw new Error('Codex 버전을 확인할 수 없습니다.')
        return version
      },
      latest: async () => {
        const response = await fetch('https://registry.npmjs.org/@openai/codex/latest', {
          signal: AbortSignal.timeout(5000),
        })
        if (!response.ok) throw new Error(`Codex 버전 확인 실패: HTTP ${response.status}`)
        const metadata = await response.json() as { version?: unknown }
        if (typeof metadata.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(metadata.version))
          throw new Error('Codex 최신 버전 정보가 올바르지 않습니다.')
        return metadata.version
      },
      install: async (binary) => { await run(await codexUpdateCommand(binary), 120_000) },
      warn: (message) => console.warn(message),
      skip: () => process.env.LITE_IDE_HEADLESS === '1' &&
        !!(process.env.LITE_IDE_TEST_CODEX || process.env.LITE_IDE_TEST_TERMINAL),
      ...options,
    }
  }

  prepare(): Promise<string> {
    // 여러 Worktree를 동시에 열어도 설치는 한 번만 실행합니다.
    if (!this.pending)
      this.pending = this.update().finally(() => { this.pending = undefined })
    return this.pending
  }

  private async update() {
    const binary = await this.options.find()
    if (this.options.skip()) return binary
    try {
      const [current, latest] = await Promise.all([
        this.options.version(binary), this.options.latest(),
      ])
      if (!isNewerVersion(latest, current)) return binary
      await this.options.install(binary)
      // 설치 후 버전별 디렉터리나 심볼릭 링크의 대상이 바뀔 수 있습니다.
      return await this.options.find()
    } catch (error) {
      this.options.warn(`Codex 자동 업데이트 실패. 설치된 버전으로 시작합니다: ${error instanceof Error ? error.message : String(error)}`)
      return this.options.find()
    }
  }
}

const updates = new CodexUpdateService()
export const prepareCodex = () => updates.prepare()
