import {
  app,
  clipboard,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  net,
  shell,
} from 'electron'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import {
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import {
  createWorktree,
  inspectRepository,
  readDiff,
  removeWorktree,
  pathKey,
  listBranches,
  resolveBaseRef,
  requireLinkedWorktree,
  inspectWorktreeDeletion,
  resolveWorktreePath,
} from './git'
import { SettingsService, validateDefaults } from './settings-service'
import { appInfo } from './app-info'
import { AgentService } from './agent-service'
import { TerminalService } from './terminal-service'
import { cloneRepository, validateCloneInput } from './clone'
import { UpdateService } from './update-service'
import { installAfterExit, takeInstallError } from './update-installer'
import type {
  RequestAnswer,
  SendMessage,
  ProjectDefaults,
  TerminalOpen,
  DeleteTaskOptions,
} from '../shared/types'

const projects = new Set<string>()
const workspaces = new Set<string>()
const deletedWorkspaces = new Set<string>()
const cloneDirectories = new Set<string>()
let cloning = false
let window: BrowserWindow | null = null
let agents: AgentService | undefined
let terminals: TerminalService | undefined
let updates: UpdateService | undefined
let windowTheme: 'light' | 'dark' = 'dark'
const titleBarHeight = 43
const iconDirectory = app.isPackaged
  ? join(app.getAppPath(), 'resources')
  : join(__dirname, '../../resources')

function titleBarColors(theme: 'light' | 'dark') {
  return theme === 'dark'
    ? { color: '#141416', symbolColor: '#e4e4e7' }
    : { color: '#f4f4f5', symbolColor: '#27272a' }
}

function requireWorkspace(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !workspaces.has(resolve(value)) ||
    deletedWorkspaces.has(pathKey(value))
  ) {
    throw new Error('작업 경로를 사용할 수 없습니다. 프로젝트를 열거나 작업 삭제에서 로컬 기록을 정리해 주세요.')
  }
  return resolve(value)
}

app.setName('Lite IDE')
app.setPath('userData', join(app.getPath('appData'), 'lite-ide'))
if (process.env.LITE_IDE_HEADLESS === '1' && process.env.LITE_IDE_TEST_DATA)
  app.setPath('userData', process.env.LITE_IDE_TEST_DATA)

app.whenReady().then(() => {
  const settings = new SettingsService(
    join(app.getPath('userData'), 'settings.json'),
  )
  ipcMain.handle('settings:get', () => settings.get())
  ipcMain.handle('app:info', () => appInfo(app.isPackaged, app.getVersion()))
  ipcMain.handle('app:info-copy', () => {
    clipboard.writeText(
      JSON.stringify(appInfo(app.isPackaged, app.getVersion()), null, 2),
    )
  })
  if (process.platform === 'darwin')
    app.dock?.setIcon(join(iconDirectory, 'icon.png'))
  nativeTheme.themeSource = windowTheme
  ipcMain.handle('window:theme', (event, theme: unknown) => {
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== event.sender.mainFrame
    )
      throw new Error('현재 앱 창에서만 테마를 변경할 수 있습니다.')
    if (theme !== 'light' && theme !== 'dark')
      throw new Error('잘못된 창 테마입니다.')
    windowTheme = theme
    nativeTheme.themeSource = theme
    window.setBackgroundColor(theme === 'dark' ? '#18181b' : '#ffffff')
    if (process.platform !== 'darwin')
      window.setTitleBarOverlay({
        ...titleBarColors(theme),
        height: titleBarHeight,
      })
  })
  agents = new AgentService(
    join(app.getPath('userData'), 'sessions.json'),
    (session) => {
      if (window && !window.isDestroyed())
        window.webContents.send('codex:session', session)
    },
    (reason) => {
      if (window && !window.isDestroyed())
        window.webContents.send('codex:disconnect', reason)
    },
    () => {
      if (window && !window.isDestroyed())
        window.webContents.send('codex:usage-changed')
    },
  )
  terminals = new TerminalService(
    join(app.getPath('userData'), 'terminal-resume.json'),
    (event) => {
      if (window && !window.isDestroyed())
        window.webContents.send('terminal:event', event)
    },
  )
  function requireTerminalSender(event: Electron.IpcMainInvokeEvent) {
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== event.sender.mainFrame
    )
      throw new Error('현재 앱 창에서만 터미널을 제어할 수 있습니다.')
  }
  ipcMain.handle('terminal:open', async (event, input: TerminalOpen) => {
    requireTerminalSender(event)
    if (updates?.snapshot().status === 'installing')
      throw new Error('업데이트 설치를 시작하고 있습니다.')
    const workspace = requireWorkspace(input?.workspace)
    await requireLinkedWorktree(workspace)
    if (
      (await agents!.all()).some(
        (session) =>
          pathKey(session.workspace) === pathKey(workspace) &&
          ['running', 'waiting'].includes(session.status),
      )
    )
      throw new Error('기존 실행을 중단한 뒤 터미널을 열어 주세요.')
    return terminals!.open({ ...input, workspace })
  })
  ipcMain.handle('terminal:write', (event, id: string, data: string) => {
    requireTerminalSender(event)
    terminals!.write(id, data)
  })
  ipcMain.handle(
    'terminal:resize',
    (event, id: string, cols: number, rows: number) => {
      requireTerminalSender(event)
      terminals!.resize(id, cols, rows)
    },
  )
  ipcMain.handle('terminal:close', (event, id: string) => {
    requireTerminalSender(event)
    return terminals!.stop(id)
  })
  ipcMain.handle('terminal:snapshot', (event, id: string) => {
    requireTerminalSender(event)
    return terminals!.snapshot(id)
  })
  updates = new UpdateService({
    version: app.isPackaged
      ? app.getVersion()
      : JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'))
          .version,
    platform: process.platform,
    arch: process.arch,
    cacheDirectory: join(app.getPath('userData'), 'updates'),
    canInstall: app.isPackaged,
    fetch: (url, init) => net.fetch(url, init),
    emit: (state) => {
      if (window && !window.isDestroyed())
        window.webContents.send('app:update', state)
    },
    beforeInstall: async () => {
      if (
        cloning ||
        terminals!.hasRunning() ||
        (await agents!.all()).some((session) =>
          ['running', 'waiting'].includes(session.status),
        )
      )
        throw new Error(
          '진행 중인 작업이나 저장소 복제를 마친 후 설치해 주세요.',
        )
    },
    openInstaller: async (path, sha256) => {
      await installAfterExit({
        platform: process.platform,
        installer: path,
        sha256,
        executable: process.execPath,
        cacheDirectory: join(app.getPath('userData'), 'updates'),
        version: updates!.snapshot().version!,
      })
      app.quit()
    },
  })
  let updateCheck: ReturnType<UpdateService['check']> | undefined
  const checkUpdateOnce = async () => {
    await (updateCheck ??= updates!.check())
    return updates!.snapshot()
  }
  const updateHandlers: Record<string, () => unknown> = {
    'app:update-status': () => updates!.snapshot(),
    'app:update-check': () => updates!.check(),
    'app:update-start': () => updates!.update(),
    'app:update-download': () => updates!.download(),
    'app:update-cancel': () => updates!.cancel(),
    'app:update-install': () => updates!.install(),
  }
  for (const [channel, handler] of Object.entries(updateHandlers)) {
    ipcMain.handle(channel, (event) => {
      if (
        !window ||
        event.sender !== window.webContents ||
        event.senderFrame !== event.sender.mainFrame
      )
        throw new Error('현재 앱 창에서만 업데이트할 수 있습니다.')
      return handler()
    })
  }
  if (process.env.LITE_IDE_HEADLESS !== '1') {
    void takeInstallError(join(app.getPath('userData'), 'updates')).then(
      (error) => {
        if (error) dialog.showErrorBox('업데이트 설치 실패', error)
      },
    )
    setTimeout(() => void checkUpdateOnce(), 10000).unref()
  }
  ipcMain.handle('codex:status', () => agents!.status())
  ipcMain.handle('codex:usage', () => agents!.usage())
  ipcMain.handle('codex:sessions', () => agents!.all())
  ipcMain.handle('codex:send', async (_event, input: SendMessage) => {
    if (updates?.snapshot().status === 'installing')
      throw new Error('업데이트 설치를 시작하고 있습니다.')
    const workspace = requireWorkspace(input?.workspace)
    await requireLinkedWorktree(workspace)
    return agents!.send({ ...input, workspace })
  })
  ipcMain.handle('codex:interrupt', (_event, id: string) =>
    agents!.interrupt(id),
  )
  ipcMain.handle('codex:subagent-inspect', (_event, id: string) =>
    agents!.inspectSubagent(id),
  )
  ipcMain.handle('codex:subagent-send', (_event, id: string, text: string) => {
    if (updates?.snapshot().status === 'installing')
      throw new Error('업데이트 설치를 시작하고 있습니다.')
    return agents!.sendSubagentMessage(id, text)
  })
  ipcMain.handle(
    'codex:answer',
    (_event, id: string, request: string, answer: RequestAnswer) =>
      agents!.answer(id, request, answer),
  )
  ipcMain.handle('codex:rename', (_event, id: string, title: string) =>
    agents!.rename(id, title),
  )
  ipcMain.handle('codex:delete', (_event, id: string) => agents!.delete(id))
  ipcMain.handle('link:open', async (_event, value: unknown) => {
    if (typeof value !== 'string') throw new Error('유효하지 않은 주소입니다.')
    const url = new URL(value)
    if (!['https:', 'http:'].includes(url.protocol))
      throw new Error('웹 주소만 열 수 있습니다.')
    await shell.openExternal(url.toString())
  })
  ipcMain.handle('codex:login', async () => {
    const { authUrl } = await agents!.login()
    const url = new URL(authUrl)
    if (
      url.protocol !== 'https:' ||
      !['auth.openai.com', 'auth0.openai.com', 'chatgpt.com'].includes(
        url.hostname,
      )
    )
      throw new Error('유효하지 않은 로그인 주소입니다.')
    await shell.openExternal(url.toString())
  })
  ipcMain.handle(
    'worktree:create',
    async (_event, path: string, branch: string, baseRef?: string) => {
      const directory = requireWorkspace(path)
      const tree = await createWorktree(directory, branch, baseRef)
      const worktreePath = resolve(tree.path)
      workspaces.add(worktreePath)
      return { ...tree, path: worktreePath }
    },
  )
  ipcMain.handle(
    'worktree:delete-preview',
    async (_event, projectPath: string, target: string) =>
      inspectWorktreeDeletion(
        await requireProject(projectPath), target, [...projects],
      ),
  )
  ipcMain.handle(
    'worktree:delete',
    async (
      _event,
      projectPath: string,
      target: string,
      options?: DeleteTaskOptions,
    ) => {
      if (
        (options?.discardChanges !== undefined && typeof options.discardChanges !== 'boolean') ||
        (options?.localOnly !== undefined && typeof options.localOnly !== 'boolean')
      )
        throw new Error('올바른 삭제 옵션을 선택해 주세요.')
      await restoredProjects
      const directory = requireWorkspace(projectPath)
      if (!projects.has(directory))
        throw new Error('열린 프로젝트를 선택해 주세요.')
      const workspace = await resolveWorktreePath(
        options?.localOnly === true ? target : requireWorkspace(target),
      )
      return agents!.removeWorkspace(workspace, async () => {
        if (
          options?.localOnly !== true &&
          options?.discardChanges !== true &&
          (await inspectRepository(workspace)).totalChanges > 0
        )
          throw new Error('변경 사항을 삭제하려면 확인이 필요합니다.')
        return terminals!.removeWorkspace(workspace, async () => {
          const result = await removeWorktree(
            directory,
            workspace,
            [...projects],
            options?.discardChanges === true,
            options?.localOnly === true,
          )
          deletedWorkspaces.add(pathKey(workspace))
          for (const path of workspaces) {
            if (pathKey(path) === pathKey(workspace)) workspaces.delete(path)
          }
          return result
        })
      })
    },
  )
  const projectFile = join(app.getPath('userData'), 'projects.json')
  let projectSave = Promise.resolve()
  async function registerProject(directory: string) {
    projects.add(directory)
    workspaces.add(directory)
    const snapshot = JSON.stringify([...projects])
    projectSave = projectSave
      .catch(() => {})
      .then(async () => {
        await mkdir(app.getPath('userData'), { recursive: true })
        await writeFile(`${projectFile}.tmp`, snapshot, 'utf8')
        await rename(`${projectFile}.tmp`, projectFile)
      })
    await projectSave
    return { path: directory, name: basename(directory) }
  }
  const restoredProjects = (async () => {
    try {
      const saved: unknown = JSON.parse(await readFile(projectFile, 'utf8'))
      if (!Array.isArray(saved)) return
      for (const path of saved) {
        if (typeof path !== 'string' || !isAbsolute(path)) continue
        if (!(await stat(path).catch(() => null))?.isDirectory()) continue
        const canonicalPath = await realpath(path)
        projects.add(canonicalPath)
        workspaces.add(canonicalPath)
      }
    } catch {
      /* 처음 실행하거나 저장 파일이 손상된 경우 빈 목록으로 시작합니다. */
    }
  })()
  async function requireProject(path: string) {
    await restoredProjects
    const directory = requireWorkspace(path)
    if (!projects.has(directory))
      throw new Error('등록된 프로젝트를 선택해 주세요.')
    return directory
  }
  ipcMain.handle('repository:branches', async (_event, path: string) =>
    listBranches(await requireProject(path)),
  )
  ipcMain.handle(
    'settings:project-update',
    async (_event, path: string, value: ProjectDefaults) => {
      const directory = await requireProject(path)
      const defaults = validateDefaults(value)
      if (defaults.baseRef !== 'HEAD')
        await resolveBaseRef(directory, defaults.baseRef)
      return settings.update(directory, defaults)
    },
  )
  ipcMain.handle('settings:project-reset', async (_event, path: string) =>
    settings.update(await requireProject(path), null),
  )
  ipcMain.handle('project:list', async () => {
    await restoredProjects
    return [...projects].map((path) => ({ path, name: basename(path) }))
  })
  ipcMain.handle('project:open', async () => {
    await restoredProjects
    if (!window) return null
    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory'],
    })
    if (result.canceled || !result.filePaths[0]) return null
    const directory = await realpath(result.filePaths[0])
    return registerProject(directory)
  })
  const defaultCloneDirectory = join(
    app.getPath(process.env.LITE_IDE_HEADLESS === '1' ? 'userData' : 'home'),
    'Projects',
  )
  ipcMain.handle('project:clone-default-directory', () => defaultCloneDirectory)
  ipcMain.handle('project:clone-directory', async () => {
    if (!window) return null
    const result = await dialog.showOpenDialog(window, {
      title: '저장소를 복제할 상위 폴더 선택',
      defaultPath: defaultCloneDirectory,
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || !result.filePaths[0]) return null
    const directory = resolve(result.filePaths[0])
    cloneDirectories.add(directory)
    return directory
  })
  ipcMain.handle(
    'project:clone',
    async (_event, url: string, parent: string, name: string) => {
      validateCloneInput(url, name)
      if (
        typeof parent !== 'string' ||
        (parent !== defaultCloneDirectory && !cloneDirectories.has(parent))
      )
        throw new Error('저장 위치를 먼저 선택해 주세요.')
      if (cloning) throw new Error('이미 저장소를 복제하고 있습니다.')
      if (updates?.snapshot().status === 'installing')
        throw new Error('업데이트 설치를 시작하고 있습니다.')
      cloning = true
      try {
        await restoredProjects
        if (parent === defaultCloneDirectory)
          await mkdir(parent, { recursive: true })
        const directory = await cloneRepository(url, parent, name)
        return await registerProject(directory)
      } finally {
        cloning = false
      }
    },
  )
  ipcMain.handle('repository:inspect', async (_event, projectPath: unknown) => {
    const directory = requireWorkspace(projectPath)
    const snapshot = await inspectRepository(directory)
    snapshot.worktrees = snapshot.worktrees.map((tree) => ({
      ...tree,
      path: resolve(tree.path),
    }))
    // 사용자가 연 프로젝트에서 확인된 Worktree만 추가 접근을 허용합니다.
    if (projects.has(directory)) {
      for (const worktree of snapshot.worktrees)
        if (!deletedWorkspaces.has(pathKey(worktree.path)))
          workspaces.add(resolve(worktree.path))
    }
    return snapshot
  })
  ipcMain.handle(
    'repository:diff',
    async (_event, projectPath: unknown, filePath: unknown) => {
      const directory = requireWorkspace(projectPath)
      if (typeof filePath !== 'string' || filePath.includes('\0'))
        throw new Error('잘못된 파일 경로입니다.')
      const scopedPath = relative(directory, resolve(directory, filePath))
      if (
        !scopedPath ||
        scopedPath === '..' ||
        scopedPath.startsWith(
          `..${process.platform === 'win32' ? '\\' : '/'}`,
        ) ||
        isAbsolute(scopedPath)
      ) {
        throw new Error('프로젝트 내부 파일만 확인할 수 있습니다.')
      }
      return readDiff(directory, scopedPath)
    },
  )

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

function createWindow(): void {
  window = new BrowserWindow({
    width: 1320,
    height: 850,
    minWidth: 960,
    minHeight: 600,
    title: 'Lite IDE',
    icon: join(
      iconDirectory,
      process.platform === 'win32' ? 'icon.ico' : 'icon.png',
    ),
    titleBarStyle: 'hidden',
    // 네이티브 창 버튼과 앱 상단을 같은 줄에 배치합니다.
    titleBarOverlay: {
      height: titleBarHeight,
      ...(process.platform !== 'darwin' ? titleBarColors(windowTheme) : {}),
    },
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 14, y: 14 } }
      : {}),
    backgroundColor: windowTheme === 'dark' ? '#18181b' : '#ffffff',
    autoHideMenuBar: true,
    show: process.env.LITE_IDE_HEADLESS !== '1',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  if (process.platform !== 'darwin') window.removeMenu()
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.on('closed', () => {
    window = null
  })
  if (process.env.ELECTRON_RENDERER_URL)
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

let quitting = false
app.on('before-quit', (event) => {
  if (quitting || !agents) return
  event.preventDefault()
  quitting = true
  updates?.cancel()
  void Promise.allSettled([agents.close(), terminals?.close()]).finally(() =>
    app.quit(),
  )
})
