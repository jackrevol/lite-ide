import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppUpdateState } from '../shared/types.ts'

const repository = 'jackrevol/lite-ide'
const releaseRoot = `https://github.com/${repository}/releases/download/`
const versionParts = (value: string) =>
  /^\d+\.\d+\.\d+$/.test(value) ? value.split('.').map(Number) : null
export function isNewerVersion(candidate: string, current: string) {
  const next = versionParts(candidate)
  const installed = versionParts(current)
  if (!next || !installed) return false
  for (let index = 0; index < 3; index++) {
    if (next[index] !== installed[index]) return next[index] > installed[index]
  }
  return false
}

type Asset = { name: string; browser_download_url: string; size: number }
interface UpdateOptions {
  version: string
  platform: string
  arch: string
  cacheDirectory: string
  canInstall: boolean
  fetch: (url: string, init?: RequestInit) => Promise<Response>
  emit: (state: AppUpdateState) => void
  beforeInstall: () => Promise<void>
  openInstaller: (path: string) => Promise<void>
}

export class UpdateService {
  private options: UpdateOptions
  private state: AppUpdateState
  private release?: { asset: Asset; checksum: Asset }
  private controller?: AbortController
  private downloaded?: { path: string; sha256: string }
  constructor(options: UpdateOptions) {
    this.options = options
    this.state = {
      status: 'idle',
      currentVersion: options.version,
      canInstall: options.canInstall,
    }
  }
  snapshot() {
    return { ...this.state }
  }
  private publish(change: Partial<AppUpdateState>) {
    this.state = { ...this.state, ...change }
    this.options.emit(this.snapshot())
    return this.snapshot()
  }
  private fail(error: unknown) {
    return this.publish({
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    })
  }
  private async request(url: string, signal: AbortSignal) {
    const response = await this.options.fetch(url, {
      signal,
      headers: {
        Accept: url.startsWith('https://api.github.com/')
          ? 'application/vnd.github+json'
          : 'application/octet-stream',
        'User-Agent': 'Lite-IDE',
      },
    })
    return response
  }
  async check() {
    if (
      ['checking', 'downloading', 'downloaded', 'installing'].includes(
        this.state.status,
      )
    )
      return this.snapshot()
    this.release = undefined
    this.publish({
      status: 'checking',
      error: undefined,
      version: undefined,
      progress: undefined,
    })
    try {
      const response = await this.request(
        `https://api.github.com/repos/${repository}/releases/latest`,
        AbortSignal.timeout(20000),
      )
      if (response.status === 404) return this.publish({ status: 'current' })
      if (!response.ok)
        throw new Error(
          response.status === 403 || response.status === 429
            ? 'GitHub 조회 한도에 도달했습니다. 잠시 후 다시 확인해 주세요.'
            : `업데이트 조회 실패 (${response.status})`,
        )
      const release = (await response.json()) as {
        tag_name: string
        draft: boolean
        prerelease: boolean
        assets: Asset[]
      }
      const version = release.tag_name?.replace(/^v/, '')
      if (
        !version ||
        !versionParts(version) ||
        release.draft ||
        release.prerelease
      )
        throw new Error('지원하지 않는 릴리스 정보입니다.')
      if (!isNewerVersion(version, this.options.version))
        return this.publish({ status: 'current' })
      const platform =
        this.options.platform === 'win32'
          ? 'win'
          : this.options.platform === 'darwin'
            ? 'mac'
            : null
      if (!platform)
        throw new Error('이 운영체제의 설치 파일은 제공되지 않습니다.')
      const name = `Lite-IDE-${version}-${platform}-${this.options.arch}.${platform === 'win' ? 'exe' : 'dmg'}`
      const asset = release.assets.find((entry) => entry.name === name)
      const checksum = release.assets.find(
        (entry) => entry.name === 'SHA256SUMS.txt',
      )
      for (const entry of [asset, checksum]) {
        if (
          !entry ||
          !Number.isSafeInteger(entry.size) ||
          entry.size <= 0 ||
          entry.size > 2 * 1024 ** 3 ||
          entry.browser_download_url !==
            `${releaseRoot}v${version}/${entry.name}`
        )
          throw new Error('검증 가능한 설치 파일이 아직 준비되지 않았습니다.')
      }
      this.release = { asset: asset!, checksum: checksum! }
      return this.publish({ status: 'available', version })
    } catch (error) {
      return this.fail(error)
    }
  }
  async download() {
    if (!this.release || !['available', 'error'].includes(this.state.status))
      return this.snapshot()
    const { asset, checksum } = this.release
    const controller = new AbortController()
    this.controller = controller
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(15 * 60000),
    ])
    const temp = join(this.options.cacheDirectory, `${randomUUID()}.part`)
    this.publish({ status: 'downloading', progress: 0, error: undefined })
    try {
      const sumResponse = await this.request(
        checksum.browser_download_url,
        signal,
      )
      if (!sumResponse.ok || checksum.size > 65536)
        throw new Error('업데이트 체크섬을 가져오지 못했습니다.')
      const sums = await sumResponse.text()
      const expected = sums
        .split(/\r?\n/)
        .map((line) => /^([a-f0-9]{64}) {2}(.+)$/i.exec(line))
        .find((entry) => entry?.[2] === asset.name)?.[1]
        .toLowerCase()
      if (!expected) throw new Error('설치 파일의 체크섬이 없습니다.')
      const response = await this.request(asset.browser_download_url, signal)
      if (!response.ok || !response.body)
        throw new Error(`설치 파일 다운로드 실패 (${response.status})`)
      await mkdir(this.options.cacheDirectory, { recursive: true })
      const file = await open(temp, 'wx')
      const reader = response.body.getReader()
      const hash = createHash('sha256')
      let received = 0
      let lastProgress = -1
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          signal.throwIfAborted()
          received += value.length
          if (received > asset.size)
            throw new Error('설치 파일 크기가 릴리스 정보와 다릅니다.')
          hash.update(value)
          let offset = 0
          while (offset < value.length)
            offset += (await file.write(value, offset)).bytesWritten
          const progress = Math.floor((received / asset.size) * 100)
          if (progress !== lastProgress) {
            this.publish({ progress })
            lastProgress = progress
          }
        }
      } finally {
        await file.close()
        await reader.cancel().catch(() => {})
      }
      signal.throwIfAborted()
      if (received !== asset.size || hash.digest('hex') !== expected)
        throw new Error(
          '설치 파일 무결성 검증에 실패했습니다. 다시 다운로드해 주세요.',
        )
      const target = join(
        this.options.cacheDirectory,
        `${randomUUID()}-${asset.name}`,
      )
      await rename(temp, target)
      this.downloaded = { path: target, sha256: expected }
      return this.publish({ status: 'downloaded', progress: 100 })
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {})
      return controller.signal.aborted
        ? this.publish({
            status: 'available',
            progress: undefined,
            error: undefined,
          })
        : this.fail(error)
    } finally {
      this.controller = undefined
    }
  }
  cancel() {
    this.controller?.abort()
  }
  async install() {
    if (!this.downloaded || this.state.status !== 'downloaded')
      return this.snapshot()
    try {
      if (!this.options.canInstall)
        throw new Error(
          '개발 실행에서는 설치를 실행할 수 없습니다. 설치된 앱에서 이용해 주세요.',
        )
      this.publish({ status: 'installing', error: undefined })
      await this.options.beforeInstall()
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(this.downloaded.path))
        hash.update(chunk)
      if (hash.digest('hex') !== this.downloaded.sha256) {
        this.downloaded = undefined
        throw new Error('설치 파일이 변경되었습니다. 다시 다운로드해 주세요.')
      }
      await this.options.openInstaller(this.downloaded.path)
      return this.publish({ status: 'downloaded' })
    } catch (error) {
      return this.publish({
        status: this.downloaded ? 'downloaded' : 'error',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
