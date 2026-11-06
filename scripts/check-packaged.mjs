import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
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
const projectDirectory = join(data, 'project')
await mkdir(projectDirectory)
const git = (...args) => execFileSync('git', ['-C', projectDirectory, ...args], {
  windowsHide: true, stdio: 'pipe',
})
git('init', '--initial-branch=main')
await writeFile(join(projectDirectory, 'README.md'), 'Packaged PTY fixture\n', 'utf8')
git('add', 'README.md')
git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture')
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
  await page.getByRole('heading', { name: '작업 터미널을 시작하세요' }).waitFor()
  assert.equal(
    await page
      .getByRole('button', { name: '앱 업데이트', exact: true })
      .count(),
    0,
  )
  const status = await page.evaluate(() => window.desktop.updateStatus())
  assert.equal(status.canInstall, true)
  assert.equal(status.currentVersion, process.env.RELEASE_VERSION ??
    JSON.parse(await readFile('package.json', 'utf8')).version)
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] })
  }, projectDirectory)
  const project = await page.evaluate(() => window.desktop.openProject())
  const worktree = await page.evaluate((project) =>
    window.desktop.createWorktree(project.path, 'task/packaged-pty', 'refs/heads/main'), project)
  await page.evaluate((workspace) => window.desktop.openTerminal({
    taskId: 'packaged-pty', workspace, kind: 'shell', cols: 80, rows: 24,
  }), worktree.path)
  const command = platform === 'win'
    ? "Set-Content -Encoding utf8 packaged-pty.txt 'PACKAGED_PTY_OK'\r"
    : "printf 'PACKAGED_PTY_OK\\n' > packaged-pty.txt\r"
  await page.evaluate((command) => window.desktop.writeTerminal('packaged-pty', command), command)
  const deadline = Date.now() + 15000
  let output = ''
  while (Date.now() < deadline) {
    output = await readFile(join(worktree.path, 'packaged-pty.txt'), 'utf8').catch(() => '')
    if (output.replace(/^\ufeff/, '').trim() === 'PACKAGED_PTY_OK') break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.equal(output.replace(/^\ufeff/, '').trim(), 'PACKAGED_PTY_OK')
  await page.evaluate(() => window.desktop.closeTerminal('packaged-pty'))
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isVisible(),
    ),
    false,
  )
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), true)
  console.log(`패키징된 ${platform}-${arch} 앱의 숨김 실행·버전·사전 빌드 PTY 명령 실행 확인 완료`)
} finally {
  await app.close()
}
