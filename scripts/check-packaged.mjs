import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const [platform, arch] = process.argv.slice(2)
if (!['win', 'mac'].includes(platform) || !['x64', 'arm64'].includes(arch))
  throw new Error('플랫폼과 아키텍처를 지정해 주세요.')
const executablePath =
  platform === 'win'
    ? resolve('release/win-unpacked/Lite IDE.exe')
    : resolve(
        `release/${arch === 'arm64' ? 'mac-arm64' : 'mac'}/Lite IDE.app/Contents/MacOS/Lite IDE`,
      )
const data = await mkdtemp(join(tmpdir(), 'lite-packaged-'))
const app = await electron.launch({
  executablePath,
  args: [],
  env: {
    ...process.env,
    LITE_IDE_HEADLESS: '1',
    LITE_IDE_TEST_DATA: data,
    LITE_IDE_TEST_CODEX: resolve('scripts/fixtures/codex-server.mjs'),
  },
})
try {
  const page = await app.firstWindow()
  await page.getByRole('heading', { name: '무엇을 만들어 볼까요?' }).waitFor()
  await page.getByRole('button', { name: '앱 업데이트', exact: true }).waitFor()
  const status = await page.evaluate(() => window.desktop.updateStatus())
  assert.equal(status.canInstall, true)
  assert.equal(status.currentVersion, process.env.RELEASE_VERSION)
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isVisible(),
    ),
    false,
  )
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), true)
  await mkdir('artifacts', { recursive: true })
  await page.screenshot({
    path: `artifacts/workspace-packaged-${platform}-${arch}.png`,
  })
  console.log(`패키징된 ${platform}-${arch} 앱의 숨김 실행과 버전 확인 완료`)
} finally {
  await app.close()
}
