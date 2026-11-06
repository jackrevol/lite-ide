import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UpdateService, isNewerVersion } from './update-service.ts'

const bytes = Buffer.from('installer fixture')
const hash = createHash('sha256').update(bytes).digest('hex')
const root = 'https://github.com/jackrevol/lite-ide/releases/download/v0.2.0/'
const name = 'Lite-IDE-0.2.0-win-x64.exe'
function fixture(
  t: { after: (fn: () => Promise<void>) => void },
  options: {
    checksum?: string
    canInstall?: boolean
    beforeInstall?: () => Promise<void>
    assetUrl?: string
    responseStatus?: number
  } = {},
) {
  return mkdtemp(join(tmpdir(), 'lite-update-')).then((directory) => {
    t.after(() => rm(directory, { recursive: true, force: true }))
    const sums = `${options.checksum ?? hash}  ${name}\n`
    let opened = ''
    const service = new UpdateService({
      version: '0.1.0',
      platform: 'win32',
      arch: 'x64',
      cacheDirectory: directory,
      canInstall: options.canInstall ?? true,
      emit: () => {},
      beforeInstall: options.beforeInstall ?? (async () => {}),
      openInstaller: async (path) => {
        opened = path
      },
      fetch: async (url) => {
        if (options.responseStatus)
          return new Response(null, { status: options.responseStatus })
        if (url.endsWith('/releases/latest'))
          return Response.json({
            tag_name: 'v0.2.0',
            draft: false,
            prerelease: false,
            assets: [
              {
                name,
                browser_download_url: options.assetUrl ?? root + name,
                size: bytes.length,
              },
              {
                name: 'SHA256SUMS.txt',
                browser_download_url: root + 'SHA256SUMS.txt',
                size: sums.length,
              },
            ],
          })
        if (url.endsWith('SHA256SUMS.txt')) return new Response(sums)
        return new Response(bytes)
      },
    })
    return { service, directory, opened: () => opened }
  })
}
test('업데이트 버전을 숫자로 비교하고 다운그레이드를 막는다', () => {
  assert.equal(isNewerVersion('0.1.10', '0.1.9'), true)
  assert.equal(isNewerVersion('0.1.9', '0.1.10'), false)
  assert.equal(isNewerVersion('0.1.10', '0.1.10'), false)
  assert.equal(isNewerVersion('0.2.0-beta', '0.1.0'), false)
})
test('다른 저장소의 설치 파일을 거부하고 조회 실패를 최신 상태와 구별한다', async (t) => {
  const external = await fixture(t, {
    assetUrl: 'https://example.com/installer.exe',
  })
  assert.equal((await external.service.check()).status, 'error')
  const missing = await fixture(t, { responseStatus: 404 })
  assert.equal((await missing.service.check()).status, 'current')
  const offline = await fixture(t, { responseStatus: 503 })
  assert.equal((await offline.service.check()).status, 'error')
})
test('설치 파일을 검증한 후 명시적인 설치 요청에서만 연다', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.service.check()).status, 'available')
  assert.equal((await f.service.download()).status, 'downloaded')
  assert.equal(f.opened(), '')
  await f.service.install()
  assert.deepEqual(await readFile(f.opened()), bytes)
})
test('체크섬이 다른 파일은 삭제하며 설치하지 않는다', async (t) => {
  const f = await fixture(t, { checksum: '0'.repeat(64) })
  await f.service.check()
  assert.equal((await f.service.download()).status, 'error')
  await f.service.install()
  assert.equal(f.opened(), '')
  assert.deepEqual(await readdir(f.directory), [])
})
test('다운로드 취소 후 다시 다운로드할 수 있다', async (t) => {
  const f = await fixture(t)
  await f.service.check()
  const pending = f.service.download()
  f.service.cancel()
  assert.equal((await pending).status, 'available')
  assert.deepEqual(await readdir(f.directory), [])
  assert.equal((await f.service.download()).status, 'downloaded')
})
test('설치 직전에 파일 변경을 다시 검증한다', async (t) => {
  const f = await fixture(t)
  await f.service.check()
  await f.service.download()
  const [file] = await readdir(f.directory)
  await writeFile(join(f.directory, file), 'tampered', 'utf8')
  assert.equal((await f.service.install()).status, 'error')
  assert.equal(f.opened(), '')
})
test('진행 중인 작업과 개발 실행에서는 설치하지 않는다', async (t) => {
  for (const options of [
    {
      beforeInstall: async () => {
        throw new Error('작업 중')
      },
    },
    { canInstall: false },
  ]) {
    const f = await fixture(t, options)
    await f.service.check()
    await f.service.download()
    const result = await f.service.install()
    assert.equal(result.status, 'downloaded')
    assert.ok(result.error)
    assert.equal(f.opened(), '')
  }
})
