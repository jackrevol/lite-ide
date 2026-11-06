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
await writeFile(
  join(project, '.gitignore'),
  '.env\nnode_modules/\nout/\n',
  'utf8',
)
git('add', 'hello.txt', '.gitignore')
git(
  '-c',
  'user.name=UI Test',
  '-c',
  'user.email=test@example.invalid',
  'commit',
  '-m',
  'fixture',
)
const settingsBaseCommit = git('rev-parse', 'HEAD').toString().trim()
git('branch', 'settings-base')
await writeFile(join(project, 'newer.txt'), '현재 main에만 있는 파일\n', 'utf8')
git('add', 'newer.txt')
git(
  '-c',
  'user.name=UI Test',
  '-c',
  'user.email=test@example.invalid',
  'commit',
  '-m',
  'newer fixture',
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
  await page.keyboard.press('Control+,')
  const settingsDialog = page.getByRole('dialog', { name: '설정', exact: true })
  await settingsDialog
    .getByRole('button', { name: '업데이트 확인', exact: true })
    .click()
  await settingsDialog
    .getByText('새 버전을 다운로드할 수 있습니다.', { exact: true })
    .waitFor()
  assert.equal(await app.evaluate(() => globalThis.updateChecks), 1)
  await page.evaluate(() => window.desktop.checkUpdate())
  assert.equal(await app.evaluate(() => globalThis.updateChecks), 2)
  assert.equal(
    (await page.evaluate(() => window.desktop.updateStatus())).status,
    'available',
  )
  await settingsDialog
    .getByRole('tab', { name: '프로그램 정보', exact: true })
    .click()
  const initialInfo = await page.evaluate(() => window.desktop.getAppInfo())
  assert.equal(initialInfo.name, 'Lite IDE')
  assert.equal(
    initialInfo.version,
    JSON.parse(await readFile('package.json', 'utf8')).version,
  )
  assert.match(initialInfo.buildTime, /^\d{4}-\d{2}-\d{2}T.*Z$/)
  assert.equal(
    initialInfo.repositoryUrl,
    'https://github.com/jackrevol/lite-ide',
  )
  assert.match(initialInfo.commit, /^[a-f0-9]{40}$/)
  assert.equal(initialInfo.packaged, false)
  await settingsDialog
    .getByText(`${initialInfo.buildTime} (UTC)`, { exact: true })
    .waitFor()
  await settingsDialog
    .getByRole('button', { name: '정보 복사', exact: true })
    .click()
  assert.equal(
    await app.evaluate(
      ({ clipboard }) => JSON.parse(clipboard.readText()).buildTime,
    ),
    initialInfo.buildTime,
  )
  await app.evaluate(({ shell }) => {
    globalThis.liteIdeOpenedUrl = ''
    shell.openExternal = async (url) => {
      globalThis.liteIdeOpenedUrl = url
    }
  })
  await settingsDialog
    .getByRole('button', { name: 'GitHub 열기', exact: true })
    .click()
  assert.equal(
    await app.evaluate(() => globalThis.liteIdeOpenedUrl),
    initialInfo.repositoryUrl,
  )
  await settingsDialog
    .getByRole('button', { name: '닫기', exact: true })
    .click()
  await settingsDialog.waitFor({ state: 'detached' })
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
    .getByText('다운로드와 무결성 검증이 완료되었습니다.', { exact: true })
    .waitFor()
  await page.screenshot({ path: 'artifacts/workspace-update.png' })
  assert.equal(
    await updateDialog
      .getByRole('button', { name: '다운로드', exact: true })
      .count(),
    0,
  )
  assert.equal(
    (await page.evaluate(() => window.desktop.updateStatus())).progress,
    100,
  )
  assert.equal(
    await updateDialog
      .getByRole('button', { name: '업데이트 다시 시도' })
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
  assert.equal(await page.locator('.welcome').count(), 0)
  await page.locator('.conversation').waitFor()
  await input.fill('첫 번째 작업 내용')
  await page.keyboard.press('Control+n')
  await page.getByRole('heading', { name: '작업 2', exact: true }).waitFor()
  assert.equal(await input.inputValue(), '')
  assert.equal(
    await page.getByRole('dialog', { name: '새 작업', exact: true }).count(),
    0,
  )
  await page.locator('.session-row').filter({ hasText: '작업 1' }).click()
  assert.equal(await input.inputValue(), '첫 번째 작업 내용')
  await page
    .getByRole('button', { name: '새 작업', exact: false })
    .first()
    .click()
  await page.getByRole('heading', { name: '작업 3', exact: true }).waitFor()
  assert.equal(
    await input.evaluate((node) => node === document.activeElement),
    true,
  )
  await page.keyboard.type('프로젝트를 확인해 주세요')
  await input.press('Shift+Enter')
  await page.keyboard.type('구조도 알려 주세요')
  assert.equal(
    await input.inputValue(),
    '프로젝트를 확인해 주세요\n구조도 알려 주세요',
  )
  assert.equal(await page.locator('.user-message').count(), 0)
  const composerBefore = await input.boundingBox()
  await page.screenshot({ path: 'artifacts/workspace-new-chat.png' })
  await input.press('Enter')
  await page.locator('.agent-heading .status-label.completed').waitFor()
  assert.equal(
    await page.locator('.user-message').innerText(),
    '프로젝트를 확인해 주세요\n구조도 알려 주세요',
  )
  assert.equal(await input.inputValue(), '')
  const composerAfter = await input.boundingBox()
  assert.ok(
    Math.abs(
      composerBefore.y +
        composerBefore.height -
        composerAfter.y -
        composerAfter.height,
    ) <= 1,
  )
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
  await page.locator('.agent-heading .status-label.completed').waitFor()
  assert.equal(await page.locator('.assistant-message').count(), 2)
  assert.equal(
    await page.evaluate(
      async () => (await window.desktop.listSessions())[0].threadId,
    ),
    firstThread,
  )
  await page
    .getByRole('button', { name: '작업 이름 변경', exact: true })
    .click()
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
  await page.locator('.agent-heading .status-label.completed').waitFor()
  await input.fill('질문 요청')
  await input.press('Enter')
  await page
    .getByRole('textbox', { name: '어떤 범위로 진행할까요?' })
    .fill('전체')
  await page.getByRole('button', { name: '답변 보내기' }).click()
  await page.locator('.agent-heading .status-label.completed').waitFor()
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
  await page.locator('.agent-heading .status-label.completed').waitFor()
  await page.keyboard.press('Control+k')
  await page
    .getByRole('textbox', { name: '프로젝트 및 작업 검색' })
    .fill('제품 검증')
  assert.equal(await page.locator('.command-results > button').count(), 1)
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('.sidebar-top .new-task').count(), 0)
  await input.fill('서브에이전트 테스트')
  await input.press('Enter')
  const monitor = page.getByRole('region', { name: '서브에이전트 관리' })
  await monitor.locator('.subagent-card').first().waitFor()
  await page.locator('.agent-heading .status-label.completed').waitFor()
  assert.equal(await monitor.locator('.subagent-card').count(), 3)
  assert.equal(
    await page
      .getByRole('button', { name: '작업 삭제', exact: true })
      .isDisabled(),
    true,
  )
  await monitor
    .getByRole('button', { name: '확인 필요 1', exact: true })
    .click()
  assert.equal(await monitor.locator('.subagent-card').count(), 1)
  await monitor.getByRole('button', { name: '검증 담당 상세 보기' }).click()
  const childDialog = page.getByRole('dialog', {
    name: '검증 담당',
    exact: true,
  })
  await childDialog
    .getByText('서브에이전트 테스트 실행', { exact: false })
    .waitFor()
  assert.equal(
    await childDialog.getByRole('button', { name: '지시 보내기' }).isDisabled(),
    true,
  )
  await childDialog.getByRole('button', { name: '이번 실행 허용' }).click()
  await childDialog.getByText('요청을 처리했습니다.', { exact: true }).waitFor()
  await childDialog.locator('.status-label.completed').waitFor()
  await childDialog
    .getByRole('button', { name: '서브에이전트 상세 닫기' })
    .click()
  await monitor.getByRole('button', { name: '전체 3', exact: true }).click()
  await monitor
    .getByRole('textbox', { name: '서브에이전트 검색' })
    .fill('로그인')
  assert.equal(await monitor.locator('.subagent-card').count(), 1)
  await monitor.getByRole('button', { name: '구현 담당 상세 보기' }).click()
  const workerDialog = page.getByRole('dialog', {
    name: '구현 담당',
    exact: true,
  })
  await workerDialog.getByText('npm run typecheck', { exact: true }).waitFor()
  const childInput = workerDialog.getByRole('textbox', {
    name: '서브에이전트에게 추가 지시',
  })
  await childInput.fill('접근성도 확인해 주세요.')
  await workerDialog
    .getByRole('button', { name: '지시 보내기', exact: true })
    .click()
  await workerDialog
    .getByText('추가 지시를 받았습니다: 접근성도 확인해 주세요.', {
      exact: true,
    })
    .waitFor()
  await workerDialog
    .getByRole('button', { name: '활동 새로고침', exact: true })
    .click()
  await workerDialog
    .getByRole('button', { name: '서브에이전트 중단', exact: true })
    .click()
  await workerDialog.locator('.status-label.interrupted').waitFor()
  await childInput.fill('중단한 작업을 이어가 주세요.')
  await workerDialog
    .getByRole('button', { name: '지시 보내기', exact: true })
    .click()
  await workerDialog
    .getByText('작업을 완료했습니다.', { exact: false })
    .waitFor()
  await workerDialog.locator('.status-label.completed').waitFor()
  await workerDialog
    .getByRole('button', { name: '서브에이전트 상세 닫기' })
    .click()
  await monitor.getByRole('textbox', { name: '서브에이전트 검색' }).fill('')
  await monitor.getByRole('button', { name: '종료 3', exact: true }).click()
  assert.equal(await monitor.locator('.subagent-card').count(), 3)
  assert.equal(
    await page
      .getByRole('button', { name: '작업 삭제', exact: true })
      .isDisabled(),
    false,
  )
  assert.equal(
    await page.locator('.session-row').filter({ hasText: '구현 담당' }).count(),
    0,
  )
  await page.screenshot({ path: 'artifacts/workspace-subagents.png' })
  await page
    .getByRole('button', {
      name: '한글 project 작업 설정하여 만들기',
      exact: true,
    })
    .click()
  const newTask = page.getByRole('dialog', { name: '새 작업', exact: true })
  assert.equal(
    await newTask
      .getByRole('combobox', { name: '작업 공간 방식' })
      .inputValue(),
    'new',
  )
  await newTask
    .getByRole('textbox', { name: '새 작업 이름', exact: true })
    .fill('통합 생성 작업')
  await newTask
    .getByRole('textbox', { name: '새 브랜치 이름' })
    .fill('feature/ui-test')
  await newTask.getByRole('textbox', { name: '첫 요청' }).fill('모델 전달 확인')
  await newTask
    .getByRole('combobox', { name: '새 작업 모델', exact: true })
    .selectOption('fixture-model-alt')
  await newTask
    .getByRole('combobox', { name: '새 작업 추론 수준' })
    .selectOption('high')
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(960, 600),
  )
  await newTask
    .getByRole('button', { name: '만들고 시작' })
    .scrollIntoViewIfNeeded()
  const createBounds = await newTask
    .getByRole('button', { name: '만들고 시작' })
    .boundingBox()
  assert.ok(createBounds.y >= 0 && createBounds.y + createBounds.height <= 600)
  await page.screenshot({ path: 'artifacts/workspace-new-task.png' })
  await newTask.getByRole('button', { name: '만들고 시작' }).click()
  await newTask.waitFor({ state: 'detached' })
  await page.locator('.agent-heading .status-label.completed').waitFor()
  assert.match(
    await page.locator('.markdown').innerText(),
    /model=fixture-model-alt; effort=high/,
  )
  assert.equal(
    await page
      .getByRole('combobox', { name: '모델', exact: true })
      .inputValue(),
    'fixture-model-alt',
  )
  assert.equal(
    await page
      .getByRole('combobox', { name: '추론 수준', exact: true })
      .inputValue(),
    'high',
  )
  await page
    .locator('.workspace-row.selected')
    .filter({ hasText: 'feature/ui-test' })
    .waitFor()
  const createdPath = await page.evaluate(
    async (directory) =>
      (await window.desktop.inspectRepository(directory)).worktrees.find(
        (tree) => tree.branch === 'feature/ui-test',
      ).path,
    project,
  )
  await page
    .getByRole('button', {
      name: 'feature/ui-test Worktree 이름 변경',
      exact: true,
    })
    .click()
  await page
    .getByRole('textbox', { name: 'Worktree 표시 이름' })
    .fill('검증 Worktree')
  await page
    .getByRole('dialog', { name: 'Worktree 이름 변경', exact: true })
    .getByRole('button', { name: '저장', exact: true })
    .click()
  await page
    .locator('.workspace-row.selected')
    .filter({ hasText: '검증 Worktree' })
    .waitFor()
  assert.equal(
    await page.locator('.workspace-row.selected').getAttribute('title'),
    createdPath,
  )
  await input.fill('Worktree별 입력 보존')
  const treeState = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('lite-ide.workspace.v1')),
  )
  assert.equal(treeState.newTaskMode, 'worktree')
  assert.equal(treeState.sessions[treeState.workspace].length, 1)
  await page
    .getByRole('button', { name: /작업 설정하여 만들기$/ })
    .first()
    .click()
  assert.equal(
    await newTask
      .getByRole('combobox', { name: '작업 공간 방식' })
      .inputValue(),
    'new',
  )
  await newTask
    .getByRole('textbox', { name: '새 브랜치 이름' })
    .fill('feature/ui-test')
  await newTask.getByRole('button', { name: '만들기', exact: true }).click()
  await newTask.getByRole('alert').waitFor()
  assert.equal(await input.inputValue(), 'Worktree별 입력 보존')
  await newTask
    .getByRole('combobox', { name: '작업 공간 방식' })
    .selectOption('existing')
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
  await page
    .getByRole('button', { name: /작업 설정하여 만들기$/ })
    .first()
    .click()
  await newTask
    .getByRole('combobox', { name: '작업 공간 방식' })
    .selectOption('existing')
  await newTask.getByRole('button', { name: '만들기', exact: true }).click()
  await newTask.waitFor({ state: 'detached' })
  await page
    .getByRole('button', { name: '작업 이름 변경', exact: true })
    .click()
  await page
    .getByRole('textbox', { name: '작업 이름', exact: true })
    .fill('빈 작업 이름 유지')
  await page
    .getByRole('dialog', { name: '작업 이름 변경', exact: true })
    .getByRole('button', { name: '저장', exact: true })
    .click()
  await input.fill('첫 전송 후에도 이름 유지')
  await input.press('Enter')
  await page.locator('.agent-heading .status-label.completed').waitFor()
  await page
    .getByRole('heading', { name: '빈 작업 이름 유지', exact: true })
    .waitFor()
  await page
    .locator('.session-row')
    .filter({ hasText: '제품 검증 작업' })
    .click()
  await page
    .getByRole('button', {
      name: '빈 작업 이름 유지 작업 이름 변경',
      exact: true,
    })
    .click()
  await page
    .getByRole('textbox', { name: '작업 이름', exact: true })
    .fill('비선택 작업 관리')
  await page
    .getByRole('dialog', { name: '작업 이름 변경', exact: true })
    .getByRole('button', { name: '저장', exact: true })
    .click()
  await page
    .getByRole('heading', { name: '제품 검증 작업', exact: true })
    .waitFor()
  await page
    .getByRole('button', { name: '비선택 작업 관리 작업 삭제', exact: true })
    .click()
  await page
    .getByRole('dialog', { name: '이 작업을 목록에서 삭제할까요?' })
    .getByRole('button', { name: '삭제', exact: true })
    .click()
  await page
    .getByRole('dialog', { name: '이 작업을 목록에서 삭제할까요?' })
    .waitFor({ state: 'hidden' })
  await page
    .locator('.session-row')
    .filter({ hasText: '비선택 작업 관리' })
    .waitFor({ state: 'detached' })
  assert.equal(
    await page
      .locator('.session-row')
      .filter({ hasText: '비선택 작업 관리' })
      .count(),
    0,
  )
  // 첫 시작 실패 후 재시도해도 Worktree와 세션은 하나씩만 생성합니다.
  const beforeRetryTrees = await page.evaluate(
    async (directory) =>
      (await window.desktop.inspectRepository(directory)).worktrees.length,
    project,
  )
  await page
    .getByRole('button', {
      name: '한글 project 작업 설정하여 만들기',
      exact: true,
    })
    .click()
  assert.equal(
    await newTask
      .getByRole('combobox', { name: '작업 공간 방식' })
      .inputValue(),
    'existing',
  )
  await newTask
    .getByRole('combobox', { name: '작업 공간 방식' })
    .selectOption('new')
  await newTask
    .getByRole('textbox', { name: '새 브랜치 이름' })
    .fill('feature/retry-test')
  await newTask
    .getByRole('textbox', { name: '새 작업 이름', exact: true })
    .fill('재시도 작업')
  await newTask
    .getByRole('textbox', { name: '첫 요청' })
    .fill('시작 재시도 테스트')
  await newTask.getByRole('button', { name: '만들고 시작' }).click()
  await newTask
    .getByRole('alert')
    .filter({ hasText: '첫 시작 실패 테스트' })
    .waitFor()
  const retrySession = await page.evaluate(async () =>
    (await window.desktop.listSessions()).find(
      (session) => session.title === '재시도 작업',
    ),
  )
  await newTask.getByRole('button', { name: '다시 시도', exact: true }).click()
  await newTask.waitFor({ state: 'detached' })
  await page.locator('.agent-heading .status-label.completed').waitFor()
  assert.equal(
    await page.evaluate(
      async (directory) =>
        (await window.desktop.inspectRepository(directory)).worktrees.length,
      project,
    ),
    beforeRetryTrees + 1,
  )
  assert.equal(
    await page.evaluate(
      async () =>
        (await window.desktop.listSessions()).filter(
          (session) => session.title === '재시도 작업',
        ).length,
    ),
    1,
  )
  await input.fill('중단 테스트')
  await input.press('Enter')
  await page.getByRole('button', { name: '작업 중단', exact: true }).waitFor()
  assert.equal(
    await page
      .getByRole('button', {
        name: 'feature/retry-test Worktree 삭제',
        exact: true,
      })
      .isDisabled(),
    true,
  )
  assert.equal(
    await page.evaluate(
      async ({ project, workspace }) => {
        try {
          await window.desktop.deleteWorktree(project, workspace)
          return false
        } catch {
          return true
        }
      },
      { project, workspace: retrySession.workspace },
    ),
    true,
  )
  await page.getByRole('button', { name: '작업 중단', exact: true }).click()
  await page.locator('.status-label.interrupted').waitFor()
  await writeFile(
    join(retrySession.workspace, '보존 파일.txt'),
    '삭제하면 안 되는 내용\n',
    'utf8',
  )
  await page
    .getByRole('button', {
      name: 'feature/retry-test Worktree 삭제',
      exact: true,
    })
    .click()
  const treeDelete = page.getByRole('dialog', {
    name: 'Worktree 삭제',
    exact: true,
  })
  assert.equal(await treeDelete.getByRole('checkbox').count(), 0)
  await treeDelete
    .getByText('node_modules·out·.env', { exact: false })
    .waitFor()
  await treeDelete
    .getByText(
      '연결된 로컬 브랜치 feature/retry-test도 미병합 커밋을 포함해 삭제합니다.',
      { exact: false },
    )
    .waitFor()
  await writeFile(
    join(retrySession.workspace, '.env'),
    '폴더와 함께 삭제할 무시 파일',
    'utf8',
  )
  await mkdir(join(retrySession.workspace, 'out'))
  await writeFile(
    join(retrySession.workspace, 'out', 'build.js'),
    'ignored build result',
    'utf8',
  )
  await treeDelete.getByRole('button', { name: '삭제', exact: true }).click()
  await treeDelete.getByRole('alert').filter({ hasText: '변경 파일' }).waitFor()
  assert.match(
    await readFile(join(retrySession.workspace, '보존 파일.txt'), 'utf8'),
    /삭제하면 안 되는 내용/,
  )
  const { rm } = await import('node:fs/promises')
  await rm(join(retrySession.workspace, '보존 파일.txt'))
  await treeDelete.getByRole('button', { name: '삭제', exact: true }).click()
  await treeDelete.waitFor({ state: 'hidden' })
  assert.equal(await stat(retrySession.workspace).catch(() => null), null)
  assert.equal(
    await page.evaluate(
      async (id) =>
        (await window.desktop.listSessions()).some(
          (session) => session.id === id,
        ),
      retrySession.id,
    ),
    false,
  )
  assert.equal(
    git('branch', '--list', 'feature/retry-test').toString().trim(),
    '',
  )
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
  await monitor.getByRole('button', { name: '조사 담당 상세 보기' }).click()
  const compactChild = page.getByRole('dialog', {
    name: '조사 담당',
    exact: true,
  })
  const compactBounds = await compactChild.boundingBox()
  assert.ok(
    compactBounds.x >= 0 &&
      compactBounds.y >= 43 &&
      compactBounds.x + compactBounds.width <= 960 &&
      compactBounds.y + compactBounds.height <= 640,
  )
  await page.screenshot({ path: 'artifacts/workspace-subagent-detail.png' })
  await compactChild
    .getByRole('button', { name: '서브에이전트 상세 닫기' })
    .click()
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
  assert.equal(await page.locator('.subagent-card').count(), 3)
  assert.equal(
    await page
      .locator('.session-row')
      .filter({ hasText: /구현 담당|검증 담당|조사 담당/ })
      .count(),
    0,
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
  assert.equal(
    await page.evaluate(
      async (id) =>
        (await window.desktop.listSessions()).some(
          (session) => session.id === id,
        ),
      retrySession.id,
    ),
    false,
  )
  assert.equal(
    await page
      .locator('.workspace-row')
      .filter({ hasText: 'feature/retry-test' })
      .count(),
    0,
  )
  assert.equal(
    await page
      .locator('.session-row')
      .filter({ hasText: '비선택 작업 관리' })
      .count(),
    0,
  )
  await page
    .locator('.workspace-row')
    .filter({ hasText: 'feature/ui-test' })
    .click()
  await page
    .locator('.workspace-row.selected')
    .filter({ hasText: '검증 Worktree' })
    .waitFor()
  assert.equal(
    await page.getByRole('textbox', { name: 'Codex에게 메시지' }).inputValue(),
    'Worktree별 입력 보존',
  )
  await page
    .getByRole('button', { name: /작업 설정하여 만들기$/ })
    .first()
    .click()
  const restoredTaskDialog = page.getByRole('dialog', {
    name: '새 작업',
    exact: true,
  })
  assert.equal(
    await restoredTaskDialog
      .getByRole('combobox', { name: '작업 공간 방식' })
      .inputValue(),
    'new',
  )
  await restoredTaskDialog
    .getByRole('combobox', { name: '작업 공간 방식' })
    .selectOption('existing')
  await restoredTaskDialog
    .getByRole('button', { name: '만들기', exact: true })
    .click()
  await restoredTaskDialog.waitFor({ state: 'detached' })
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
  await page
    .getByRole('button', { name: /작업 설정하여 만들기$/ })
    .first()
    .click()
  assert.equal(
    await restoredTaskDialog
      .getByRole('combobox', { name: '작업 공간 방식' })
      .inputValue(),
    'existing',
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
  // 현재 선택과 다른 프로젝트의 설정 버튼이 해당 프로젝트에 작업을 만듭니다.
  await page
    .getByRole('button', {
      name: '한글 project 작업 설정하여 만들기',
      exact: true,
    })
    .click()
  const targetDialog = page.getByRole('dialog', {
    name: '새 작업',
    exact: true,
  })
  await targetDialog
    .getByRole('combobox', { name: '작업 공간 방식' })
    .selectOption('new')
  await targetDialog
    .getByRole('textbox', { name: '새 작업 이름', exact: true })
    .fill('프로젝트 대상 검증')
  await targetDialog
    .getByRole('textbox', { name: '새 브랜치 이름' })
    .fill('feature/project-target')
  await targetDialog
    .getByRole('textbox', { name: '첫 요청' })
    .fill('브랜치 부분 삭제 실패 검증')
  await targetDialog
    .getByRole('button', { name: '만들고 시작', exact: true })
    .click()
  await targetDialog.waitFor({ state: 'detached' })
  await page
    .getByRole('heading', { name: '프로젝트 대상 검증', exact: true })
    .waitFor()
  await page.locator('.status-label.completed').waitFor()
  const targetTree = await page.evaluate(
    async (directory) =>
      (await window.desktop.inspectRepository(directory)).worktrees.find(
        (tree) => tree.branch === 'feature/project-target',
      ),
    project,
  )
  assert.ok(targetTree)
  const partialSession = await page.evaluate(
    async (workspace) =>
      (await window.desktop.listSessions()).find(
        (session) => session.workspace === workspace,
      ),
    targetTree.path,
  )
  assert.ok(partialSession)
  const branchLock = join(
    project,
    '.git',
    'refs',
    'heads',
    'feature',
    'project-target.lock',
  )
  await writeFile(branchLock, '', 'utf8')
  assert.equal(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem('lite-ide.workspace.v1')).project,
    ),
    project,
  )
  await page
    .getByRole('button', {
      name: 'feature/project-target Worktree 삭제',
      exact: true,
    })
    .click()
  await page
    .getByRole('dialog', { name: 'Worktree 삭제', exact: true })
    .getByRole('button', { name: '삭제', exact: true })
    .click()
  await page
    .locator('.workspace-row')
    .filter({ hasText: 'feature/project-target' })
    .waitFor({ state: 'detached' })
  await page
    .getByRole('alert')
    .filter({
      hasText: '폴더는 삭제되었지만 로컬 브랜치 feature/project-target',
    })
    .waitFor()
  assert.equal(await stat(targetTree.path).catch(() => null), null)
  assert.match(
    git('branch', '--list', 'feature/project-target').toString(),
    /feature\/project-target/,
  )
  assert.equal(
    await page.evaluate(
      async (id) =>
        (await window.desktop.listSessions()).some(
          (session) => session.id === id,
        ),
      partialSession.id,
    ),
    false,
  )
  assert.equal(
    await page.evaluate(async (workspace) => {
      try {
        await window.desktop.inspectRepository(workspace)
        return false
      } catch {
        return true
      }
    }, targetTree.path),
    true,
  )
  await rm(branchLock)
  git('branch', '-D', '--', 'feature/project-target')
  await page.getByRole('button', { name: '오류 닫기', exact: true }).click()
  const existingSessions = await page.evaluate(
    (directory) =>
      JSON.parse(localStorage.getItem('lite-ide.workspace.v1')).sessions[
        directory
      ],
    project,
  )
  await page.getByRole('button', { name: '설정', exact: true }).click()
  const projectSettings = page.getByRole('dialog', {
    name: '설정',
    exact: true,
  })
  await projectSettings
    .getByRole('tab', { name: '프로젝트', exact: true })
    .click()
  await projectSettings
    .getByRole('combobox', { name: '설정 프로젝트', exact: true })
    .selectOption(project)
  await projectSettings
    .getByRole('combobox', { name: '기본 기준 브랜치', exact: true })
    .selectOption('refs/heads/settings-base')
  await projectSettings
    .getByRole('combobox', { name: '기본 모델', exact: true })
    .selectOption('fixture-model-alt')
  await projectSettings
    .getByRole('combobox', { name: '기본 추론 수준', exact: true })
    .selectOption('high')
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(960, 600),
  )
  await projectSettings
    .getByRole('button', { name: '저장', exact: true })
    .scrollIntoViewIfNeeded()
  await page.screenshot({ path: 'artifacts/workspace-settings-project.png' })
  await projectSettings
    .getByRole('button', { name: '저장', exact: true })
    .click()
  await projectSettings
    .getByText('프로젝트 기본값을 저장했습니다. 다음 새 작업부터 적용됩니다.', {
      exact: true,
    })
    .waitFor()
  const secondProject = join(fixture, '복제한 project')
  await projectSettings
    .getByRole('combobox', { name: '설정 프로젝트', exact: true })
    .selectOption(secondProject)
  await projectSettings
    .getByRole('combobox', { name: '기본 모델', exact: true })
    .selectOption('fixture-model')
  await projectSettings
    .getByRole('combobox', { name: '기본 추론 수준', exact: true })
    .selectOption('medium')
  await projectSettings
    .getByRole('button', { name: '저장', exact: true })
    .click()
  await projectSettings
    .getByText('프로젝트 기본값을 저장했습니다. 다음 새 작업부터 적용됩니다.', {
      exact: true,
    })
    .waitFor()
  await projectSettings
    .getByRole('combobox', { name: '설정 프로젝트', exact: true })
    .selectOption(project)
  assert.equal(
    await projectSettings
      .getByRole('combobox', { name: '기본 기준 브랜치', exact: true })
      .inputValue(),
    'refs/heads/settings-base',
  )
  assert.equal(
    await projectSettings
      .getByRole('combobox', { name: '기본 모델', exact: true })
      .inputValue(),
    'fixture-model-alt',
  )
  assert.equal(
    await projectSettings
      .getByRole('combobox', { name: '기본 추론 수준', exact: true })
      .inputValue(),
    'high',
  )
  await projectSettings
    .getByRole('tab', { name: '프로그램 정보', exact: true })
    .click()
  await page.screenshot({ path: 'artifacts/workspace-settings-about.png' })
  await projectSettings
    .getByRole('button', { name: '닫기', exact: true })
    .click()
  await projectSettings.waitFor({ state: 'detached' })
  assert.deepEqual(
    await page.evaluate(
      (directory) =>
        JSON.parse(localStorage.getItem('lite-ide.workspace.v1')).sessions[
          directory
        ],
      project,
    ),
    existingSessions,
  )
  await page
    .getByRole('button', {
      name: '한글 project 작업 설정하여 만들기',
      exact: true,
    })
    .click()
  const configuredTask = page.getByRole('dialog', {
    name: '새 작업',
    exact: true,
  })
  assert.equal(
    await configuredTask
      .getByRole('combobox', { name: '이번 작업 기준 브랜치', exact: true })
      .inputValue(),
    'refs/heads/settings-base',
  )
  assert.equal(
    await configuredTask
      .getByRole('combobox', { name: '새 작업 모델', exact: true })
      .inputValue(),
    'fixture-model-alt',
  )
  assert.equal(
    await configuredTask
      .getByRole('combobox', { name: '새 작업 추론 수준', exact: true })
      .inputValue(),
    'high',
  )
  await configuredTask
    .getByRole('textbox', { name: '새 브랜치 이름', exact: true })
    .fill('feature/settings-test')
  await configuredTask
    .getByRole('textbox', { name: '새 작업 이름', exact: true })
    .fill('설정 적용 작업')
  await configuredTask
    .getByRole('textbox', { name: '첫 요청', exact: true })
    .fill('모델 전달 확인')
  await configuredTask
    .getByRole('button', { name: '만들고 시작', exact: true })
    .click()
  await configuredTask.waitFor({ state: 'detached' })
  await page.locator('.agent-heading .status-label.completed').waitFor()
  assert.match(
    await page.locator('.markdown').innerText(),
    /model=fixture-model-alt; effort=high/,
  )
  const configuredSession = await page.evaluate(async () =>
    (await window.desktop.listSessions()).find(
      (session) => session.title === '설정 적용 작업',
    ),
  )
  assert.equal(
    execFileSync(
      'git',
      ['-C', configuredSession.workspace, 'rev-parse', 'HEAD'],
      { windowsHide: true },
    )
      .toString()
      .trim(),
    settingsBaseCommit,
  )
  assert.equal(
    await stat(join(configuredSession.workspace, 'newer.txt')).catch(
      () => null,
    ),
    null,
  )
  assert.match(
    await readFile(join(project, 'hello.txt'), 'utf8'),
    /Changed line/,
  )
  await page
    .getByRole('button', {
      name: 'feature/settings-test Worktree 삭제',
      exact: true,
    })
    .click()
  await page
    .getByRole('dialog', { name: 'Worktree 삭제', exact: true })
    .getByRole('button', { name: '삭제', exact: true })
    .click()
  await page
    .locator('.workspace-row')
    .filter({ hasText: 'feature/settings-test' })
    .waitFor({ state: 'detached' })
  await page.getByRole('button', { name: '설정', exact: true }).click()
  await projectSettings
    .getByRole('tab', { name: '프로젝트', exact: true })
    .click()
  await projectSettings
    .getByRole('combobox', { name: '설정 프로젝트', exact: true })
    .selectOption(secondProject)
  await projectSettings
    .getByRole('button', { name: '프로젝트 기본값 초기화', exact: true })
    .click()
  await projectSettings
    .getByText('이 프로젝트의 기본값을 초기화했습니다.', { exact: true })
    .waitFor()
  assert.equal(
    await projectSettings
      .getByRole('combobox', { name: '기본 모델', exact: true })
      .inputValue(),
    '',
  )
  await projectSettings
    .getByRole('button', { name: '닫기', exact: true })
    .click()
  await projectSettings.waitFor({ state: 'detached' })
  const persistedSettings = await page.evaluate(() =>
    window.desktop.getSettings(),
  )
  const settingsComposer = page.getByRole('textbox', {
    name: 'Codex에게 메시지',
    exact: true,
  })
  await page
    .getByRole('combobox', { name: '모델', exact: true })
    .selectOption('fixture-model-alt')
  await page
    .getByRole('combobox', { name: '추론 수준', exact: true })
    .selectOption('low')
  await page.evaluate(
    (directory) =>
      window.desktop.updateProjectSettings(directory, {
        baseRef: 'HEAD',
        model: '',
        effort: 'high',
      }),
    project,
  )
  await page
    .getByRole('button', { name: '한글 project 새 작업', exact: true })
    .click()
  await page.waitForFunction(
    () =>
      document.querySelector('select[aria-label="모델"]').value ===
        'fixture-model' &&
      document.querySelector('select[aria-label="추론 수준"]').value === 'high',
  )
  await settingsComposer.fill('모델 전달 확인')
  await settingsComposer.press('Enter')
  await page.locator('.agent-heading .status-label.completed').waitFor()
  assert.match(
    await page.locator('.markdown').innerText(),
    /model=fixture-model; effort=high/,
  )
  await page.evaluate(
    (directory) =>
      window.desktop.updateProjectSettings(directory, {
        baseRef: 'HEAD',
        model: 'fixture-model',
        effort: '',
      }),
    project,
  )
  await page
    .getByRole('button', { name: '한글 project 새 작업', exact: true })
    .click()
  await page.waitForFunction(
    () =>
      document.querySelector('select[aria-label="추론 수준"]').value ===
      'medium',
  )
  await settingsComposer.fill('모델 전달 확인')
  await settingsComposer.press('Enter')
  await page.locator('.agent-heading .status-label.completed').waitFor()
  assert.match(
    await page.locator('.markdown').innerText(),
    /model=fixture-model; effort=medium/,
  )
  await page.evaluate(
    ({ directory, defaults }) =>
      window.desktop.updateProjectSettings(directory, defaults),
    {
      directory: project,
      defaults:
        persistedSettings.projects[
          process.platform === 'win32' ? project.toLowerCase() : project
        ],
    },
  )
  const keyFor = (path) =>
    process.platform === 'win32' ? path.toLowerCase() : path
  assert.equal(
    persistedSettings.projects[keyFor(project)].model,
    'fixture-model-alt',
  )
  assert.equal(persistedSettings.projects[keyFor(secondProject)], undefined)
  await page.screenshot({ path: 'artifacts/workspace-usage.png' })
  for (const scenario of ['error', 'empty', 'partial', 'zero']) {
    await app.close()
    app = await launch(scenario)
    page = await app.firstWindow()
    assert.deepEqual(
      await page.evaluate(() => window.desktop.getSettings()),
      persistedSettings,
    )
    assert.equal(
      (await page.evaluate(() => window.desktop.getAppInfo())).buildTime,
      initialInfo.buildTime,
    )
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
    'UI 검증 통과: 서브에이전트 관찰·추가 지시·중단·재개·복원, 프로젝트별 +·단축키 채팅 시작·초안 보존·설정 생성·모델/추론 전달·생성 후 재시도, 작업/Worktree 이름 변경·삭제·재시작 영속, 실행 중/dirty 삭제 보호·연결 브랜치 삭제, 사용량, Git 복제, 통합 타이틀바, Codex 전송/재개/승인/질문/중단, diff, 검색, 960px 3열 및 960x600 생성 창. 모든 창을 숨김 상태로 유지했습니다.',
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
