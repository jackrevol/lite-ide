import { mkdir, readFile, rename, writeFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { pathKey } from './git.ts'
import type { AppSettings, ProjectDefaults } from '../shared/types.ts'

export function validateDefaults(value: unknown): ProjectDefaults {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('프로젝트 기본 설정이 올바르지 않습니다.')
  const input = value as Record<string, unknown>
  for (const key of ['baseRef', 'model', 'effort']) {
    if (
      typeof input[key] !== 'string' ||
      (input[key] as string).length > 300 ||
      /[\x00-\x1f\x7f]/.test(input[key] as string)
    )
      throw new Error('프로젝트 기본 설정 값이 올바르지 않습니다.')
  }
  const baseRef = (input.baseRef as string).trim() || 'HEAD'
  if (baseRef !== 'HEAD' && !/^refs\/(heads|remotes)\/.+/.test(baseRef))
    throw new Error('기준 브랜치를 목록에서 선택해 주세요.')
  if (input.startupScript !== undefined &&
    (typeof input.startupScript !== 'string' || input.startupScript.length > 30_000 || input.startupScript.includes('\0')))
    throw new Error('Startup 스크립트는 30,000자 이내의 명령으로 입력해 주세요.')
  if (input.startupAutoRun !== undefined && typeof input.startupAutoRun !== 'boolean')
    throw new Error('Startup 자동 실행 설정이 올바르지 않습니다.')
  return {
    baseRef,
    model: (input.model as string).trim(),
    effort: (input.effort as string).trim(),
    ...(input.startupScript !== undefined ? { startupScript: input.startupScript as string } : {}),
    ...(input.startupAutoRun !== undefined ? { startupAutoRun: input.startupAutoRun as boolean } : {}),
  }
}

export class SettingsService {
  private file: string
  private state: AppSettings = { schemaVersion: 1, projects: {} }
  private loaded: Promise<void>
  private loadFailed = false
  private queue: Promise<unknown> = Promise.resolve()
  constructor(file: string) {
    this.file = file
    this.loaded = this.startLoad()
  }
  private startLoad() {
    const loading = this.load()
    void loading.catch(() => {
      this.loadFailed = true
    })
    return loading
  }
  private async ensureLoaded() {
    if (this.loadFailed) {
      this.loadFailed = false
      this.loaded = this.startLoad()
    }
    await this.loaded
  }
  private async load() {
    const next: AppSettings = { schemaVersion: 1, projects: {} }
    try {
      if ((await stat(this.file)).size > 1024 * 1024)
        throw new Error('설정 파일이 너무 큽니다.')
      const data = JSON.parse(await readFile(this.file, 'utf8'))
      if (
        data.schemaVersion !== 1 ||
        !data.projects ||
        Array.isArray(data.projects) ||
        typeof data.projects !== 'object'
      )
        throw new Error('지원하지 않는 설정 파일입니다.')
      for (const [path, defaults] of Object.entries(data.projects)) {
        if (path === '__proto__') continue
        if (!isAbsolute(path))
          throw new Error('설정의 프로젝트 경로가 올바르지 않습니다.')
        next.projects[pathKey(path)] = validateDefaults(defaults)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    this.state = next
  }
  async get(): Promise<AppSettings> {
    await this.ensureLoaded()
    await this.queue.catch(() => {})
    return structuredClone(this.state)
  }
  async update(
    project: string,
    defaults: ProjectDefaults | null,
  ): Promise<AppSettings> {
    await this.ensureLoaded()
    if (typeof project !== 'string' || !isAbsolute(project))
      throw new Error('프로젝트 경로가 올바르지 않습니다.')
    const validated = defaults === null ? null : validateDefaults(defaults)
    const operation = this.queue
      .catch(() => {})
      .then(async () => {
        const next = structuredClone(this.state)
        if (validated) next.projects[pathKey(project)] = validated
        else delete next.projects[pathKey(project)]
        await mkdir(dirname(this.file), { recursive: true })
        await writeFile(
          `${this.file}.tmp`,
          JSON.stringify(next, null, 2),
          'utf8',
        )
        await rename(`${this.file}.tmp`, this.file)
        this.state = next
        return structuredClone(next)
      })
    this.queue = operation
    return operation
  }
}
