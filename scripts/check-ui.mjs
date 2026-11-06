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
  rm,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const fixture = await realpath(
  await mkdtemp(join(tmpdir(), 'lite-ide-terminal-ui-')),
)
const project = join(fixture, '한글 project')
await mkdir(project)
const git = (...args) =>
  execFileSync('git', ['-C', project, ...args], {
    windowsHide: true,
    encoding: 'utf8',
  })
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
const baseCommit = git('rev-parse', 'HEAD').trim()
git('branch', 'settings-base')
await writeFile(join(project, 'newer.txt'), 'main에만 있는 파일\n', 'utf8')
git('add', 'newer.txt')
git('-c', 'user.name=UI Test', '-c', 'user.email=test@example.invalid',
  'commit', '-m', 'newer fixture')
await mkdir('artifacts', { recursive: true })
const launch = () =>
  electron.launch({
    args: [resolve('out/main/index.js')],
    env: {
      ...process.env,
      LITE_IDE_HEADLESS: '1',
      LITE_IDE_TEST_DATA: join(fixture, 'user-data'),
      LITE_IDE_TEST_CODEX: resolve('scripts/fixtures/codex-server.mjs'),
      LITE_IDE_TEST_TERMINAL: resolve('scripts/fixtures/codex-terminal.mjs'),
      LITE_IDE_TEST_NODE: process.execPath,
    },
  })
let app = await launch()
let page
const tasks = () =>
  page.evaluate(
    () => JSON.parse(localStorage.getItem('lite-ide.workspace.v3')).tasks,
  )
const snapshot = (id) =>
  page.evaluate((id) => window.desktop.terminalSnapshot(id), id)
async function readyTerminal() {
  await page.locator('.terminal-host[data-terminal-ready="true"]').waitFor()
}
async function terminalText() {
  return page.locator('.xterm-accessibility-tree').innerText()
}
async function command(text) {
  await page.getByLabel('작업 터미널 입력').focus()
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}
async function until(check, label) {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`대기 시간 초과: ${label}`)
}
async function waitOutput(id, text) {
  await until(async () => (await snapshot(id))?.output.includes(text), text)
}
async function waitScreen(text) {
  await page.waitForFunction(
    (text) =>
      document
        .querySelector('.xterm-accessibility-tree')
        ?.textContent.includes(text),
    text,
    { timeout: 15000 },
  )
}
async function openTaskCreation() {
  await page
    .getByRole('button', { name: '한글 project 새 작업', exact: true })
    .click()
  await page.getByRole('dialog', { name: '새 작업', exact: true }).waitFor()
}
async function createDraftTask() {
  const count = (await tasks()).length
  await openTaskCreation()
  const dialog = page.getByRole('dialog', { name: '새 작업', exact: true })
  await dialog.getByRole('button', { name: '만들기', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  await until(async () => (await tasks()).length === count + 1, '새 작업 저장')
  await readyTerminal()
}
async function taskAction(task, name) {
  const row = page
    .locator('.task-row')
    .and(page.getByTitle(task.path, { exact: true }))
    .locator('..')
  await row.locator('.row-action').click()
  await page.getByRole('menuitem', { name, exact: true }).click()
}
async function panelWidths() {
  return page
    .locator('.workspace-panel > .panel')
    .evaluateAll((panels) =>
      panels.map((panel) => panel.getBoundingClientRect().width),
    )
}
async function dragPanel(name, offset) {
  const bounds = await page
    .getByRole('separator', { name, exact: true })
    .boundingBox()
  const x = bounds.x + bounds.width / 2,
    y = bounds.y + bounds.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + offset, y, { steps: 8 })
  await page.mouse.up()
}
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
  page.setDefaultTimeout(15000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page
    .getByRole('heading', { name: '작업 터미널을 시작하세요' })
    .waitFor()
  await checkTitlebar(page, app)
  const widths = await panelWidths()
  await dragPanel('프로젝트 패널 크기 조절', 45)
  assert.ok((await panelWidths())[0] > widths[0] + 35)
  await page
    .getByRole('separator', { name: '프로젝트 패널 크기 조절' })
    .press('ArrowLeft')
  const savedWidths = await panelWidths()
  await page.reload()
  await page
    .getByRole('heading', { name: '작업 터미널을 시작하세요' })
    .waitFor()
  const restoredWidths = await panelWidths()
  assert.ok(
    restoredWidths.every(
      (value, index) => Math.abs(value - savedWidths[index]) < 2,
    ),
  )
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, project)
  await page
    .getByRole('button', { name: '프로젝트 열기', exact: true })
    .first()
    .click()
  await page.getByRole('button', { name: '로컬 폴더 열기' }).click()
  await page
    .locator('.project-name')
    .filter({ hasText: '한글 project' })
    .waitFor()
  await assert.rejects(
    page.evaluate(
      (workspace) =>
        window.desktop.openTerminal({
          taskId: 'root',
          workspace,
          kind: 'shell',
          cols: 80,
          rows: 24,
        }),
      project,
    ),
    /Worktree/,
  )
  await page.getByRole('button', { name: '설정', exact: true }).click()
  const projectSettings = page.getByRole('dialog', { name: '설정', exact: true })
  await projectSettings.getByRole('tab', { name: '프로젝트', exact: true }).click()
  await projectSettings
    .getByRole('combobox', { name: '기본 기준 브랜치', exact: true })
    .selectOption('refs/heads/settings-base')
  await projectSettings.getByRole('button', { name: '저장', exact: true }).click()
  await projectSettings.getByText(
    '프로젝트 기본값을 저장했습니다. 다음 새 작업부터 적용됩니다.',
    { exact: true },
  ).waitFor()
  await projectSettings.getByRole('button', { name: '닫기', exact: true }).click()
  const worktreesBefore = git('worktree', 'list', '--porcelain')
  await openTaskCreation()
  const creation = page.getByRole('dialog', { name: '새 작업', exact: true })
  const baseBranch = creation.getByRole('combobox', {
    name: '이번 작업 기준 브랜치', exact: true,
  })
  assert.equal(await baseBranch.inputValue(), 'refs/heads/settings-base')
  assert.equal((await tasks()).length, 0)
  await baseBranch.selectOption('refs/heads/main')
  await creation.getByRole('button', { name: '취소', exact: true }).click()
  await creation.waitFor({ state: 'detached' })
  assert.equal(git('worktree', 'list', '--porcelain'), worktreesBefore)
  await createDraftTask()
  const first = (await tasks())[0]
  assert.equal(first.name, first.branch)
  assert.equal(execFileSync('git', ['-C', first.path, 'rev-parse', 'HEAD'], {
    windowsHide: true, encoding: 'utf8',
  }).trim(), baseCommit)
  await waitOutput(first.id, 'codex> ')
  assert.equal(
    await page.locator('.composer, .user-message, .assistant-message').count(),
    0,
  )
  assert.equal(await page.locator('.task-row').count(), 1)
  assert.equal(await page.locator('.managed-row .row-action').count(), 1)
  const firstGeneration = (await snapshot(first.id)).generation
  const unique = 'PTY_ONLY_ONCE_TEST'
  await command(unique)
  await waitOutput(first.id, 'OK')
  await waitScreen(unique)
  assert.equal((await terminalText()).split(unique).length - 1, 1)
  // 원시 입력 픽스처 대신 IPC 경계에서 수정 키의 보존과 중복 전송을 확인합니다.
  await app.evaluate(({ ipcMain }) => {
    globalThis.originalTerminalWrite = ipcMain._invokeHandlers.get('terminal:write')
    globalThis.terminalKeyWrites = []
    ipcMain.removeHandler('terminal:write')
    ipcMain.handle('terminal:write', (_event, id, data) => {
      globalThis.terminalKeyWrites.push({ id, data })
    })
  })
  try {
    await page.getByLabel('작업 터미널 입력').focus()
    await page.keyboard.press('Shift+Enter')
    await page.keyboard.press('Control+Enter')
    await page.keyboard.press('Control+Shift+Enter')
    await page.keyboard.press('Enter')
    await until(
      () => app.evaluate(() => globalThis.terminalKeyWrites.length === 4),
      '줄바꿈·대기열·일반 Enter 키 전달',
    )
    const keys = await app.evaluate(() => globalThis.terminalKeyWrites)
    const sequences = process.platform === 'win32'
      ? [16, 8, 24].map((modifiers) =>
          `\x1b[13;28;13;1;${modifiers};1_\x1b[13;28;13;0;${modifiers};1_`,
        )
      : [2, 5, 6].map((modifier) => `\x1b[13;${modifier}u`)
    assert.deepEqual(keys, [...sequences, '\r'].map((data) => ({ id: first.id, data })))
  } finally {
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('terminal:write')
      ipcMain.handle('terminal:write', globalThis.originalTerminalWrite)
      delete globalThis.originalTerminalWrite
      delete globalThis.terminalKeyWrites
    })
  }
  const multilingual = 'UTF8_한글_😀'
  await page.evaluate(
    (text) =>
      Object.defineProperty(navigator.clipboard, 'readText', {
        configurable: true,
        value: async () => text,
      }),
    multilingual,
  )
  await page.getByLabel('작업 터미널 입력').focus()
  await page.keyboard.press('Control+Shift+v')
  await waitOutput(first.id, multilingual)
  await page.keyboard.press('Enter')
  await waitScreen(multilingual)
  assert.equal((await terminalText()).split(multilingual).length - 1, 1)
  await command('/help')
  await waitOutput(first.id, 'Commands: /help /model')
  await command('/model')
  await waitOutput(first.id, 'model: fixture-model')
  await command('/slow')
  await waitOutput(first.id, 'working')
  await page.keyboard.press('Control+c')
  await waitOutput(first.id, 'INTERRUPTED')
  assert.equal((await snapshot(first.id)).running, true)
  // 출력이 진행되는 동안 새로 붙어도 스냅샷과 이벤트를 중복 렌더링하지 않습니다.
  await page.reload()
  await readyTerminal()
  await waitScreen(unique)
  assert.equal((await snapshot(first.id)).generation, firstGeneration)
  assert.equal((await terminalText()).split(unique).length - 1, 1)
  await page.getByLabel('작업 터미널 입력').focus()
  const stateBefore = await tasks()
  await page.keyboard.press('Control+n')
  await creation.waitFor()
  assert.equal(await baseBranch.inputValue(), 'refs/heads/settings-base')
  assert.deepEqual(await tasks(), stateBefore)
  await page.keyboard.press('Escape')
  await creation.waitFor({ state: 'detached' })
  assert.deepEqual(await tasks(), stateBefore)
  await page.getByRole('button', { name: '새 작업', exact: true }).click()
  await creation.waitFor()
  assert.equal(await baseBranch.inputValue(), 'refs/heads/settings-base')
  assert.equal((await tasks()).length, 1)
  await creation.getByRole('button', { name: '취소', exact: true }).click()
  await creation.waitFor({ state: 'detached' })
  await page.keyboard.press('Control+n')
  await creation.waitFor()
  await baseBranch.selectOption('refs/heads/main')
  await creation.getByRole('textbox', { name: '새 작업 이름', exact: true })
    .fill('단축키 작업')
  await creation.getByRole('button', { name: '만들기', exact: true }).click()
  await creation.waitFor({ state: 'detached' })
  await page.waitForFunction(
    () => document.querySelectorAll('.task-row').length === 2,
  )
  await readyTerminal()
  const second = (await tasks()).find((task) => task.id !== first.id)
  assert.equal(second.name, '단축키 작업')
  assert.equal(execFileSync('git', ['-C', second.path, 'rev-parse', 'HEAD'], {
    windowsHide: true, encoding: 'utf8',
  }).trim(), git('rev-parse', 'main').trim())
  assert.equal(await page.evaluate(async (path) => {
    const key = window.desktop.platform === 'win32' ? path.toLowerCase() : path
    return (await window.desktop.getSettings()).projects[key].baseRef
  }, project), 'refs/heads/settings-base')
  await windowWrite(first.id, 'BACKGROUND_ONCE\r')
  await waitOutput(first.id, 'BACKGROUND_ONCE')
  await page
    .getByRole('tablist', { name: '작업 탭' })
    .getByRole('tab')
    .nth(0)
    .click()
  await readyTerminal()
  await waitScreen('BACKGROUND_ONCE')
  assert.equal((await terminalText()).split('BACKGROUND_ONCE').length - 1, 1)
  assert.equal((await snapshot(first.id)).generation, firstGeneration)
  await taskAction(first, '이름 변경')
  const rename = page.getByRole('dialog', {
    name: '작업 이름 변경',
    exact: true,
  })
  await rename
    .getByRole('textbox', { name: '작업 이름', exact: true })
    .fill('통합 작업')
  await rename.getByRole('button', { name: '저장', exact: true }).click()
  await page.getByRole('heading', { name: '통합 작업', exact: true }).waitFor()
  assert.equal(
    (await tasks()).find((task) => task.id === first.id).name,
    '통합 작업',
  )
  assert.equal(await page.getByRole('tab', { name: /통합 작업/ }).count(), 1)
  await page.screenshot({ path: 'artifacts/workspace-terminal.png' })
  // 일반 셸은 동일한 작업 폴더에서 실제 명령을 실행합니다.
  await page.getByRole('button', { name: '셸 터미널', exact: true }).click()
  await until(
    async () => (await snapshot(first.id))?.kind === 'shell',
    '셸 전환',
  )
  await readyTerminal()
  if (process.platform === 'win32') await waitOutput(first.id, 'PS ')
  else await until(async () => !!(await snapshot(first.id))?.output, '셸 시작')
  const shellGeneration = (await snapshot(first.id)).generation
  assert.notEqual(shellGeneration, firstGeneration)
  await command(
    process.platform === 'win32'
      ? "Write-Output 'REAL_SHELL_OK'"
      : "printf 'REAL_SHELL_OK\n'",
  )
  await waitScreen('REAL_SHELL_OK')
  await page.waitForFunction(() =>
    document
      .querySelector('.xterm-accessibility-tree')
      ?.innerText.split('\n')
      .some((line) => line.trim() === 'REAL_SHELL_OK'),
  )
  await command('git branch --show-current')
  await waitScreen(first.branch)
  await writeFile(join(first.path, 'dirty.txt'), '보호할 파일\n', 'utf8')
  await page.getByRole('button', { name: '변경 사항 새로고침' }).click()
  await page.getByRole('button', { name: 'dirty.txt', exact: true }).waitFor()
  await page.getByRole('button', { name: 'dirty.txt', exact: true }).click()
  await page.getByText('+보호할 파일', { exact: false }).waitFor()
  await taskAction({ ...first, name: '통합 작업' }, '작업 삭제')
  const deleting = page.getByRole('dialog', { name: '작업 삭제', exact: true })
  await deleting
    .getByRole('button', { name: '변경 사항 포함 삭제', exact: true })
    .waitFor()
  assert.equal((await snapshot(first.id)).running, true)
  await deleting.getByRole('button', { name: '취소', exact: true }).click()
  await rm(join(first.path, 'dirty.txt'))
  await writeFile(
    join(second.path, '확인 후 삭제.txt'),
    '버릴 변경 사항\n',
    'utf8',
  )
  // 저장된 브랜치가 달라져도 삭제 직전에 실제 연결된 브랜치를 사용합니다.
  const switchedBranch = 'feature/switched-for-delete'
  execFileSync('git', ['-C', second.path, 'switch', '-c', switchedBranch], {
    windowsHide: true, encoding: 'utf8',
  })
  await assert.rejects(
    page.evaluate(
      (task) => window.desktop.deleteWorktree(task.project, task.path),
      second,
    ),
    /확인/,
  )
  assert.equal((await snapshot(second.id)).running, true)
  await taskAction(second, '작업 삭제')
  await deleting.getByText(`현재 연결된 로컬 브랜치: ${switchedBranch}`, { exact: true }).waitFor()
  assert.equal(
    await page.getByRole('dialog', { name: '작업 삭제', exact: true }).count(),
    1,
  )
  await deleting
    .getByRole('button', { name: '변경 사항 포함 삭제', exact: true })
    .click()
  await deleting.waitFor({ state: 'hidden' })
  assert.equal((await tasks()).length, 1)
  assert.equal(await stat(second.path).catch(() => null), null)
  assert.equal(git('branch', '--list', switchedBranch).trim(), '')
  assert.ok(git('branch', '--list', second.branch).trim())
  assert.equal(await snapshot(second.id), null)
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(960, 640),
  )
  await dragPanel('프로젝트 패널 크기 조절', 1000)
  const minWidths = await panelWidths()
  assert.ok(minWidths[0] >= 189 && minWidths[1] >= 359 && minWidths[2] >= 239)
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  )
  await page.getByRole('button', { name: '변경 패널 전환' }).click()
  assert.equal(await page.locator('.panel').count(), 2)
  await page.getByRole('button', { name: '변경 패널 전환' }).click()
  await checkTitlebar(page, app)
  await page.getByRole('button', { name: '라이트 테마' }).click()
  await page.screenshot({ path: 'artifacts/workspace-terminal-compact.png' })
  await page.keyboard.press('Control+,')
  const settings = page.getByRole('dialog', { name: '설정', exact: true })
  await settings
    .getByRole('tab', { name: '프로그램 정보', exact: true })
    .click()
  const info = await page.evaluate(() => window.desktop.getAppInfo())
  assert.equal(
    info.version,
    JSON.parse(await readFile('package.json', 'utf8')).version,
  )
  await settings.getByRole('button', { name: '닫기', exact: true }).click()
  await page.getByRole('button', { name: 'Codex 터미널', exact: true }).click()
  await waitOutput(first.id, 'fixture · resume')
  await app.close()
  app = await launch()
  page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  await readyTerminal()
  await page.getByRole('heading', { name: '통합 작업', exact: true }).waitFor()
  await waitOutput(first.id, 'fixture · resume')
  assert.equal((await tasks()).length, 1)
  assert.equal((await tasks())[0].path, first.path)
  // Git에서 이미 제거된 작업을 재시작 후에도 보존하고, 파일을 건드리지 않고 정리합니다.
  await createDraftTask()
  const stale = (await tasks()).find((task) => task.id !== first.id)
  await page.evaluate((id) => window.desktop.closeTerminal(id), stale.id)
  git('worktree', 'remove', '--force', '--', stale.path)
  await mkdir(stale.path)
  await writeFile(join(stale.path, '보존.txt'), '남아 있는 파일', 'utf8')
  await app.close()
  app = await launch()
  page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  await page.getByText(/작업 경로를 사용할 수 없습니다/).first().waitFor()
  assert.equal((await tasks()).length, 2)
  await taskAction(stale, '작업 삭제')
  const cleanup = page.getByRole('dialog', { name: '작업 삭제', exact: true })
  await cleanup.getByRole('button', { name: '로컬 기록 정리', exact: true }).click()
  await cleanup.waitFor({ state: 'hidden' })
  assert.equal((await tasks()).length, 1)
  assert.equal(await readFile(join(stale.path, '보존.txt'), 'utf8'), '남아 있는 파일')
  assert.ok(git('branch', '--list', stale.branch).trim())
  assert.deepEqual(errors, [])
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isVisible(),
    ),
    false,
  )
  console.log(
    'UI 검증 통과: 프로젝트/탭 +·단축키 생성 창·취소 시 작업/Worktree 보존, 기준 브랜치 기본값 저장·작업별 변경·실제 생성 커밋 확인, 실제 PTY 셸 명령, Codex 터미널 명령·Ctrl+C, 입력/재연결 출력 중복 방지, 탭 전환과 백그라운드 출력, 작업·Worktree 단일 이름/삭제, 변경 사항 1회 확인 삭제·취소 시 보존·프로세스 종료·브랜치 삭제, 재시작 복원, 패널 조절·960px·라이트 테마·타이틀바·설정·diff. 창을 숨김 상태로 유지했습니다.',
  )
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: 'artifacts/workspace-terminal-failure.png' })
    console.error(await page.locator('body').innerText())
    console.error(
      'PTY FAILURE',
      await page.evaluate(async () => {
        const list = JSON.parse(
          localStorage.getItem('lite-ide.workspace.v3'),
        ).tasks
        return Promise.all(
          list.map((task) => window.desktop.terminalSnapshot(task.id)),
        )
      }),
    )
  }
  throw error
} finally {
  await app.close()
}
async function windowWrite(id, data) {
  await page.evaluate(
    ({ id, data }) => window.desktop.writeTerminal(id, data),
    { id, data },
  )
}
