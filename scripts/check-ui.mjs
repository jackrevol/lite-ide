import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const fixture = await mkdtemp(join(tmpdir(), 'lite-ide-ui-'))
const project = join(fixture, '한글 project')
await mkdir(project)
execFileSync('git', ['init', '--initial-branch=main', project], {
  windowsHide: true,
})
await writeFile(join(project, 'hello.txt'), 'Hello from Lite IDE\n', 'utf8')
execFileSync('git', ['-C', project, 'add', 'hello.txt'], { windowsHide: true })
await mkdir('artifacts', { recursive: true })

const app = await electron.launch({
  args: [resolve('out/main/index.js')],
  env: { ...process.env, LITE_IDE_HEADLESS: '1' },
})
try {
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page
    .getByRole('heading', { name: '작게 시작하고, 하나씩 완성하세요.' })
    .waitFor()
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isVisible(),
    ),
    false,
  )
  await page.screenshot({ path: 'artifacts/workspace-empty.png' })
  await page.getByRole('textbox').fill('첫 번째 작업 초안')
  await page.getByRole('button', { name: '새 작업 탭' }).click()
  assert.equal(await page.getByRole('textbox').inputValue(), '')
  await page.getByRole('tab', { name: 'Agent 1' }).click()
  assert.equal(
    await page.getByRole('textbox').inputValue(),
    '첫 번째 작업 초안',
  )
  assert.equal(
    await page
      .getByRole('button', { name: 'Codex 실행 연동 예정' })
      .isDisabled(),
    true,
  )
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [directory],
    })
  }, project)
  await page
    .getByRole('button', { name: '프로젝트 열기', exact: true })
    .first()
    .click()
  try {
    await page.getByRole('button', { name: 'hello.txt' }).waitFor({ timeout: 10_000 })
  } catch (error) {
    await page.screenshot({ path: 'artifacts/workspace-failure.png' })
    console.error(await page.locator('body').innerText(), errors)
    throw error
  }
  await page.getByRole('button', { name: 'Review', exact: true }).click()
  await page.getByRole('dialog').waitFor()
  assert.match(
    await page.locator('dialog pre').innerText(),
    /\+Hello from Lite IDE/,
  )
  await page.keyboard.press('Escape')
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await page.screenshot({ path: 'artifacts/workspace-project.png' })
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(960, 640),
  )
  const panels = await page.locator('.panel').evaluateAll((elements) =>
    elements.map((element) => {
      const bounds = element.getBoundingClientRect()
      return { left: bounds.left, right: bounds.right, width: bounds.width }
    }),
  )
  assert.equal(panels.length, 3)
  assert.ok(panels.every((panel) => panel.width > 0))
  assert.ok(
    panels[0].right < panels[1].left && panels[1].right < panels[2].left,
  )
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  )
  await page.screenshot({ path: 'artifacts/workspace-compact.png' })
  assert.deepEqual(errors, [])
  console.log(
    'UI 확인 완료: 3열 배치, 탭별 초안, 프로젝트 열기, Git diff, 최소 창 너비. 창은 숨김 상태로 유지했습니다.',
  )
} finally {
  await app.close()
}
