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
const launch = (environment = {}) =>
  electron.launch({
    args: [resolve('out/main/index.js')],
    env: {
      ...process.env,
      LITE_IDE_HEADLESS: '1',
      LITE_IDE_TEST_DATA: join(fixture, 'user-data'),
      LITE_IDE_TEST_CODEX: resolve('scripts/fixtures/codex-server.mjs'),
      LITE_IDE_TEST_TERMINAL: resolve('scripts/fixtures/codex-terminal.mjs'),
      LITE_IDE_TEST_NODE: process.execPath,
      ...environment,
    },
  })
let app = await launch()
let page
const errors = []
function observeErrors(page) {
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (/same key|unique.*key|duplicate.*key/i.test(message.text())) errors.push(message.text())
  })
}
const tasks = () =>
  page.evaluate(
    () => JSON.parse(localStorage.getItem('lite-ide.workspace.v3')).tasks,
  )
const snapshot = (id) =>
  page.evaluate((id) => window.desktop.terminalSnapshot(id), id)
async function readyTerminal() {
  await page.locator('.terminal-host[data-terminal-ready="true"]:visible').waitFor()
}
async function terminalText() {
  return page.locator('.xterm-accessibility-tree:visible').innerText()
}
async function command(text) {
  await page.locator('[aria-label="작업 터미널 입력"]:visible').focus()
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
        .querySelector('.task-terminal-slot:not([hidden]) .xterm-accessibility-tree')
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
  observeErrors(page)
  page.setDefaultTimeout(15000)
  if (process.argv.includes('--settings-only')) {
    await setupFocusedTerminal()
    await checkSettingsLayout()
    assert.deepEqual(errors, [])
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false)
    console.log('설정 화면 숨김 UI 검증 통과')
  } else if (process.argv.includes('--cursor-only') || process.argv.includes('--compact-only')) {
    const task = await setupFocusedTerminal()
    if (process.argv.includes('--compact-only')) {
      await command('/child')
      await waitOutput(task.id, 'CHILD_PID:')
      await page.getByRole('button', { name: '프로세스', exact: true }).click()
      await page.locator('.process-table').waitFor()
      await checkCompactProcessLayout(task)
    } else {
      await checkRemoteCursor()
      await checkMiddleInsertion(task)
    }
    assert.deepEqual(errors, [])
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false)
    console.log('focused 숨김 UI 검증 통과')
  } else {
  await page
    .getByRole('heading', { name: '작업 터미널을 시작하세요' })
    .waitFor()
  await checkTitlebar(page, app)
  await checkResetAnnouncements()
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
  await page.getByRole('button', { name: '한글 project 기준 브랜치 관리', exact: true }).click()
  const projectSettings = page.getByRole('dialog', { name: '설정', exact: true })
  assert.equal(await projectSettings.getByRole('tab', { name: '프로젝트', exact: true })
    .getAttribute('aria-selected'), 'true')
  assert.equal(await projectSettings.getByRole('combobox', { name: '설정 프로젝트' })
    .inputValue(), project)
  const defaultBase = projectSettings.getByRole('combobox', { name: '기본 기준 브랜치', exact: true })
  await until(() => defaultBase.isEnabled(), '기준 브랜치 로딩')
  git('branch', 'refresh-base')
  git('update-ref', 'refs/remotes/origin/refresh-base', baseCommit)
  await projectSettings.getByRole('button', { name: '브랜치 목록 새로고침' }).click()
  await until(() => defaultBase.isEnabled(), '기준 브랜치 새로고침')
  await until(async () => await defaultBase.locator('option[value="refs/heads/refresh-base"]').count() === 1, '추가한 브랜치 반영')
  assert.equal(await defaultBase.locator('optgroup[label="로컬 브랜치"] option[value="refs/heads/refresh-base"]').count(), 1)
  assert.equal(await defaultBase.locator('optgroup[label="원격 브랜치"] option[value="refs/remotes/origin/refresh-base"]').count(), 1)
  await defaultBase.selectOption('refs/heads/refresh-base')
  git('branch', '-D', 'refresh-base')
  await projectSettings.getByRole('button', { name: '브랜치 목록 새로고침' }).click()
  await projectSettings.getByText('저장된 기준 브랜치가 없습니다. 사용할 브랜치를 다시 선택해 주세요.', { exact: true }).waitFor()
  assert.equal(await projectSettings.getByRole('button', { name: '저장', exact: true }).isDisabled(), true)
  // 조회 실패를 표시하고 새로고침으로 복구하며 편집 중인 선택은 보존합니다.
  await app.evaluate(({ ipcMain }) => {
    globalThis.originalBranches = ipcMain._invokeHandlers.get('repository:branches')
    ipcMain.removeHandler('repository:branches')
    ipcMain.handle('repository:branches', () => { throw new Error('BRANCH_LOAD_FAILURE') })
  })
  try {
    await projectSettings.getByRole('button', { name: '브랜치 목록 새로고침' }).click()
    await projectSettings.getByRole('alert').filter({ hasText: 'BRANCH_LOAD_FAILURE' }).waitFor()
    assert.equal(await projectSettings.getByRole('button', { name: '저장', exact: true }).isDisabled(), true)
    assert.equal(await defaultBase.inputValue(), 'refs/heads/refresh-base')
  } finally {
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('repository:branches')
      ipcMain.handle('repository:branches', globalThis.originalBranches)
      delete globalThis.originalBranches
    })
  }
  await projectSettings.getByRole('button', { name: '브랜치 목록 새로고침' }).click()
  await until(() => defaultBase.isEnabled(), '브랜치 조회 실패 복구')
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
  await creation.getByRole('textbox', { name: '새 작업 이름', exact: true }).fill('작성 중인 작업')
  await creation.getByRole('textbox', { name: '첫 요청', exact: true }).fill('입력 보존 확인')
  await creation.getByRole('button', { name: '기본 기준 브랜치 관리', exact: true }).click()
  await projectSettings.waitFor()
  assert.equal(await projectSettings.getByRole('tab', { name: '프로젝트', exact: true })
    .getAttribute('aria-selected'), 'true')
  await projectSettings.getByRole('button', { name: '닫기', exact: true }).click()
  assert.equal(await baseBranch.inputValue(), 'refs/heads/main')
  assert.equal(await creation.getByRole('textbox', { name: '새 작업 이름', exact: true }).inputValue(), '작성 중인 작업')
  assert.equal(await creation.getByRole('textbox', { name: '첫 요청', exact: true }).inputValue(), '입력 보존 확인')
  git('branch', 'task-refresh-base', baseCommit)
  await creation.getByRole('button', { name: '브랜치 목록 새로고침' }).click()
  await until(() => baseBranch.isEnabled(), '새 작업 브랜치 새로고침')
  await baseBranch.selectOption('refs/heads/task-refresh-base')
  git('branch', '-D', 'task-refresh-base')
  await creation.getByRole('button', { name: '브랜치 목록 새로고침' }).click()
  await creation.getByText('저장된 기준 브랜치가 없습니다. 사용할 브랜치를 다시 선택해 주세요.', { exact: true }).waitFor()
  assert.equal(await creation.getByRole('button', { name: '만들고 시작', exact: true }).isDisabled(), true)
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
    await page.locator('[aria-label="작업 터미널 입력"]:visible').focus()
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
    // IME 확정과 Enter가 같은 이벤트 루프에서 발생해도 한글을 먼저 한 번만 전송합니다.
    for (const [modifiers, expected] of [
      [{ shiftKey: true }, sequences[0]],
      [{ ctrlKey: true }, sequences[1]],
      [{}, '\r'],
    ]) {
      await app.evaluate(() => { globalThis.terminalKeyWrites = [] })
      await page.getByLabel('작업 터미널 입력').evaluate(async (input, modifiers) => {
        input.value = ''
        input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }))
        input.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: '한글' }))
        input.value = '한글'
        await new Promise((resolve) => setTimeout(resolve, 0))
        input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '한글' }))
        input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13, ...modifiers }))
        input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13, ...modifiers }))
        await new Promise((resolve) => setTimeout(resolve, 20))
      }, modifiers)
      const writes = await app.evaluate(() => globalThis.terminalKeyWrites)
      assert.deepEqual(writes.filter((entry) => entry.data), [
        { id: first.id, data: '한글' }, { id: first.id, data: expected },
      ], '한글 확정 후 Enter 순서 및 마지막 글자 중복 방지')
    }
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
  await page.locator('[aria-label="작업 터미널 입력"]:visible').focus()
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
  await page.keyboard.press('Control+f')
  await page.getByLabel('터미널 검색어').fill(unique)
  await page.waitForFunction(() => document.querySelector('.terminal-search-count')?.textContent.includes('1 / 1'))
  await page.getByLabel('터미널 검색어').press('Escape')
  await checkRemoteCursor()
  await checkMiddleInsertion(first)
  // 출력이 진행되는 동안 새로 붙어도 스냅샷과 이벤트를 중복 렌더링하지 않습니다.
  await page.reload()
  await readyTerminal()
  await waitScreen(unique)
  assert.equal((await snapshot(first.id)).generation, firstGeneration)
  assert.equal((await terminalText()).split(unique).length - 1, 1)
  await page.locator('[aria-label="작업 터미널 입력"]:visible').focus()
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
  const workTabs = page.getByRole('tablist', { name: '작업 탭' })
  assert.equal(await workTabs.getByRole('tab').count(), 1)
  assert.equal(await workTabs.getByRole('tab', { name: new RegExp(first.name) }).count(), 0)
  // 다른 Worktree로의 이동은 사이드바에서 수행하며 탭에는 현재 작업만 남습니다.
  await page.locator('.task-row').and(page.getByTitle(first.path, { exact: true })).click()
  await readyTerminal()
  await waitScreen('BACKGROUND_ONCE')
  assert.equal((await terminalText()).split('BACKGROUND_ONCE').length - 1, 1)
  assert.equal((await snapshot(first.id)).generation, firstGeneration)
  await checkRepositoryFailure(first, second)
  const firstDot = page.locator('.task-row').and(page.getByTitle(first.path, { exact: true })).locator('.session-dot')
  const secondDot = page.locator('.task-row').and(page.getByTitle(second.path, { exact: true })).locator('.session-dot')
  await until(async () => await firstDot.getAttribute('aria-label') === '상태 확인 중', '세션 관측 전 상태 표시')
  await app.evaluate(({ BrowserWindow }, { workspace, other }) => {
    const web = BrowserWindow.getAllWindows()[0].webContents
    const session = { workspace, title: '관찰 세션', id: 'ui-session', status: 'running', messages: [{ id: 'message', kind: 'assistant', text: '실제 세션 본문 표시' }], requests: [], updatedAt: Date.now(), canAcceptDirectInput: false }
    web.send('codex:session', session)
    web.send('codex:session', { ...session, id: 'ui-child', title: '검증 서브에이전트', parentSessionId: session.id, task: '서브에이전트 작업 설명', messages: [{ id: 'child-message', kind: 'assistant', text: '서브에이전트 실행 결과' }] })
    web.send('codex:session', { ...session, id: 'ui-other', title: '다른 워크트리 세션', workspace: other })
  }, { workspace: first.path, other: second.path })
  await until(async () => await firstDot.getAttribute('aria-label') === '작업 중', '작업 중 상태 표시')
  assert.equal(await firstDot.evaluate((dot) => getComputedStyle(dot).backgroundColor), 'rgb(108, 177, 123)')
  // 선택하지 않은 작업도 실시간 상태를 반영합니다.
  for (const [status, label, color] of [
    ['idle', '입력 대기 중', null],
    ['waiting', '답변 대기 중', 'rgb(229, 189, 70)'],
    ['completed', '작업 완료', 'rgb(216, 132, 123)'],
    ['running', '작업 중', 'rgb(108, 177, 123)'],
  ]) {
    await app.evaluate(({ BrowserWindow }, { workspace, status }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('codex:session', {
        workspace, title: '다른 워크트리 세션', id: 'ui-other', status,
        messages: [], requests: [], updatedAt: Date.now(), canAcceptDirectInput: false,
      })
    }, { workspace: second.path, status })
    await until(async () => await secondDot.getAttribute('aria-label') === label, `백그라운드 작업 ${label}`)
    assert.equal(await secondDot.getAttribute('title'), label)
    if (color) assert.equal(await secondDot.evaluate((dot) => getComputedStyle(dot).backgroundColor), color)
    assert.equal(await firstDot.getAttribute('aria-label'), '작업 중')
  }
  await windowWrite(second.id, '/question\r')
  await waitOutput(second.id, 'QUESTION_WAITING')
  await until(async () => await secondDot.getAttribute('aria-label') === '답변 대기 중', '백그라운드 터미널 질문 대기')
  await windowWrite(second.id, '답변')
  assert.equal(await secondDot.getAttribute('aria-label'), '답변 대기 중')
  await windowWrite(second.id, '\r')
  await until(async () => await secondDot.getAttribute('aria-label') === '작업 중', '답변 제출 후 상태 복원')
  await workTabs.getByRole('tab', { name: /검증 서브에이전트/ }).click()
  await page.getByText('서브에이전트 실행 결과', { exact: true }).waitFor()
  assert.equal(await page.getByText('서브에이전트 작업 설명', { exact: true }).count(), 1)
  assert.equal(await workTabs.getByRole('tab', { name: /다른 워크트리 세션/ }).count(), 0)
  assert.equal(await page.getByLabel('세션 추가 지시').count(), 0)
  await checkQuestionDraft(first, second)
  // OS 토스트를 띄우지 않고 같은 클릭 이벤트로 작업·세션 선택을 검증합니다.
  await app.evaluate(({ BrowserWindow }, workspace) => {
    BrowserWindow.getAllWindows()[0].webContents.send('notifications:click', { workspace, sessionId: 'ui-session' })
  }, first.path)
  await page.getByText('실제 세션 본문 표시', { exact: true }).waitFor()
  await app.evaluate(({ BrowserWindow }, target) => {
    BrowserWindow.getAllWindows()[0].webContents.send('notifications:click', target)
  }, { workspace: second.path, taskId: second.id })
  await until(() => page.evaluate((id) => JSON.parse(localStorage.getItem('lite-ide.workspace.v3')).taskId === id, second.id), '알림 클릭 작업 전환')
  await readyTerminal()
  await app.evaluate(({ BrowserWindow }, target) => {
    BrowserWindow.getAllWindows()[0].webContents.send('notifications:click', target)
  }, { workspace: first.path, taskId: first.id })
  await until(() => page.evaluate((id) => JSON.parse(localStorage.getItem('lite-ide.workspace.v3')).taskId === id, first.id), '알림 클릭 원래 작업 복원')
  await readyTerminal()
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('notifications:click', { workspace: '/deleted-workspace', taskId: 'deleted-task' })
  })
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('lite-ide.workspace.v3')).taskId), first.id)
  await workTabs.getByRole('tab', { name: /관찰 세션/ }).click()
  await page.getByText('실제 세션 본문 표시', { exact: true }).waitFor()
  await workTabs.getByRole('tab', { name: new RegExp(first.name) }).click()
  assert.equal((await snapshot(first.id)).generation, firstGeneration)
  await command('/child')
  await waitOutput(first.id, 'CHILD_PID:')
  const childPid = Number((await snapshot(first.id)).output.match(/CHILD_PID:(\d+)/)[1])
  await page.getByRole('button', { name: '프로세스', exact: true }).click()
  await page.getByRole('button', { name: `프로세스 ${childPid} 종료`, exact: true }).waitFor()
  const processes = await page.evaluate((path) => window.desktop.inspectProcesses(path), first.path)
  assert.ok(processes.processes.some((process) => process.root && process.taskId === first.id))
  assert.ok(processes.processes.every((process) => process.taskId === first.id))
  await checkCompactProcessLayout(first)
  await page.getByRole('button', { name: `프로세스 ${childPid} 종료`, exact: true }).click()
  await page.getByRole('button', { name: '프로세스 종료 확인', exact: true }).click()
  await waitOutput(first.id, `CHILD_EXIT:${childPid}`)
  assert.equal((await snapshot(first.id)).running, true)
  await page.locator('.process-panel-heading > button').first().click()
  await taskAction(first, '이름 변경')
  const rename = page.getByRole('dialog', {
    name: '작업 이름 변경',
    exact: true,
  })
  await rename
    .getByRole('textbox', { name: '작업 이름', exact: true })
    .fill('통합 작업')
  await rename.getByRole('button', { name: '저장', exact: true }).click()
  await page.getByRole('tab', { name: '통합 작업', exact: true }).waitFor()
  assert.equal(await page.locator('.startup-panel, .agent-heading, .terminal-toolbar').count(), 0)
  assert.equal(
    (await tasks()).find((task) => task.id === first.id).name,
    '통합 작업',
  )
  assert.equal(await page.getByRole('tab', { name: /통합 작업/ }).count(), 1)
  await page.screenshot({ path: 'artifacts/workspace-terminal.png' })
  // 일반 셸은 동일한 작업 폴더에서 실제 명령을 실행합니다.
  await taskAction(first, '셸 터미널')
  await until(
    async () => (await snapshot(first.id))?.kind === 'shell',
    '셸 전환',
  )
  await readyTerminal()
  if (process.platform === 'win32') await waitOutput(first.id, 'PS ')
  else await until(async () => !!(await snapshot(first.id))?.output, '셸 시작')
  const shellGeneration = (await snapshot(first.id)).generation
  assert.notEqual(shellGeneration, firstGeneration)
  await until(async () => await firstDot.getAttribute('aria-label') === '연결 안 됨', '셸 전환 시 에이전트 연결 해제 표시')
  assert.equal(await firstDot.evaluate((dot) => getComputedStyle(dot).backgroundColor), 'rgb(0, 0, 0)')
  await command(
    process.platform === 'win32'
      ? "Write-Output 'REAL_SHELL_OK'"
      : "printf 'REAL_SHELL_OK\n'",
  )
  await waitScreen('REAL_SHELL_OK')
  await page.waitForFunction(() =>
    document
      .querySelector('.task-terminal-slot:not([hidden]) .xterm-accessibility-tree')
      ?.innerText.split('\n')
      .some((line) => line.trim() === 'REAL_SHELL_OK'),
  )
  await command('git branch --show-current')
  await waitScreen(first.branch)
  await writeFile(join(first.path, 'dirty.txt'), '보호할 파일\n', 'utf8')
  await page.getByRole('button', { name: '변경 사항 새로고침' }).click()
  await page.getByRole('treeitem', { name: 'dirty.txt', exact: true }).waitFor()
  await page.getByRole('treeitem', { name: 'dirty.txt', exact: true }).click()
  await page.getByText('+보호할 파일', { exact: false }).waitFor()
  assert.equal(await page.locator('.changes-panel .diff-preview').count(), 0)
  assert.equal(await page.locator('.agent-panel .main-diff').count(), 1)
  await page.getByRole('treeitem', { name: 'dirty.txt', exact: true }).click()
  assert.equal(await page.getByRole('tab', { name: 'dirty.txt', exact: true }).count(), 1)
  // 변경 내용 탭을 보고 있어도 응답 대기 알림은 터미널·세션을 앞으로 전환합니다.
  await app.evaluate(({ BrowserWindow }, target) => {
    BrowserWindow.getAllWindows()[0].webContents.send('notifications:click', target)
  }, { workspace: first.path, taskId: first.id })
  await page.locator('.agent-panel .main-diff').waitFor({ state: 'hidden' })
  await readyTerminal()
  await page.getByRole('tab', { name: 'dirty.txt', exact: true }).click()
  await page.getByText('+보호할 파일', { exact: false }).waitFor()
  await app.evaluate(({ BrowserWindow }, target) => {
    BrowserWindow.getAllWindows()[0].webContents.send('notifications:click', target)
  }, { workspace: first.path, sessionId: 'ui-session' })
  await page.locator('.agent-panel .main-diff').waitFor({ state: 'hidden' })
  await page.getByText('실제 세션 본문 표시', { exact: true }).waitFor()
  await page.getByRole('tab', { name: 'dirty.txt', exact: true }).click()
  await page.getByText('+보호할 파일', { exact: false }).waitFor()
  await mkdir(join(first.path, 'src', 'nested'), { recursive: true })
  await writeFile(join(first.path, 'src', 'nested', '한글.ts'), '중첩 변경 파일\n', 'utf8')
  await page.getByRole('button', { name: '변경 사항 새로고침' }).click()
  const folder = page.getByRole('treeitem', { name: 'src', exact: true })
  const nested = page.getByRole('treeitem', { name: 'src/nested/한글.ts', exact: true })
  await nested.waitFor()
  await folder.click()
  assert.equal(await folder.getAttribute('aria-expanded'), 'false')
  assert.equal(await nested.count(), 0)
  await page.getByRole('textbox', { name: '변경 파일 검색', exact: true }).fill('한글.ts')
  await nested.waitFor()
  await nested.click()
  await page.getByText('+중첩 변경 파일', { exact: false }).waitFor()
  await page.getByRole('textbox', { name: '변경 파일 검색', exact: true }).fill('없는 파일')
  await page.getByText('검색 결과가 없습니다.', { exact: true }).waitFor()
  await page.getByRole('textbox', { name: '변경 파일 검색', exact: true }).fill('')
  assert.equal(await folder.getAttribute('aria-expanded'), 'false')
  await folder.click()
  assert.equal(await nested.getAttribute('aria-selected'), 'true')
  await checkBackgroundRefresh(first)
  await page.screenshot({ path: 'artifacts/changes-diff.png' })
  await writeFile(join(second.path, 'dirty.txt'), '다른 Worktree 파일\n', 'utf8')
  await page.locator('.task-row').and(page.getByTitle(second.path, { exact: true })).click()
  await page.getByRole('button', { name: '변경 사항 새로고침' }).click()
  await page.getByRole('treeitem', { name: 'dirty.txt', exact: true }).click()
  await page.getByText('+다른 Worktree 파일', { exact: false }).waitFor()
  assert.equal(await page.getByRole('tab', { name: 'dirty.txt', exact: true }).count(), 1)
  await page.locator('.task-row').and(page.getByTitle(first.path, { exact: true })).click()
  await page.getByRole('tab', { name: 'dirty.txt', exact: true }).click()
  await page.getByText('+보호할 파일', { exact: false }).waitFor()
  await page.getByRole('button', { name: '변경 내용 닫기', exact: true }).click()
  await readyTerminal()
  assert.equal((await snapshot(first.id)).generation, shellGeneration)
  await page.getByLabel('한글.ts 탭 닫기', { exact: true }).click()
  await page.locator('.task-row').and(page.getByTitle(second.path, { exact: true })).click()
  await page.getByLabel('dirty.txt 탭 닫기', { exact: true }).click()
  await page.locator('.task-row').and(page.getByTitle(first.path, { exact: true })).click()
  await rm(join(second.path, 'dirty.txt'))
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
  await settings.getByRole('tab', { name: '일반', exact: true }).click()
  await checkSettingsUpdate(settings)
  const notificationToggle = settings.getByRole('checkbox', { name: '데스크톱 알림 사용', exact: true })
  await notificationToggle.uncheck()
  await settings.getByRole('combobox', { name: '알림음', exact: true }).selectOption('glass')
  await settings.getByRole('slider', { name: '알림음 볼륨', exact: true }).evaluate((input) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '35')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await settings.getByRole('button', { name: '미리듣기', exact: true }).click()
  await settings.getByRole('status').filter({ hasText: '선택한 알림음을' }).waitFor()
  const beforeCancel = await page.evaluate(() => window.desktop.getSettings())
  await settings.getByRole('button', { name: '음원 파일 선택', exact: true }).click()
  assert.deepEqual(await page.evaluate(() => window.desktop.getSettings()), beforeCancel)
  await settings.getByRole('button', { name: '알림 설정 저장', exact: true }).click()
  await settings.getByRole('status').filter({ hasText: '알림 설정을 저장' }).waitFor()
  await settings.getByRole('checkbox', { name: '데스크톱 알림 사용', exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: 'artifacts/notification-settings.png' })
  const notificationSettings = await page.evaluate(() => window.desktop.getSettings())
  assert.deepEqual(notificationSettings.notifications, { enabled: false, soundEnabled: true, sound: 'glass', volume: 35 })
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1)
  await settings
    .getByRole('tab', { name: '프로그램 정보', exact: true })
    .click()
  const info = await page.evaluate(() => window.desktop.getAppInfo())
  assert.equal(
    info.version,
    JSON.parse(await readFile('package.json', 'utf8')).version,
  )
  await settings.getByRole('button', { name: '닫기', exact: true }).click()
  await checkSettingsLayout()
  await taskAction(first, 'Codex 터미널')
  await waitOutput(first.id, 'fixture · resume')
  assert.deepEqual((await page.evaluate(() => window.desktop.getSettings())).notifications,
    { enabled: false, soundEnabled: true, sound: 'glass', volume: 35 })
  await command('/question')
  await waitOutput(first.id, 'QUESTION_WAITING')
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1)
  await app.close()
  app = await launch()
  page = await app.firstWindow()
  observeErrors(page)
  page.setDefaultTimeout(15000)
  await readyTerminal()
  await page.getByRole('tab', { name: '통합 작업', exact: true }).waitFor()
  await waitOutput(first.id, 'fixture · resume')
  assert.equal((await tasks()).length, 1)
  assert.deepEqual((await page.evaluate(() => window.desktop.getSettings())).notifications,
    { enabled: false, soundEnabled: true, sound: 'glass', volume: 35 })
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
  observeErrors(page)
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
  await checkStartupFlow()
  await checkPeriodicTabs()
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
  }
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
async function checkResetAnnouncements() {
  const now = Date.now()
  const news = page.getByLabel('초기화권 및 리셋 소식', { exact: true })
  const url = 'https://x.com/thsottiaux/status/12345'
  const banked = { id: 'banked', kind: 'banked', url, publishedAt: now - 86400000,
    text: 'Banked 2/2', scheduledAt: null, scheduledDay: null, deliveredAt: null }
  const plan = { ...banked, id: 'plan', kind: 'announced', publishedAt: now - 60000,
    scheduledAt: now + 3600000 }
  const state = { checkedAt: now, generatedAt: now, error: null, announcements: [plan, banked] }
  async function publish(next) {
    await app.evaluate(({ BrowserWindow }, state) => {
      BrowserWindow.getAllWindows()[0].webContents.send('codex:reset-announcements', state)
    }, next)
  }
  await app.evaluate(({ shell }) => {
    globalThis.originalResetOpen = shell.openExternal
    shell.openExternal = async (url) => { globalThis.resetOpenedUrl = url }
  })
  try {
    await publish(state)
    assert.equal(await news.getAttribute('open'), null)
    await news.locator('summary').filter({ hasText: '예고 1건' }).waitFor()
    await news.locator('summary').click()
    await news.getByRole('button', { name: '리셋 예고 원문 보기', exact: true }).waitFor()
    await news.getByRole('button', { name: '초기화권 지급 공지 원문 보기', exact: true }).click()
    assert.equal(await app.evaluate(() => globalThis.resetOpenedUrl), url)
    assert.equal(await news.getByText('예고 시각', { exact: false }).count(), 1)
    assert.equal(await news.getByText('공지는 계정별 지급·초기화를 보장하지 않습니다.').count(), 1)
    await page.screenshot({ path: 'artifacts/reset-announcements.png' })
    await publish({ ...state, announcements: [{ ...plan, kind: 'hinted', scheduledAt: null, scheduledDay: '2026-11-08' }, banked] })
    await news.getByText('예고 날짜 2026-11-08 · 시각·시간대 미제공 · 확정 예고 아님', { exact: true }).waitFor()
    await publish({ ...state, error: 'HTTP 503' })
    await news.getByText('공지 갱신 지연 · 예고 확인 불가').waitFor()
    assert.equal(await news.getByRole('button', { name: '리셋 예고 원문 보기', exact: true }).count(), 0)
    assert.equal(await news.getByRole('button', { name: '초기화권 지급 공지 원문 보기', exact: true }).count(), 1)
    await publish({ ...state, generatedAt: now - 3600000 })
    await news.getByText('공지 갱신 지연 · 예고 확인 불가').waitFor()
    await publish({ ...state, announcements: [banked] })
    await news.getByText('수집된 리셋 예고 없음', { exact: true }).waitFor()
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false)
  } finally {
    if (await news.getAttribute('open') !== null) await news.locator('summary').click()
    await app.evaluate(({ shell }) => {
      shell.openExternal = globalThis.originalResetOpen
      delete globalThis.originalResetOpen
      delete globalThis.resetOpenedUrl
    })
  }
}
async function windowWrite(id, data) {
  await page.evaluate(
    ({ id, data }) => window.desktop.writeTerminal(id, data),
    { id, data },
  )
}

async function checkStartupFlow() {
  const win = process.platform === 'win32'
  const successfulScript = win
    ? "Write-Output 'STARTUP_BEGIN'; Start-Sleep -Seconds 2; Set-Content -Encoding utf8 startup-ready.txt '설치 완료'; Write-Output 'STARTUP_DONE'"
    : "printf 'STARTUP_BEGIN\\n'; sleep 2; printf '설치 완료' > startup-ready.txt; printf 'STARTUP_DONE\\n'"
  const scriptPath = `scripts/startup.${win ? 'ps1' : 'sh'}`
  const setScript = async (script, auto = true, workspace = project) => {
    await mkdir(join(workspace, 'scripts'), { recursive: true })
    await writeFile(join(workspace, scriptPath), (win ? '\ufeff' : '') + script, 'utf8')
    if (workspace === project) {
      git('add', scriptPath)
      git('-c', 'user.name=UI Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Startup fixture')
    }
    await page.evaluate(async ({ project, scriptPath, auto }) => {
      const key = window.desktop.platform === 'win32' ? project.toLowerCase() : project
      const previous = (await window.desktop.getSettings()).projects[key]
      await window.desktop.updateProjectSettings(project, { ...previous, baseRef: 'refs/heads/main', startupScriptPath: scriptPath, startupAutoRun: auto })
    }, { project, scriptPath, auto })
  }
  const startup = (task) => page.evaluate((path) => window.desktop.startupSnapshot(path), task.path)
  const create = async (name) => {
    await openTaskCreation()
    const dialog = page.getByRole('dialog', { name: '새 작업', exact: true })
    await dialog.getByRole('textbox', { name: '새 작업 이름', exact: true }).fill(name)
    await dialog.getByRole('textbox', { name: '첫 요청', exact: true }).fill(`FIRST_PROMPT_${name}`)
    await dialog.getByRole('button', { name: '만들고 시작', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    await until(async () => (await tasks()).some((task) => task.name === name), '초기화 작업 생성')
    return (await tasks()).find((task) => task.name === name)
  }
  const assertBlocked = async (task) => {
    assert.equal(await snapshot(task.id), null)
    await assert.rejects(page.evaluate((task) => window.desktop.openTerminal({ taskId: task.id, workspace: task.path, kind: 'codex', cols: 80, rows: 24 }), task), /Startup/)
    await assert.rejects(page.evaluate((task) => window.desktop.sendMessage({ sessionId: task.id, workspace: task.path, text: 'blocked' }), task), /Startup/)
  }
  // 레포에 커밋된 파일 경로와 자동 실행 선택을 실제 설정 폼에서 확인합니다.
  await setScript(successfulScript)
  await page.getByRole('button', { name: '설정', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '설정', exact: true })
  await settings.getByRole('tab', { name: '프로젝트', exact: true }).click()
  await settings.getByRole('textbox', { name: 'Startup 스크립트 파일 경로', exact: true }).fill(scriptPath)
  await settings.getByRole('checkbox', { name: '새 Worktree Startup 자동 실행', exact: true }).check()
  await settings.getByRole('button', { name: '저장', exact: true }).click()
  await settings.getByText('프로젝트 기본값을 저장했습니다. 다음 새 작업부터 적용됩니다.', { exact: true }).waitFor()
  await settings.getByRole('button', { name: '닫기', exact: true }).click()
  const successful = await create('Startup 성공')
  assert.equal((await startup(successful)).status, 'running')
  await assertBlocked(successful)
  const original = (await tasks()).find((task) => task.name === '통합 작업')
  await page.locator('.task-row').and(page.getByTitle(original.path, { exact: true })).click()
  await until(async () => (await startup(successful))?.status === 'completed', 'Startup 성공')
  await waitOutput(successful.id, 'FIRST_PROMPT_Startup 성공')
  await page.locator('.task-row').and(page.getByTitle(successful.path, { exact: true })).click()
  await readyTerminal()
  await waitScreen('FIRST_PROMPT_Startup 성공')
  assert.equal(await page.locator('.startup-panel, .agent-heading, .terminal-toolbar').count(), 0)
  await page.screenshot({ path: 'artifacts/terminal-clean.png' })
  assert.ok((await readFile(join(successful.path, 'startup-ready.txt'), 'utf8')).includes('설치 완료'))
  // 실패한 초기화는 에이전트 호출 없이 로그와 재시도 경로를 제공합니다.
  await setScript(win ? "Write-Output 'STARTUP_FAILED'; exit 7" : "printf 'STARTUP_FAILED\\n'; exit 7")
  const failed = await create('Startup 실패')
  await until(async () => (await startup(failed))?.status === 'failed', 'Startup 실패')
  await assertBlocked(failed)
  await page.getByText(/초기화가 완료되지 않아 에이전트를 시작하지 않았습니다/).waitFor()
  await page.screenshot({ path: 'artifacts/startup-failed.png' })
  await app.close()
  app = await launch()
  page = await app.firstWindow()
  observeErrors(page)
  page.setDefaultTimeout(15000)
  await page.getByRole('tab', { name: 'Startup 실패', exact: true }).waitFor()
  await page.getByText(/초기화가 완료되지 않아 에이전트를 시작하지 않았습니다/).waitFor()
  assert.equal((await startup(failed)).status, 'stopped')
  await assertBlocked(failed)
  await setScript(win ? "Write-Output 'LATEST_SCRIPT_RECOVERED'" : "printf 'LATEST_SCRIPT_RECOVERED\\n'", true, failed.path)
  await page.getByRole('button', { name: 'Startup 실행', exact: true }).click()
  await readyTerminal()
  await waitOutput(failed.id, 'FIRST_PROMPT_Startup 실패')
  assert.equal(await page.locator('.startup-panel').count(), 0)
  assert.match((await startup(failed)).output, /LATEST_SCRIPT_RECOVERED/)
  // 자동 실행을 꺼 둔 프로젝트는 기존처럼 바로 에이전트를 시작합니다.
  await setScript(win ? 'Start-Sleep -Seconds 60' : 'sleep 60', false)
  const disabled = await create('Startup 자동 끔')
  await readyTerminal()
  assert.equal(await startup(disabled), null)
  await waitOutput(disabled.id, 'FIRST_PROMPT_Startup 자동 끔')
  await setScript(win ? "Write-Output 'LONG_STARTUP'; Start-Sleep -Seconds 60" : "printf 'LONG_STARTUP\\n'; sleep 60")
  const stopped = await create('Startup 중지')
  await page.getByRole('button', { name: 'Startup 중지', exact: true }).click()
  await until(async () => (await startup(stopped))?.status === 'stopped', 'Startup 중지')
  await assertBlocked(stopped)
  await page.screenshot({ path: 'artifacts/startup-stopped.png' })
  // Superset 경로 변수는 자동 실행과 IPC를 통한 수동 재실행 모두에서 전달합니다.
  const supersetPath = './.superset/setup.sh'
  await mkdir(join(project, '.superset'), { recursive: true })
  await writeFile(join(project, 'superset-source.txt'), 'Superset 원본 파일', 'utf8')
  await writeFile(join(project, supersetPath), [
    '#!/usr/bin/env sh', 'set -eu',
    'cp "$SUPERSET_ROOT_PATH/superset-source.txt" "$SUPERSET_WORKSPACE_PATH/superset-ready.txt"',
    'echo SUPERSET_DONE', '',
  ].join(win ? '\r\n' : '\n'), 'utf8')
  git('add', '.superset/setup.sh')
  git('-c', 'user.name=UI Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Superset fixture')
  await page.evaluate(async ({ project, supersetPath }) => {
    const key = window.desktop.platform === 'win32' ? project.toLowerCase() : project
    const previous = (await window.desktop.getSettings()).projects[key]
    await window.desktop.updateProjectSettings(project, { ...previous, startupScriptPath: supersetPath })
  }, { project, supersetPath })
  const superset = await create('Superset 초기화')
  await until(async () => (await startup(superset))?.status === 'completed', 'Superset .sh 자동 실행')
  await waitOutput(superset.id, 'FIRST_PROMPT_Superset 초기화')
  assert.equal(await readFile(join(superset.path, 'superset-ready.txt'), 'utf8'), 'Superset 원본 파일')
  await writeFile(join(project, 'superset-source.txt'), '수동 재실행 원본 파일', 'utf8')
  await page.evaluate(({ project, path }) => window.desktop.runStartup(project, path), { project, path: superset.path })
  await until(async () => (await startup(superset))?.status === 'completed', 'Superset .sh 수동 실행')
  assert.equal(await readFile(join(superset.path, 'superset-ready.txt'), 'utf8'), '수동 재실행 원본 파일')
  console.log('Startup UI 검증 통과: 생성→초기화→성공 후 Codex 호출, 백그라운드 완료, 실패·중지 IPC 차단, 앱 복원 후 차단 유지, 최신 스크립트 재시도, 자동 실행 끔, Superset .sh 자동·수동 실행.')
}

async function checkBackgroundRefresh(task) {
  const generation = (await snapshot(task.id)).generation
  await app.evaluate(({ ipcMain }) => {
    globalThis.refreshHandlers = new Map()
    globalThis.refreshRequests = 0
    globalThis.refreshResizeCalls = 0
    for (const channel of ['repository:inspect', 'repository:diff', 'terminal:resize']) {
      const original = ipcMain._invokeHandlers.get(channel)
      globalThis.refreshHandlers.set(channel, original)
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (event, ...args) => {
        if (channel === 'terminal:resize') globalThis.refreshResizeCalls++
        else {
          globalThis.refreshRequests++
          await new Promise((resolve) => setTimeout(resolve, 600))
        }
        return original(event, ...args)
      })
    }
  })
  try {
    await page.evaluate(() => {
      const nodes = [document.querySelector('.file-tree'), document.querySelector('.main-diff pre'), document.querySelector('[role="tab"][aria-selected="true"]')]
      globalThis.flickerState = { nodes, removals: 0, text: nodes[1].innerText }
      globalThis.flickerObserver = new MutationObserver((records) => {
        for (const record of records) for (const removed of record.removedNodes)
          if (nodes.some((node) => removed === node || removed.contains(node))) globalThis.flickerState.removals++
      })
      globalThis.flickerObserver.observe(document.querySelector('.workspace-layout'), { childList: true, subtree: true })
    })
    await page.getByRole('button', { name: '변경 사항 새로고침' }).click()
    await until(() => app.evaluate(() => globalThis.refreshRequests >= 2), '배경 갱신 요청')
    assert.equal(await page.evaluate(() => globalThis.flickerState.nodes.every((node) => node.isConnected)), true)
    assert.equal(await page.locator('.main-diff pre').innerText(), await page.evaluate(() => globalThis.flickerState.text))
    await new Promise((resolve) => setTimeout(resolve, 850))
    assert.equal(await page.evaluate(() => globalThis.flickerState.removals), 0)
    assert.equal(await app.evaluate(() => globalThis.refreshResizeCalls), 0)
    assert.equal((await snapshot(task.id)).generation, generation)
    console.log('깜빡임 회귀 검증 통과: 지연된 배경 갱신 중 트리·diff·선택 탭 DOM 유지, 기존 내용 유지, PTY 재생성·불필요 resize 없음.')
  } finally {
    await page.evaluate(() => { globalThis.flickerObserver.disconnect(); delete globalThis.flickerObserver; delete globalThis.flickerState })
    await app.evaluate(({ ipcMain }) => {
      for (const [channel, original] of globalThis.refreshHandlers) { ipcMain.removeHandler(channel); ipcMain.handle(channel, original) }
      delete globalThis.refreshHandlers
    })
  }
}

async function checkCompactProcessLayout(task) {
  assert.equal(await page.locator('.startup-panel').count(), 0)
  assert.equal(await page.locator('.agent-heading, .terminal-toolbar').count(), 0)
  assert.equal(await page.locator('.process-panel').count(), 1)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 600))
  try {
    const usage = page.getByRole('region', { name: 'Codex 사용량 한도', exact: true })
    const details = usage.getByRole('button', { name: '사용량 상세 정보', exact: true })
    await usage.getByRole('progressbar', { name: '5시간 남은 사용량', exact: true }).waitFor()
    assert.equal(await details.getAttribute('aria-expanded'), 'false')
    assert.equal(await usage.locator('.usage-reset').count(), 0)
    await usage.getByText('남은 초기화권', { exact: true }).waitFor()
    const nearestExpiry = await page.evaluate(async () => {
      const result = await window.desktop.codexUsage()
      const nearest = result.rateLimitResetCredits.credits.find((credit) => credit.id === 'nearest')
      const date = new Date(nearest.expiresAt * 1000)
      return {
        compact: `${date.getMonth() + 1}/${date.getDate()} 만료`,
        full: date.toLocaleString('ko-KR', {
          month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
        }),
      }
    })
    const creditsRow = usage.locator('.usage-credits .usage-row')
    const expiry = creditsRow.locator('strong span')
    assert.equal(await creditsRow.locator('strong').innerText(), `3개 · ${nearestExpiry.compact}`)
    assert.equal(await expiry.getAttribute('title'), `먼저 만료되는 초기화권 · ${nearestExpiry.full} 만료`)
    assert.equal(await creditsRow.evaluate((row) => {
      const label = row.querySelector('span').getBoundingClientRect()
      const value = row.querySelector('strong').getBoundingClientRect()
      return Math.abs(label.y - value.y) < 2 && value.height < 20 && row.scrollWidth <= row.clientWidth
    }), true, '초기화권 개수와 가장 가까운 만료일을 한 줄에 표시합니다.')
    const compactHeight = (await usage.boundingBox()).height
    assert.ok(compactHeight <= 190, `접힌 사용량 영역이 너무 큽니다: ${compactHeight}px`)
    await details.click()
    assert.equal(await details.getAttribute('aria-expanded'), 'true')
    await usage.getByText('가장 가까운 사용 기간', { exact: true }).scrollIntoViewIfNeeded()
    assert.equal(await usage.locator('.usage-reset').count(), 3)
    assert.ok((await usage.boundingBox()).height > compactHeight + 50)
    assert.equal(await page.getByRole('button', { name: '설정', exact: true }).isVisible(), true)
    await details.click()
    assert.equal(await usage.locator('.usage-reset').count(), 0)
    assert.equal(await expiry.innerText(), nearestExpiry.compact)
    assert.equal(await expiry.isVisible(), true)
    const density = await page.evaluate(() => {
      const list = document.querySelector('.project-list').getBoundingClientRect()
      const heading = document.querySelector('.changes-heading').getBoundingClientRect()
      const tabs = document.querySelector('.agent-tabs-bar').getBoundingClientRect()
      return { listHeight: list.height, headingHeight: heading.height, tabsHeight: tabs.height,
        overflow: document.documentElement.scrollWidth > innerWidth }
    })
    assert.ok(density.listHeight >= 275, JSON.stringify(density))
    assert.equal(density.headingHeight, density.tabsHeight)
    assert.equal(density.overflow, false)
    await until(async () => page.evaluate(() => {
      const host = document.querySelector('.task-terminal-slot:not([hidden]) .terminal-host')
      const screen = host?.querySelector('.xterm-screen')
      return !!screen && screen.getBoundingClientRect().bottom <= host.getBoundingClientRect().bottom + 1
    }), '작은 창 터미널 행 맞춤')
    const layout = await page.evaluate(() => {
      const host = document.querySelector('.task-terminal-slot:not([hidden]) .terminal-host')
      const screen = host.querySelector('.xterm-screen')
      const process = document.querySelector('.process-panel')
      const rect = (element) => { const value = element.getBoundingClientRect(); return { top: value.top, bottom: value.bottom, height: value.height } }
      return { host: rect(host), screen: rect(screen), process: rect(process), viewport: innerHeight, footer: !!document.querySelector('.terminal-footer') }
    })
    assert.ok(layout.host.height >= 170, JSON.stringify(layout))
    assert.ok(layout.screen.bottom <= layout.process.top + 1, JSON.stringify(layout))
    assert.ok(layout.process.bottom <= layout.viewport + 1, JSON.stringify(layout))
    assert.ok(layout.process.height <= 181, JSON.stringify(layout))
    assert.equal(layout.footer, false)
    await command('COMPACT_PROCESS_INPUT_OK')
    await waitOutput(task.id, 'COMPACT_PROCESS_INPUT_OK')
    await waitScreen('COMPACT_PROCESS_INPUT_OK')
    await page.screenshot({ path: 'artifacts/process-panel-compact.png' })
    if (process.argv.includes('--compact-only')) {
      for (const theme of ['light', 'dark']) {
        const nextThemeButton = theme === 'light' ? '라이트 테마' : '다크 테마'
        await page.getByRole('button', { name: nextThemeButton, exact: true }).click()
        await until(async () => page.evaluate((theme) => {
          const viewport = document.querySelector('.task-terminal-slot:not([hidden]) .xterm-viewport')
          return getComputedStyle(viewport).backgroundColor === (theme === 'dark' ? 'rgb(24, 24, 27)' : 'rgb(255, 255, 255)')
        }, theme), `${theme} 터미널 viewport 배경`)
        console.log('TERMINAL VIEWPORT', theme, await page.locator('.task-terminal-slot:not([hidden]) .xterm-viewport').evaluate((element) => getComputedStyle(element).backgroundColor))
        await page.screenshot({ path: `artifacts/process-panel-compact-${theme}.png` })
      }
    }
  } catch (cause) {
    console.error('COMPACT METRICS', await page.evaluate(() => Object.fromEntries(['.agent-task-content', '.task-terminal-slot:not([hidden])', '.task-terminal-slot:not([hidden]) .task-terminal', '.task-terminal-slot:not([hidden]) .terminal-host', '.task-terminal-slot:not([hidden]) .xterm', '.task-terminal-slot:not([hidden]) .xterm-screen', '.process-panel'].map((selector) => {
      const element = document.querySelector(selector)
      const rect = element?.getBoundingClientRect()
      const style = element && getComputedStyle(element)
      return [selector, rect && { top: rect.top, bottom: rect.bottom, height: rect.height, cssHeight: style.height, minHeight: style.minHeight, padding: style.padding, flex: style.flex }]
    }))))
    await page.screenshot({ path: 'artifacts/process-panel-compact-failure.png' })
    throw cause
  } finally {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1320, 850))
  }
}

async function checkPeriodicTabs() {
  const task = (await tasks())[0]
  await page.locator('.task-row').and(page.getByTitle(task.path, { exact: true })).click()
  await app.close()
  app = await launch({ LITE_IDE_FIXTURE_TAB_POLLING: '1' })
  page = await app.firstWindow()
  observeErrors(page)
  page.setDefaultTimeout(15000)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 600))
  await readyTerminal()
  const childTab = page.getByRole('tab', { name: '서브 · 완료한 현재 검증 담당', exact: true })
  await childTab.waitFor()
  await childTab.click()
  await until(async () => childTab.locator('.tab-running-dot.inactive').count(), '완료한 자식 탭 초기 관찰')
  await app.evaluate(({ ipcMain }) => {
    globalThis.periodicSessionsHandler = ipcMain._invokeHandlers.get('codex:sessions')
    globalThis.periodicSessionCalls = 0
    ipcMain.removeHandler('codex:sessions')
    ipcMain.handle('codex:sessions', async (event, ...args) => {
      const result = await globalThis.periodicSessionsHandler(event, ...args)
      if (args[0]) globalThis.periodicSessionCalls++
      return result
    })
  })
  try {
    await page.evaluate(async () => {
      globalThis.originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden')
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const list = document.querySelector('[role="tablist"][aria-label="작업 탭"]')
      list.style.maxWidth = '280px'
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const read = () => ({
        scrollLeft: list.scrollLeft, width: list.clientWidth, height: list.clientHeight, scrollWidth: list.scrollWidth,
        tabs: [...list.querySelectorAll('[role="tab"]')].map((tab) => {
          const rect = tab.getBoundingClientRect()
          return { id: tab.id, label: tab.getAttribute('aria-label'), title: tab.title, selected: tab.getAttribute('aria-selected'), active: getComputedStyle(tab.querySelector('.tab-running-dot')).visibility === 'visible', x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        }),
      })
      globalThis.readPeriodicTabs = read
      globalThis.periodicTabBaseline = read()
      globalThis.periodicTabNodes = [...list.querySelectorAll('[role="tab"]')]
      globalThis.periodicTabSamples = [read()]
      globalThis.periodicTabTimer = setInterval(() => globalThis.periodicTabSamples.push(read()), 50)
      globalThis.periodicTabObserver = new MutationObserver(() => globalThis.periodicTabSamples.push(read()))
      globalThis.periodicTabObserver.observe(list, { attributes: true, childList: true, subtree: true, characterData: true })
    })
    await until(() => app.evaluate(() => globalThis.periodicSessionCalls >= 2), '실제 4초 세션 주기 조회 2회')
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const measured = await page.evaluate(() => {
      clearInterval(globalThis.periodicTabTimer)
      globalThis.periodicTabObserver.disconnect()
      return { baseline: globalThis.periodicTabBaseline, samples: globalThis.periodicTabSamples, sameNodes: globalThis.periodicTabNodes.every((node) => node.isConnected) }
    })
    assert.equal(measured.sameNodes, true)
    assert.ok(measured.baseline.scrollWidth > measured.baseline.width, '가로 스크롤이 있는 좁은 탭에서 검증합니다.')
    for (const sample of measured.samples) assert.deepEqual(sample, measured.baseline, '주기 조회가 탭 이름·상태·크기·선택·스크롤을 바꾸지 않아야 합니다.')
    // 정상적인 새 실행과 완료도 상태 표시만 바꾸고 다른 탭을 밀지 않습니다.
    const child = await page.evaluate(async (path) => (await window.desktop.listSessions(path)).find((session) => session.threadId === 'polling-child'), task.path)
    const geometry = (value) => ({ ...value, tabs: value.tabs.map(({ active, ...tab }) => tab) })
    for (const status of ['running', 'completed']) {
      await app.evaluate(({ BrowserWindow }, session) => BrowserWindow.getAllWindows()[0].webContents.send('codex:session', session), { ...child, status, updatedAt: Date.now() })
      await until(async () => childTab.locator(status === 'running' ? '.tab-running-dot:not(.inactive)' : '.tab-running-dot.inactive').count(), `정상 상태 ${status} 표시`)
      assert.deepEqual(geometry(await page.evaluate(() => globalThis.readPeriodicTabs())), geometry(measured.baseline))
    }
    await page.screenshot({ path: 'artifacts/periodic-tabs-stable.png' })
    console.log('주기적 탭 회귀 통과: 실제 4초 polling 2회에서 이름·상태·DOM·위치·너비·선택·스크롤 고정, 정상 상태 변경 시에도 탭 폭 유지.')
  } finally {
    await page.evaluate(() => {
      clearInterval(globalThis.periodicTabTimer)
      globalThis.periodicTabObserver?.disconnect()
      if (globalThis.originalHidden) Object.defineProperty(document, 'hidden', globalThis.originalHidden)
      else delete document.hidden
    })
    await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('codex:sessions'); ipcMain.handle('codex:sessions', globalThis.periodicSessionsHandler); delete globalThis.periodicSessionsHandler })
  }
}

async function checkRemoteCursor() {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false))
  const host = page.locator('.task-terminal-slot:not([hidden]) .terminal-host')
  for (const [commandText, style] of [['/cursor-block', 'block'], ['/cursor-underline', 'underline'], ['/cursor-bar', 'bar'], ['/cursor-enable', 'bar'], ['/cursor-fragment', 'bar']]) {
    await command(commandText)
    await waitScreen(`CURSOR_DONE:${commandText}`)
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await until(async () => host.locator(`.xterm-cursor-${style}`).count(), `원격 커서 ${style}`)
    assert.equal(await host.locator('.xterm-cursor-blink').count(), 0)
  }
  await command('/cursor-position')
  await waitScreen('CURSOR_DONE:/cursor-position')
  await until(async () => host.evaluate((element) => {
    const cursor = element.querySelector('.xterm-cursor')
    const row = element.querySelector('.xterm-rows')?.children[1]
    return !!cursor && !!row && Math.abs(cursor.getBoundingClientRect().top - row.getBoundingClientRect().top) < 1
  }), '원격 커서 위치 보존')
  await command('/cursor-restore')
  await waitScreen('CURSOR_DONE:/cursor-restore')
  await command('/cursor-hide')
  await waitScreen('CURSOR_DONE:/cursor-hide')
  await until(async () => await host.locator('.xterm-cursor').count() === 0, 'CLI 커서 숨김')
  await command('/cursor-show')
  await waitScreen('CURSOR_DONE:/cursor-show')
  await until(async () => await host.locator('.xterm-cursor').count() === 1, 'CLI 커서 표시')
  assert.equal(await host.locator('.xterm-cursor-blink').count(), 0)
  for (const [runIndex, mode] of ['focused', 'blurred', 'composition'].entries()) {
    await host.evaluate((element) => {
      globalThis.cursorFrames = []
      const sample = () => {
        globalThis.cursorFrames.push(!!element.querySelector('.xterm-cursor'))
      }
      globalThis.cursorObserver = new MutationObserver(sample)
      globalThis.cursorObserver.observe(element.querySelector('.xterm-rows'), { childList: true, subtree: true, attributes: true })
    })
    try {
      await command('/cursor-redraw')
      if (mode === 'blurred') await host.locator('textarea').evaluate((element) => element.blur())
      if (mode === 'composition') {
        await host.locator('textarea').evaluate((element) => {
          element.value = ''
          element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }))
          element.value = '한'
          element.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: '한' }))
        })
        const appearance = await host.evaluate((element) => {
          const composition = element.querySelector('.composition-view')
          return {
            active: composition.classList.contains('active'),
            text: composition.textContent,
            background: getComputedStyle(composition).backgroundColor,
            terminalBackground: getComputedStyle(element.querySelector('.xterm-viewport')).backgroundColor,
            color: getComputedStyle(composition).color,
            terminalColor: getComputedStyle(element.querySelector('.xterm-rows')).color,
            caret: getComputedStyle(element.querySelector('textarea')).caretColor,
          }
        })
        assert.equal(appearance.active, true)
        assert.equal(appearance.text, '한')
        assert.equal(appearance.background, appearance.terminalBackground)
        assert.equal(appearance.color, appearance.terminalColor)
        assert.equal(appearance.caret, 'rgba(0, 0, 0, 0)')
      }
      await waitScreen('CURSOR_DONE:/cursor-redraw')
      // 이전 실행의 완료 표시로 조기 종료하지 않고 이번 다시 그리기까지 측정합니다.
      await until(async () => (await terminalText()).split('CURSOR_DONE:/cursor-redraw').length - 1 >= runIndex + 1, '분할된 커서 다시 그리기')
      const frames = await page.evaluate(() => globalThis.cursorFrames)
      assert.ok(frames.length > 0, '커서 렌더링을 측정해야 합니다.')
      assert.equal(frames.filter((visible) => !visible).length, 0, `분할된 숨김/표시 중 커서가 사라집니다 (${mode}).`)
    } finally {
      await page.evaluate(() => globalThis.cursorObserver.disconnect())
      if (mode === 'composition') {
        await host.locator('textarea').evaluate((element) => element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '한' })))
        await page.keyboard.press('Control+c')
      }
    }
  }
  console.log('커서 회귀 통과: blink 요청·분할된 다시 그리기를 포커스/비포커스/한글 조합 중 검증, 조합 색상 일치, 위치 이동·실제 숨김·표시 보존.')
}

async function setupFocusedTerminal() {
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, project)
  await page.evaluate(() => window.desktop.openProject())
  await page.reload()
  await page.locator('.project-name').filter({ hasText: '한글 project' }).waitFor()
  await createDraftTask()
  return (await tasks())[0]
}

async function checkMiddleInsertion(task) {
  await app.evaluate(({ ipcMain }) => {
    globalThis.middleInputHandler = ipcMain._invokeHandlers.get('terminal:write')
    globalThis.middleInputWrites = []
    ipcMain.removeHandler('terminal:write')
    ipcMain.handle('terminal:write', (_event, id, data) => globalThis.middleInputWrites.push({ id, data }))
  })
  try {
    for (const [keys, movement, modifiers] of [
      [['ArrowLeft', 'ArrowLeft'], '\x1b[D\x1b[D', {}],
      [['Home'], '\x1b[H', { shiftKey: true }],
      [['ArrowLeft', 'ArrowLeft', 'ArrowRight'], '\x1b[D\x1b[D\x1b[C', { ctrlKey: true }],
    ]) {
      await app.evaluate(() => { globalThis.middleInputWrites = [] })
      const input = page.locator('[aria-label="작업 터미널 입력"]:visible')
      await input.evaluate((element) => { element.value = ''; element.setSelectionRange(0, 0) })
      await input.focus()
      await page.keyboard.type('abcd')
      for (const key of keys) await page.keyboard.press(key)
      await page.keyboard.type('X')
      const caret = await input.evaluate((element) => ({ length: element.value.length, position: element.selectionStart }))
      assert.equal(caret.position, caret.length, '숨겨진 textarea caret는 끝을 유지하고 실제 이동은 PTY에만 전달합니다.')
      await input.evaluate(async (element, modifiers) => {
        element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }))
        element.setRangeText('한글', element.selectionStart, element.selectionEnd, 'end')
        element.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: '한글' }))
        await new Promise((resolve) => setTimeout(resolve, 0))
        element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '한글' }))
        element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13, ...modifiers }))
        element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13, ...modifiers }))
        await new Promise((resolve) => setTimeout(resolve, 30))
      }, modifiers)
      const enter = modifiers.shiftKey || modifiers.ctrlKey
        ? process.platform === 'win32'
          ? `\x1b[13;28;13;1;${modifiers.shiftKey ? 16 : 8};1_\x1b[13;28;13;0;${modifiers.shiftKey ? 16 : 8};1_`
          : `\x1b[13;${modifiers.shiftKey ? 2 : 5}u`
        : '\r'
      const writes = await app.evaluate(() => globalThis.middleInputWrites)
      assert.ok(writes.every((entry) => entry.id === task.id))
      assert.equal(writes.map((entry) => entry.data).join(''), `abcd${movement}X한글${enter}`)
    }
    console.log('중간 입력 회귀 통과: Left/Home/Right는 PTY로 유지, ASCII·한글 삽입 후 Enter/Shift+Enter/Ctrl+Enter 손실·중복 없음.')
  } finally {
    await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('terminal:write'); ipcMain.handle('terminal:write', globalThis.middleInputHandler); delete globalThis.middleInputHandler })
  }
}

async function checkSettingsLayout() {
  const previousTheme = await page.evaluate(() => document.documentElement.classList.contains('dark') ? 'dark' : 'light')
  await page.getByRole('button', { name: '설정', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '설정', exact: true })
  try {
    await settings.getByRole('combobox', { name: '알림음', exact: true }).waitFor()
    for (const [width, height] of [[960, 600], [1320, 850]]) {
      await app.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows()[0].setSize(width, height), [width, height])
      for (const theme of ['light', 'dark']) {
        await settings.getByRole('tab', { name: '일반', exact: true }).click()
        await settings.getByRole('combobox', { name: '설정 테마', exact: true }).selectOption(theme)
        for (const [tab, name] of [['general', '일반'], ['project', '프로젝트'], ['about', '프로그램 정보']]) {
          await settings.getByRole('tab', { name, exact: true }).click()
          const layout = await settings.evaluate((dialog) => {
            const content = dialog.querySelector('.settings-content')
            const rect = dialog.getBoundingClientRect()
            return { top: rect.top, bottom: rect.bottom, viewport: innerHeight,
              overflowX: content.scrollWidth > content.clientWidth + 1,
              overflowY: content.scrollHeight > content.clientHeight + 1 }
          })
          assert.ok(layout.top >= 0 && layout.bottom <= layout.viewport, JSON.stringify(layout))
          assert.equal(layout.overflowX, false, `${tab} ${width}px 가로 넘침`)
          if (tab !== 'project') assert.equal(layout.overflowY, false, `${tab} ${width}px 불필요한 세로 스크롤`)
          if (tab === 'project') {
            const help = settings.locator('.settings-help')
            await help.locator('summary').click()
            await settings.locator('.settings-content').evaluate((content) => { content.scrollTop = content.scrollHeight })
            const footer = await settings.locator('.settings-footer').boundingBox()
            const save = await settings.getByRole('button', { name: '저장', exact: true }).boundingBox()
            assert.ok(save.y >= footer.y && save.y + save.height <= footer.y + footer.height)
            await help.locator('summary').click()
            await settings.locator('.settings-content').evaluate((content) => { content.scrollTop = 0 })
          }
          await page.screenshot({ path: `artifacts/settings-${tab}-${theme}-${width}.png` })
        }
      }
    }
    await settings.getByRole('tab', { name: '프로젝트', exact: true }).click()
    const save = settings.getByRole('button', { name: '저장', exact: true })
    await until(() => save.isEnabled(), '설정 저장 준비')
    await save.click()
    await settings.getByRole('status').filter({ hasText: '프로젝트 기본값을 저장했습니다.' }).waitFor()
    await settings.getByRole('tab', { name: '일반', exact: true }).click()
    await settings.getByRole('combobox', { name: '설정 테마', exact: true }).selectOption(previousTheme)
    console.log('설정 레이아웃 검증 통과: 960×600·1320×850, 라이트·다크, 일반·프로젝트·프로그램 정보, 고정 저장 버튼과 실제 저장.')
  } finally {
    await settings.getByRole('button', { name: '닫기', exact: true }).click()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1320, 850))
  }
}

async function checkSettingsUpdate(settings) {
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    const channels = ['app:update-check', 'app:update-start', 'app:update-download', 'app:update-install']
    globalThis.updateOriginalHandlers = channels.map(channel => [channel, ipcMain._invokeHandlers.get(channel)])
    globalThis.updateCalls = []
    globalThis.updateTestVersion = true
    const publish = (status) => {
      const state = { status, currentVersion: '0.1.0', canInstall: false,
        ...(status === 'current' ? {} : { version: '0.2.0' }) }
      BrowserWindow.getAllWindows()[0].webContents.send('app:update', state)
      return state
    }
    for (const channel of channels) {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async () => {
        globalThis.updateCalls.push(channel)
        if (channel === 'app:update-check') return publish(globalThis.updateTestVersion ? 'available' : 'current')
        if (channel === 'app:update-start') {
          publish('downloading')
          await new Promise(resolve => setTimeout(resolve, 200))
          return publish('downloaded')
        }
        throw new Error('개별 다운로드·설치 API를 호출하면 안 됩니다.')
      })
    }
  })
  try {
    await settings.getByRole('button', { name: '업데이트 확인 및 설치', exact: true }).click()
    await settings.getByText('다운로드와 무결성 검증이 완료되었습니다.', { exact: true }).waitFor()
    assert.deepEqual(await app.evaluate(() => globalThis.updateCalls), ['app:update-check', 'app:update-start'])
    assert.equal(await settings.getByRole('button', { name: '업데이트', exact: true }).isDisabled(), true)
    assert.equal(await settings.getByRole('button', { name: '종료하고 설치', exact: true }).count(), 0)
    // 최신 버전이면 확인만 하고 다운로드·설치 요청을 보내지 않습니다.
    await app.evaluate(({ BrowserWindow }) => {
      globalThis.updateCalls = []
      globalThis.updateTestVersion = false
      BrowserWindow.getAllWindows()[0].webContents.send('app:update', { status: 'idle', currentVersion: '0.1.0', canInstall: false })
    })
    await settings.getByRole('button', { name: '업데이트 확인 및 설치', exact: true }).click()
    await settings.getByText('사용 가능한 새 업데이트가 없습니다.', { exact: true }).waitFor()
    assert.deepEqual(await app.evaluate(() => globalThis.updateCalls), ['app:update-check'])
    console.log('설정 업데이트 검증 통과: 한 번 클릭으로 확인→통합 업데이트 호출, 개발 실행 설치 차단, 최신 버전은 설치하지 않음.')
  } finally {
    await app.evaluate(({ ipcMain, BrowserWindow }) => {
      for (const [channel, handler] of globalThis.updateOriginalHandlers) {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, handler)
      }
      BrowserWindow.getAllWindows()[0].webContents.send('app:update', { status: 'idle', currentVersion: '0.1.0', canInstall: false })
      delete globalThis.updateOriginalHandlers
      delete globalThis.updateCalls
      delete globalThis.updateTestVersion
    })
  }
}


async function checkRepositoryFailure(first, second) {
  const name = 'only-first-regression.txt'
  await writeFile(join(first.path, name), 'first only', 'utf8')
  await page.getByRole('button', { name: '변경 사항 새로고침' }).click()
  await page.getByRole('treeitem', { name, exact: true }).waitFor()
  await app.evaluate(({ ipcMain }, target) => {
    const original = ipcMain._invokeHandlers.get('repository:inspect')
    globalThis.repositoryFailureHandler = original
    ipcMain.removeHandler('repository:inspect')
    ipcMain.handle('repository:inspect', (event, path) => {
      if (path === target) throw new Error('REPOSITORY_FAILURE_REGRESSION')
      return original(event, path)
    })
  }, second.path)
  try {
    await page.locator('.task-row').and(page.getByTitle(second.path, { exact: true })).click()
    await page.getByText(/REPOSITORY_FAILURE_REGRESSION/).waitFor()
    assert.equal(await page.getByRole('treeitem', { name, exact: true }).count(), 0)
  } finally {
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('repository:inspect')
      ipcMain.handle('repository:inspect', globalThis.repositoryFailureHandler)
      delete globalThis.repositoryFailureHandler
    })
    await rm(join(first.path, name))
    await page.locator('.task-row').and(page.getByTitle(first.path, { exact: true })).click()
    await readyTerminal()
  }
}

async function checkQuestionDraft(first, second) {
  await app.evaluate(({ BrowserWindow }, workspace) => {
    BrowserWindow.getAllWindows()[0].webContents.send('codex:session', {
      id: 'ui-session', workspace, title: '관찰 세션', status: 'waiting',
      messages: [{ id: 'message', kind: 'assistant', text: '실제 세션 본문 표시' }],
      requests: [{ id: 'draft-question', kind: 'questions', title: '답변 초안 검증',
        questions: [{ id: 'q', question: '초안 보존 질문' }] }], updatedAt: Date.now(), canAcceptDirectInput: false,
    })
  }, first.path)
  const tabs = page.getByRole('tablist', { name: '작업 탭' })
  await tabs.getByRole('tab', { name: /관찰 세션/ }).click()
  await page.getByLabel('초안 보존 질문').fill('탭을 이동해도 유지할 답변')
  await tabs.getByRole('tab', { name: new RegExp(first.name) }).click()
  await tabs.getByRole('tab', { name: /관찰 세션/ }).click()
  assert.equal(await page.getByLabel('초안 보존 질문').inputValue(), '탭을 이동해도 유지할 답변')
  await page.locator('.task-row').and(page.getByTitle(second.path, { exact: true })).click()
  await page.locator('.task-row').and(page.getByTitle(first.path, { exact: true })).click()
  await tabs.getByRole('tab', { name: /관찰 세션/ }).click()
  assert.equal(await page.getByLabel('초안 보존 질문').inputValue(), '탭을 이동해도 유지할 답변')
  await tabs.getByRole('tab', { name: new RegExp(first.name) }).click()
}
