import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  stat,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'

const fixture = await realpath(await mkdtemp(join(tmpdir(), 'lite-ide-ui-')))
const project = join(fixture, '한글 project')
await mkdir(project)
const git = (...args) =>
  execFileSync('git', ['-C', project, ...args], { windowsHide: true })
git('init', '--initial-branch=main')
await writeFile(join(project, 'hello.txt'), 'Hello from Lite IDE\n', 'utf8')
git('add', 'hello.txt')
git(
  '-c',
  'user.name=UI Test',
  '-c',
  'user.email=test@example.invalid',
  'commit',
  '-m',
  'fixture',
)
await writeFile(
  join(project, 'hello.txt'),
  'Hello from Lite IDE\nChanged line\n',
  'utf8',
)
await writeFile(join(project, '새 파일.txt'), '새 파일 내용\n', 'utf8')
await mkdir('artifacts', { recursive: true })
git('update-server-info')
const gitRoot = join(project, '.git')
const gitServer = createServer(async (request, response) => {
  try {
    const path = resolve(
      gitRoot,
      '.' +
        new URL(request.url, 'http://localhost').pathname.replace(
          /^\/project\.git/,
          '',
        ),
    )
    const scope = relative(gitRoot, path)
    if (scope.startsWith('..') || isAbsolute(scope))
      throw new Error('invalid path')
    response.end(await readFile(path))
  } catch {
    response.writeHead(404)
    response.end()
  }
})
await new Promise((resolve) => gitServer.listen(0, '127.0.0.1', resolve))
const cloneUrl = `http://127.0.0.1:${gitServer.address().port}/project.git`
const launch = (usageScenario = '') =>
  electron.launch({
    args: [resolve('out/main/index.js')],
    env: {
      ...process.env,
      LITE_IDE_HEADLESS: '1',
      LITE_IDE_TEST_DATA: join(fixture, 'user-data'),
      LITE_IDE_TEST_CODEX: resolve('scripts/fixtures/codex-server.mjs'),
      LITE_IDE_FIXTURE_USAGE: usageScenario,
    },
  })
let app = await launch()
let page
async function checkTitlebar(page, app) {
  const layout = await page.evaluate(() => {
    const header = document.querySelector('.app-header')
    const content = document.querySelector('.titlebar-content')
    const actions = document.querySelector('.titlebar-actions')
    const overlay = navigator.windowControlsOverlay?.getTitlebarAreaRect()
    return {
      top: header.getBoundingClientRect().top,
      height: header.getBoundingClientRect().height,
      workspaceTop: document
        .querySelector('.workspace-layout')
        .getBoundingClientRect().top,
      drag: getComputedStyle(header).getPropertyValue('-webkit-app-region'),
      actionsDrag:
        getComputedStyle(actions).getPropertyValue('-webkit-app-region'),
      contentLeft: content.getBoundingClientRect().left,
      contentRight: content.getBoundingClientRect().right,
      actionsRight: actions.getBoundingClientRect().right,
      overlay: overlay ? { x: overlay.x, width: overlay.width } : null,
      platform: window.desktop.platform,
    }
  })
  assert.equal(layout.top, 0)
  assert.equal(layout.height, 43)
  assert.equal(layout.workspaceTop, 43)
  assert.equal(layout.drag, 'drag')
  assert.equal(layout.actionsDrag, 'no-drag')
  assert.ok(layout.actionsRight <= layout.contentRight)
  if (layout.overlay?.width > 0) {
    assert.ok(layout.contentLeft >= layout.overlay.x)
    assert.ok(
      layout.contentRight <= layout.overlay.x + layout.overlay.width + 1,
    )
  }
  const native = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    return {
      minimizable: win.isMinimizable(),
      maximizable: win.isMaximizable(),
      closable: win.isClosable(),
      visible: win.isVisible(),
      menu: win.isMenuBarVisible(),
      topInset: win.getContentBounds().y - win.getBounds().y,
    }
  })
  assert.equal(
    native.minimizable && native.maximizable && native.closable,
    true,
  )
  assert.equal(native.visible, false)
  if (layout.platform === 'win32') {
    assert.equal(native.menu, false)
    assert.ok(
      native.topInset < 20,
      `기본 제목 표시줄이 남아 있습니다: ${native.topInset}px`,
    )
  }
}
try {
  page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.getByRole('heading', { name: '무엇을 만들어 볼까요?' }).waitFor()
  await page.waitForFunction(() => {
    const icons = [
      ...document.querySelectorAll('.brand-mark img, .welcome-icon img'),
    ]
    return (
      icons.length === 2 &&
      icons.every((icon) => icon.complete && icon.naturalWidth === 256)
    )
  })
  await checkTitlebar(page, app)
  const updateContent = 'UI update installer fixture'
  await app.evaluate(
    ({ net }, fixture) => {
      globalThis.updateChecks = 0
      const version = '99.0.0'
      const platform = process.platform === 'win32' ? 'win' : 'mac'
      const name = `Lite-IDE-${version}-${platform}-${process.arch}.${platform === 'win' ? 'exe' : 'dmg'}`
      const root = `https://github.com/jackrevol/lite-ide/releases/download/v${version}/`
      const sums = `${fixture.hash}  ${name}\n`
      net.fetch = async (url) => {
        if (String(url).endsWith('/releases/latest')) {
          globalThis.updateChecks++
          return Response.json({
            tag_name: `v${version}`,
            draft: false,
            prerelease: false,
            assets: [
              {
                name,
                browser_download_url: root + name,
                size: fixture.content.length,
              },
              {
                name: 'SHA256SUMS.txt',
                browser_download_url: root + 'SHA256SUMS.txt',
                size: sums.length,
              },
            ],
          })
        }
        return new Response(
          String(url).endsWith('SHA256SUMS.txt') ? sums : fixture.content,
        )
      }
    },
    {
      content: updateContent,
      hash: createHash('sha256').update(updateContent).digest('hex'),
    },
  )
  assert.equal(
    await page
      .getByRole('button', { name: '앱 업데이트', exact: true })
      .count(),
    0,
  )
  await page.evaluate(() => window.desktop.checkUpdate())
  await page.evaluate(() =>
    Promise.all([window.desktop.checkUpdate(), window.desktop.checkUpdate()]),
  )
  assert.equal(await app.evaluate(() => globalThis.updateChecks), 1)
  await page.getByRole('button', { name: '앱 업데이트', exact: true }).click()
  const updateDialog = page.getByRole('dialog', {
    name: '앱 업데이트',
    exact: true,
  })
  assert.equal(
    await updateDialog
      .getByRole('button', { name: '업데이트 확인', exact: true })
      .count(),
    0,
  )
  await updateDialog
    .getByText('새 버전을 다운로드할 수 있습니다.', { exact: true })
    .waitFor()
  await page.screenshot({ path: 'artifacts/workspace-update.png' })
  await updateDialog
    .getByRole('button', { name: '다운로드', exact: true })
    .click()
  await updateDialog
    .getByText('다운로드와 무결성 검증이 완료되었습니다.', { exact: true })
    .waitFor()
  assert.equal(
    (await page.evaluate(() => window.desktop.updateStatus())).progress,
    100,
  )
  assert.equal(
    await updateDialog
      .getByRole('button', { name: /종료하고 설치|DMG 열기/ })
      .isDisabled(),
    true,
  )
  await updateDialog.getByRole('button', { name: '닫기', exact: true }).click()
  const usage = page.getByRole('region', { name: 'Codex 사용량 한도' })
  await usage.getByText('75% 남음', { exact: true }).waitFor()
  assert.equal(
    await usage
      .getByRole('progressbar', { name: '5시간 남은 사용량' })
      .getAttribute('aria-valuenow'),
    '75',
  )
  assert.equal(
    await usage
      .getByRole('progressbar', { name: '1주 남은 사용량' })
      .getAttribute('aria-valuenow'),
    '40',
  )
  await usage.getByText('3개', { exact: true }).waitFor()
  assert.equal(
    await usage.locator('[title="먼저 만료되는 초기화권"]').count(),
    1,
  )
  assert.equal(await usage.locator('.usage-window .usage-date').count(), 2)
  assert.equal(await page.getByText('이 컴퓨터', { exact: true }).count(), 0)
  await usage.getByRole('button', { name: '사용량 새로고침' }).click()
  await page.getByRole('button', { name: '빠른 이동' }).click()
  await page.getByRole('dialog', { name: '빠른 이동' }).waitFor()
  await page.keyboard.press('Escape')
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isVisible(),
    ),
    false,
  )
  await page.screenshot({ path: 'artifacts/workspace-empty.png' })
  const input = page.getByRole('textbox', { name: 'Codex에게 메시지' })
  await input.fill('첫 번째 작업 내용')
  await page
    .getByRole('button', { name: '새 작업', exact: false })
    .first()
    .click()
  await page.getByRole('button', { name: '작업 만들기', exact: true }).click()
  assert.equal(await input.inputValue(), '')
  await page.locator('.session-row').filter({ hasText: '작업 1' }).click()
  assert.equal(await input.inputValue(), '첫 번째 작업 내용')
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
  await page.getByRole('button', { name: '로컬 폴더 열기' }).click()
  await page.getByRole('button', { name: 'hello.txt', exact: true }).waitFor()
  await page.getByRole('button', { name: 'hello.txt', exact: true }).click()
  await page.getByText('+Changed line', { exact: false }).waitFor()
  await page.getByRole('button', { name: '새 파일.txt', exact: true }).click()
  await page.getByText('+새 파일 내용', { exact: false }).waitFor()
  await page.getByText('Codex 연결됨', { exact: true }).waitFor()
  assert.equal(
    await page.evaluate(async (directory) => {
      try {
        await window.desktop.readDiff(directory, '../outside.txt')
        return false
      } catch {
        return true
      }
    }, project),
    true,
  )
  await input.fill('프로젝트를 확인해 주세요')
  await page.getByRole('button', { name: '메시지 보내기', exact: true }).click()
  await page.locator('.status-label.completed').waitFor()
  await usage.getByText('70% 남음', { exact: true }).waitFor()
  assert.match(
    await page.locator('.markdown').innerText(),
    /작업을 완료했습니다/,
  )
  assert.equal(await page.locator('.markdown pre').count(), 1)
  const firstThread = await page.evaluate(
    async () => (await window.desktop.listSessions())[0].threadId,
  )
  await input.fill('이어서 확인해 주세요')
  await input.press('Enter')
  await page.waitForFunction(
    () => document.querySelectorAll('.assistant-message').length === 2,
  )
  await page.locator('.status-label.completed').waitFor()
  assert.equal(await page.locator('.assistant-message').count(), 2)
  assert.equal(
    await page.evaluate(
      async () => (await window.desktop.listSessions())[0].threadId,
    ),
    firstThread,
  )
  await page.getByRole('button', { name: '작업 이름 변경' }).click()
  await page
    .getByRole('textbox', { name: '작업 이름', exact: true })
    .fill('제품 검증 작업')
  await page.getByRole('button', { name: '저장', exact: true }).click()
  await page
    .getByRole('heading', { name: '제품 검증 작업', exact: true })
    .waitFor()
  await page.screenshot({ path: 'artifacts/workspace-conversation.png' })
  await input.fill('승인 요청')
  await input.press('Enter')
  await page.getByRole('button', { name: '이번 실행 허용' }).click()
  await page.locator('.status-label.completed').waitFor()
  await input.fill('질문 요청')
  await input.press('Enter')
  await page
    .getByRole('textbox', { name: '어떤 범위로 진행할까요?' })
    .fill('전체')
  await page.getByRole('button', { name: '답변 보내기' }).click()
  await page.locator('.status-label.completed').waitFor()
  await input.fill('중단 테스트')
  await input.press('Enter')
  await page.getByRole('button', { name: '작업 중단', exact: true }).click()
  await page.locator('.status-label.interrupted').waitFor()
  await input.fill('연결 종료 테스트')
  await input.press('Enter')
  await page.locator('.status-label.failed').waitFor()
  await usage.getByText('연결 후 한도를 확인할 수 있습니다.').waitFor()
  await page.getByRole('button', { name: '다시 연결', exact: true }).click()
  await page.getByText('Codex 연결됨', { exact: true }).waitFor()
  await input.fill('연결 복구 후 계속')
  await input.press('Enter')
  await page.waitForFunction(
    () => document.querySelectorAll('.assistant-message').length === 5,
  )
  await page.locator('.status-label.completed').waitFor()
  await page.keyboard.press('Control+k')
  await page
    .getByRole('textbox', { name: '프로젝트 및 작업 검색' })
    .fill('제품 검증')
  assert.equal(await page.locator('.command-results > button').count(), 1)
  await page.keyboard.press('Escape')
  await page
    .getByRole('button', { name: '새 작업', exact: false })
    .first()
    .click()
  const taskDialog = page.getByRole('dialog', {
    name: '새 작업',
    exact: true,
  })
  assert.equal(
    await taskDialog.locator('input[value="local"]').isChecked(),
    true,
  )
  await taskDialog.locator('input[value="worktree"]').check()
  await taskDialog
    .getByRole('textbox', { name: '작업 브랜치 이름' })
    .fill('feature/ui-test')
  await page.screenshot({ path: 'artifacts/workspace-new-task.png' })
  await taskDialog
    .getByRole('button', { name: '작업 만들기', exact: true })
    .click()
  await page
    .locator('.workspace-row.selected')
    .filter({ hasText: 'feature/ui-test' })
    .waitFor()
  await input.fill('Worktree별 입력 보존')
  const treeState = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('lite-ide.workspace.v1')),
  )
  assert.equal(treeState.newTaskMode, 'worktree')
  assert.equal(treeState.sessions[treeState.workspace].length, 1)
  await page.keyboard.press('Control+n')
  assert.equal(
    await taskDialog.locator('input[value="worktree"]').isChecked(),
    true,
  )
  await taskDialog
    .getByRole('textbox', { name: '작업 브랜치 이름' })
    .fill('feature/ui-test')
  await taskDialog
    .getByRole('button', { name: '작업 만들기', exact: true })
    .click()
  await taskDialog.getByRole('alert').waitFor()
  assert.equal(await input.inputValue(), 'Worktree별 입력 보존')
  await taskDialog.locator('input[value="local"]').check()
  await page.keyboard.press('Escape')
  assert.equal(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem('lite-ide.workspace.v1')).newTaskMode,
    ),
    'worktree',
  )
  await page
    .locator('.workspace-row')
    .filter({ hasText: /^main$/ })
    .click()
  await page
    .getByRole('heading', { name: '제품 검증 작업', exact: true })
    .waitFor()
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(960, 640),
  )
  const panels = await page.locator('.panel').evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect()
      return { left: box.left, right: box.right, width: box.width }
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
  await checkTitlebar(page, app)
  const usageBounds = await page.locator('.codex-usage').boundingBox()
  assert.ok(usageBounds.y >= 43 && usageBounds.y + usageBounds.height <= 640)
  await page.getByRole('button', { name: '변경 패널 전환' }).click()
  assert.equal(await page.locator('.panel').count(), 2)
  await page.getByRole('button', { name: '변경 패널 전환' }).click()
  await page.getByRole('button', { name: '라이트 테마' }).click()
  await page.evaluate(() => window.desktop.setWindowTheme('light'))
  assert.equal(
    await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource),
    'light',
  )
  await page.screenshot({ path: 'artifacts/workspace-light.png' })
  assert.deepEqual(errors, [])
  await app.close()
  app = await launch()
  page = await app.firstWindow()
  await page
    .getByRole('heading', { name: '제품 검증 작업', exact: true })
    .waitFor()
  await page.waitForFunction(
    () => document.querySelectorAll('.assistant-message').length >= 4,
  )
  assert.equal(
    await page.evaluate(() =>
      document.documentElement.classList.contains('dark'),
    ),
    false,
  )
  await page.evaluate(() => window.desktop.setWindowTheme('light'))
  assert.equal(
    await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource),
    'light',
  )
  await checkTitlebar(page, app)
  await page
    .locator('.workspace-row')
    .filter({ hasText: 'feature/ui-test' })
    .click()
  assert.equal(
    await page.getByRole('textbox', { name: 'Codex에게 메시지' }).inputValue(),
    'Worktree별 입력 보존',
  )
  await page.keyboard.press('Control+n')
  const restoredTaskDialog = page.getByRole('dialog', {
    name: '새 작업',
    exact: true,
  })
  assert.equal(
    await restoredTaskDialog.locator('input[value="worktree"]').isChecked(),
    true,
  )
  await restoredTaskDialog.locator('input[value="local"]').check()
  await restoredTaskDialog.getByRole('button', { name: '작업 만들기' }).click()
  await page
    .locator('.workspace-row.selected')
    .filter({ hasText: /^main$/ })
    .waitFor()
  assert.equal(
    await page.getByRole('textbox', { name: 'Codex에게 메시지' }).inputValue(),
    '',
  )
  const localState = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('lite-ide.workspace.v1')),
  )
  assert.equal(localState.newTaskMode, 'local')
  assert.equal(localState.workspace, localState.project)
  await page.keyboard.press('Control+n')
  assert.equal(
    await restoredTaskDialog.locator('input[value="local"]').isChecked(),
    true,
  )
  await page.keyboard.press('Escape')
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isVisible(),
    ),
    false,
  )
  await page
    .getByRole('button', { name: '프로젝트 열기', exact: true })
    .first()
    .click()
  await page.getByRole('textbox', { name: '저장소 URL' }).fill(cloneUrl)
  const defaultDirectory = join(fixture, 'user-data', 'Projects')
  await page
    .getByRole('button', { name: '저장 위치 변경' })
    .getByText(defaultDirectory, { exact: true })
    .waitFor()
  assert.equal(await stat(defaultDirectory).catch(() => null), null)
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => {
      throw new Error('기본 경로 복제는 폴더 선택이 필요하지 않습니다.')
    }
  })
  await page.getByRole('button', { name: '복제하고 열기' }).click()
  await page
    .getByRole('dialog', { name: 'Git 저장소에서 시작' })
    .waitFor({ state: 'detached' })
  assert.equal(
    (
      await readFile(join(defaultDirectory, 'project', 'hello.txt'), 'utf8')
    ).replaceAll('\r\n', '\n'),
    'Hello from Lite IDE\n',
  )
  await page
    .getByRole('button', { name: '프로젝트 열기', exact: true })
    .first()
    .click()
  await page.getByRole('textbox', { name: '저장소 URL' }).fill(cloneUrl)
  await page
    .getByRole('button', { name: '저장 위치 변경' })
    .getByText(defaultDirectory, { exact: true })
    .waitFor()
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
  })
  await page.getByRole('button', { name: '저장 위치 변경' }).click()
  await page
    .getByRole('button', { name: '저장 위치 변경' })
    .getByText(defaultDirectory, { exact: true })
    .waitFor()
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [directory],
    })
  }, fixture)
  await page.getByRole('button', { name: '저장 위치 변경' }).click()
  await page
    .getByRole('textbox', { name: '프로젝트 폴더 이름' })
    .fill('한글 project')
  await page.getByRole('button', { name: '복제하고 열기' }).click()
  await page.getByRole('alert').filter({ hasText: '이미 있습니다' }).waitFor()
  assert.match(
    await readFile(join(project, 'hello.txt'), 'utf8'),
    /Changed line/,
  )
  await page
    .getByRole('textbox', { name: '저장소 URL' })
    .fill(`${cloneUrl}/missing`)
  await page
    .getByRole('textbox', { name: '프로젝트 폴더 이름' })
    .fill('failed-clone')
  await page.getByRole('button', { name: '복제하고 열기' }).click()
  await page
    .getByRole('alert')
    .filter({ hasText: '저장소를 복제하지 못했습니다' })
    .waitFor()
  assert.equal(
    await stat(join(fixture, 'failed-clone')).catch(() => null),
    null,
  )
  await page.getByRole('textbox', { name: '저장소 URL' }).fill(cloneUrl)
  await page
    .getByRole('textbox', { name: '프로젝트 폴더 이름' })
    .fill('복제한 project')
  await page.getByRole('button', { name: '복제하고 열기' }).click()
  await page
    .getByRole('dialog', { name: 'Git 저장소에서 시작' })
    .waitFor({ state: 'detached' })
  assert.equal(
    (
      await readFile(join(fixture, '복제한 project', 'hello.txt'), 'utf8')
    ).replaceAll('\r\n', '\n'),
    'Hello from Lite IDE\n',
  )
  assert.ok(
    (await page.evaluate(() => window.desktop.listProjects())).some(
      (item) => item.name === '복제한 project',
    ),
  )
  await page.screenshot({ path: 'artifacts/workspace-usage.png' })
  for (const scenario of ['error', 'empty', 'partial', 'zero']) {
    await app.close()
    app = await launch(scenario)
    page = await app.firstWindow()
    const panel = page.getByRole('region', { name: 'Codex 사용량 한도' })
    const expected = {
      error: '한도를 불러오지 못했습니다.',
      empty: '이 계정은 한도 정보를 제공하지 않습니다.',
      partial: '사용 기간 정보 미제공',
      zero: '0개',
    }[scenario]
    await panel.getByText(expected, { exact: true }).waitFor()
    assert.equal(
      (await page.evaluate(() => window.desktop.codexStatus())).connected,
      true,
    )
    if (scenario === 'error' || scenario === 'empty')
      assert.equal(await panel.getByRole('progressbar').count(), 0)
    if (scenario === 'partial')
      await panel.getByText('3개', { exact: true }).waitFor()
    assert.ok(
      (await page.evaluate(() => window.desktop.listProjects())).some(
        (item) => item.name === '복제한 project',
      ),
    )
  }
  console.log(
    'UI 검증 통과: 사용량 조회·알림 갱신·초기화 시각·초기화권·미제공/실패 상태, Git 복제·기존 폴더 보호·실패 정리·재시작 복원, 통합 타이틀바, Codex 전송/스트리밍/재개/승인/질문/중단, Worktree, diff, 검색, 960px 3열. 모든 창을 숨김 상태로 유지했습니다.',
  )
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: 'artifacts/workspace-failure.png' })
    console.error(await page.locator('body').innerText())
  }
  throw error
} finally {
  await app.close()
  await new Promise((resolve) => gitServer.close(resolve))
}
