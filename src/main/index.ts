import {
  app,
  clipboard,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  net,
  Notification,
  powerSaveBlocker,
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
import { prepareCodex } from './codex-update-service'
import { TerminalService } from './terminal-service'
import { NotificationService } from './notification-service'
import { ResetAnnouncementService } from './reset-announcement-service'
import { StartupService } from './startup-service'
import { cloneRepository, validateCloneInput } from './clone'
import { UpdateService } from './update-service'
import { installAfterExit, takeInstallError } from './update-installer'
import type {
  RequestAnswer,
  SendMessage,
  ProjectDefaults,
  TerminalOpen,
  DeleteTaskOptions,
  StopProcessInput,
  NotificationSettings,
  NotificationTarget,
} from '../shared/types'

const projects = new Set<string>()
const workspaces = new Set<string>()
const deletedWorkspaces = new Set<string>()
const cloneDirectories = new Set<string>()
let cloning = false
let creatingWorktrees = 0
let window: BrowserWindow | null = null
let agents: AgentService | undefined
let terminals: TerminalService | undefined
let startups: StartupService | undefined
let updates: UpdateService | undefined
let resetAnnouncements: ResetAnnouncementService | undefined
let audioWindow: BrowserWindow | null = null
let audioReady: Promise<void> | undefined
let audioPlayback = Promise.resolve()
const activeNotifications = new Set<Notification>()
let pendingNotificationTarget: NotificationTarget | undefined
let notificationRendererReady = false
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
if (process.platform === 'win32') app.setAppUserModelId('dev.jackrevol.liteide')
app.setPath('userData', join(app.getPath('appData'), 'lite-ide'))
if (process.env.LITE_IDE_HEADLESS === '1' && process.env.LITE_IDE_TEST_DATA)
  app.setPath('userData', process.env.LITE_IDE_TEST_DATA)

app.whenReady().then(() => {
  // macOS·Windows 공통: 창의 표시 여부와 관계없이 앱 종료까지 시스템과 화면을 유지합니다.
  const awakeBlocker = powerSaveBlocker.start('prevent-display-sleep')
  app.once('will-quit', () => powerSaveBlocker.stop(awakeBlocker))
  const settings = new SettingsService(
    join(app.getPath('userData'), 'settings.json'),
  )
  resetAnnouncements = new ResetAnnouncementService((state) => {
    if (window && !window.isDestroyed()) window.webContents.send('codex:reset-announcements', state)
  }, (url, init) => net.fetch(url, init))
  ipcMain.handle('codex:reset-announcements-status', (event) => {
    requireTerminalSender(event)
    return resetAnnouncements!.status()
  })
  if (process.env.LITE_IDE_HEADLESS !== '1') resetAnnouncements.start()
  const notifications = new NotificationService(join(app.getPath('userData'), 'notification-sounds'),
    () => settings.get(), {
      supported: () => Notification.isSupported(),
      show: (title, body, click) => {
        const notification = new Notification({ title, body, silent: true })
        activeNotifications.add(notification)
        notification.on('close', () => activeNotifications.delete(notification))
        notification.on('failed', () => activeNotifications.delete(notification))
        notification.on('click', click)
        notification.show()
      },
      play: (dataUrl, volume) => {
        const operation = audioPlayback.catch(() => {}).then(async () => {
        if (quitting) return
        if (!audioWindow || audioWindow.isDestroyed()) {
          audioWindow = new BrowserWindow({ show: false, focusable: false, skipTaskbar: true, width: 1, height: 1,
            webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
              autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false } })
          audioWindow.on('closed', () => { audioWindow = null; audioReady = undefined })
          audioWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
          audioWindow.webContents.on('will-navigate', (event) => event.preventDefault())
          audioReady = audioWindow.loadURL('data:text/html,' + encodeURIComponent(
            '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; media-src data:"><audio></audio>'))
        }
        await audioReady
        if (!audioWindow || audioWindow.isDestroyed()) throw new Error('알림음 재생 창이 닫혔습니다.')
        await audioWindow.webContents.executeJavaScript(`(async () => {
          const audio = document.querySelector('audio'); audio.pause();
          clearTimeout(window.stopAudio); clearTimeout(window.startAudio);
          audio.src = ${JSON.stringify(dataUrl)}; audio.volume = ${volume};
          try {
            await Promise.race([audio.play(), new Promise((_, reject) => { window.startAudio = setTimeout(() => reject(new Error('음원 재생 시간이 초과되었습니다.')), 5000) })]);
            window.stopAudio = setTimeout(() => { audio.pause(); audio.removeAttribute('src'); audio.load(); }, 5000);
          } catch (error) {
            audio.pause(); audio.removeAttribute('src'); audio.load(); throw error;
          } finally { clearTimeout(window.startAudio); }
        })()`)
          .catch(() => { throw new Error('알림음을 재생할 수 없습니다. 다른 음원 파일을 선택해 주세요.') })
        })
        audioPlayback = operation
        return operation
      },
      activate: (target) => {
        if (process.env.LITE_IDE_HEADLESS === '1') return
        pendingNotificationTarget = target
        if (!window || window.isDestroyed()) createWindow()
        else {
          if (window.isMinimized()) window.restore()
          window.show(); window.focus()
          if (notificationRendererReady) {
            window.webContents.send('notifications:click', target)
            pendingNotificationTarget = undefined
          }
        }
      },
    })
  // 시작 시 저장된 음원만 남기므로 선택 취소·저장 실패 시 기존 파일이 유지됩니다.
  const soundsReady = notifications.cleanupSounds().catch(() => {})
  ipcMain.handle('settings:notifications-update', async (event, value: NotificationSettings) => {
    requireTerminalSender(event)
    await soundsReady
    return settings.updateNotifications(value)
  })
  ipcMain.handle('notifications:status', (event) => { requireTerminalSender(event); return notifications.status() })
  ipcMain.handle('notifications:take-pending', (event) => {
    requireTerminalSender(event)
    notificationRendererReady = true
    const target = pendingNotificationTarget ?? null
    pendingNotificationTarget = undefined
    return target
  })
  ipcMain.handle('notifications:preview', (event, value: NotificationSettings) => {
    requireTerminalSender(event)
    return notifications.preview(value)
  })
  ipcMain.handle('notifications:choose-sound', async (event) => {
    requireTerminalSender(event)
    await soundsReady
    if (process.env.LITE_IDE_HEADLESS === '1') return null
    const selected = await dialog.showOpenDialog(window!, { title: '사용자 알림음 선택',
      properties: ['openFile'], filters: [{ name: '음원 파일', extensions: ['wav', 'mp3', 'ogg'] }] })
    if (selected.canceled || !selected.filePaths[0]) return null
    return notifications.importSound(selected.filePaths[0])
  })
  startups = new StartupService(join(app.getPath('userData'), 'startup-runs.json'), (snapshot) => {
    if (window && !window.isDestroyed()) window.webContents.send('startup:event', snapshot)
  })
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
      notifications.observeSession(session, terminals?.hasRunningCodex(session.workspace))
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
    prepareCodex,
  )
  terminals = new TerminalService(
    join(app.getPath('userData'), 'terminal-resume.json'),
    (event) => {
      if (window && !window.isDestroyed())
        window.webContents.send('terminal:event', event)
      if (event.type === 'exit') {
        const workspace = terminals?.snapshot(event.taskId)?.workspace
        if (workspace) void agents?.terminalExited(workspace).catch(() => {})
      }
    },
    undefined,
    undefined,
    async (input, resuming) => {
      if (input.threadId) return input.threadId
      if (
        process.env.LITE_IDE_HEADLESS === '1' && process.env.LITE_IDE_TEST_TERMINAL
      )
        return undefined
      if (resuming) return agents!.latestWorkspaceThread(input.workspace)
      await agents!.client.start()
      return undefined
    },
    async (threadId) => {
      await agents!.client.start()
      const { thread } = await agents!.client.request<{
        thread: { turns: { id: string; status: string }[] }
      }>('thread/read', { threadId, includeTurns: true })
      const turn = thread.turns.at(-1)
      if (turn?.status === 'inProgress')
        await agents!.client.request('turn/interrupt', { threadId, turnId: turn.id })
    },
    undefined,
    (event) => notifications.notify(event),
  )
  let restoredTerminals = Promise.resolve()
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
    await restoredTerminals
    if (updates?.snapshot().status === 'installing')
      throw new Error('업데이트 설치를 시작하고 있습니다.')
    const workspace = requireWorkspace(input?.workspace)
    await requireLinkedWorktree(workspace)
    await startups!.requireReady(workspace)
    if (await agents!.hasOwnedRunningSession(workspace, input.threadId))
      throw new Error('기존 실행을 중단한 뒤 터미널을 열어 주세요.')
    if (updates?.snapshot().status === 'installing')
      throw new Error('업데이트 설치를 시작하고 있습니다.')
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
  ipcMain.handle('startup:snapshot', async (event, path: string) => {
    requireTerminalSender(event)
    await startups!.ready()
    return startups!.snapshot(requireWorkspace(path))
  })
  ipcMain.handle('startup:run', async (event, projectPath: string, path: string, automatic?: boolean) => {
    requireTerminalSender(event)
    if (automatic !== undefined && typeof automatic !== 'boolean') throw new Error('잘못된 Startup 실행 옵션입니다.')
    if (updates?.snapshot().status === 'installing') throw new Error('업데이트 설치를 시작하고 있습니다.')
    const directory = await requireProject(projectPath)
    const workspace = requireWorkspace(path)
    const repository = await inspectRepository(directory)
    if (!repository.worktrees.some((tree) => pathKey(tree.path) === pathKey(workspace)))
      throw new Error('이 프로젝트에 연결된 Worktree를 선택해 주세요.')
    await requireLinkedWorktree(workspace)
    const defaults = (await settings.get()).projects[pathKey(directory)]
    if (updates?.snapshot().status === 'installing') throw new Error('업데이트 설치를 시작하고 있습니다.')
    return startups!.run(workspace, defaults?.startupScriptPath ?? '', automatic, directory)
  })
  ipcMain.handle('startup:stop', (event, path: string) => {
    requireTerminalSender(event)
    return startups!.stop(requireWorkspace(path))
  })
  ipcMain.handle('process:inspect', (event, workspace: string) => {
    requireTerminalSender(event)
    return terminals!.inspectProcesses(requireWorkspace(workspace))
  })
  ipcMain.handle('process:stop', (event, input: StopProcessInput) => {
    requireTerminalSender(event)
    const workspace = requireWorkspace(input?.workspace)
    return terminals!.stopProcess({ ...input, workspace })
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
      if (cloning)
        throw new Error('저장소 복제를 마친 후 설치해 주세요.')
      if (creatingWorktrees) throw new Error('Worktree 생성을 마친 후 설치해 주세요.')
    },
    openInstaller: async (path, sha256) => {
      await restoredTerminals
      await startups!.stopAll()
      await terminals!.prepareForUpdate()
      window?.webContents.session.flushStorageData()
      try {
        await installAfterExit({
          platform: process.platform,
          installer: path,
          sha256,
          executable: process.execPath,
          cacheDirectory: join(app.getPath('userData'), 'updates'),
          version: updates!.snapshot().version!,
        })
      } catch (error) {
        await terminals!.cancelUpdateRestore()
        throw error
      }
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
  ipcMain.handle('codex:sessions', async (_event, workspace?: string) => {
    if (workspace !== undefined)
      await agents!.observeWorkspace(requireWorkspace(workspace))
    return agents!.all()
  })
  ipcMain.handle('codex:send', async (_event, input: SendMessage) => {
    if (updates?.snapshot().status === 'installing')
      throw new Error('업데이트 설치를 시작하고 있습니다.')
    const workspace = requireWorkspace(input?.workspace)
    await requireLinkedWorktree(workspace)
    await startups!.requireReady(workspace)
    return agents!.send({ ...input, workspace })
  })
  ipcMain.handle('codex:interrupt', (_event, id: string) =>
    agents!.interrupt(id),
  )
  ipcMain.handle('codex:subagent-inspect', (_event, id: string) =>
    agents!.inspectSubagent(id),
  )
  ipcMain.handle('codex:subagent-send', async (_event, id: string, text: string) => {
    if (updates?.snapshot().status === 'installing')
      throw new Error('업데이트 설치를 시작하고 있습니다.')
    const session = (await agents!.all()).find((session) => session.id === id)
    if (!session) throw new Error('세션을 찾을 수 없습니다.')
    await startups!.requireReady(session.workspace)
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
      creatingWorktrees++
      try {
      const directory = requireWorkspace(path)
      if (updates?.snapshot().status === 'installing') throw new Error('업데이트 설치를 시작하고 있습니다.')
      const defaults = (await settings.get()).projects[pathKey(directory)]
      await startups!.ready()
      const tree = await createWorktree(directory, branch, baseRef)
      const worktreePath = resolve(tree.path)
      workspaces.add(worktreePath)
      if (defaults?.startupAutoRun !== false && defaults?.startupScriptPath?.trim())
        await startups!.initialize(worktreePath, defaults.startupScriptPath, directory).catch(() => {
          // 생성된 Worktree는 반환하고, 미완료 상태는 작업 화면에서 복구합니다.
        })
      return { ...tree, path: worktreePath }
      } finally { creatingWorktrees-- }
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
      const preview = await inspectWorktreeDeletion(directory, workspace, [...projects])
      if (preview.localOnly && options?.localOnly !== true)
        throw new Error('Git 연결 상태가 변경되었습니다. 삭제 내용을 다시 확인해 주세요.')
      return agents!.removeWorkspace(workspace, async () => {
        if (
          options?.localOnly !== true &&
          options?.discardChanges !== true &&
          (await inspectRepository(workspace)).totalChanges > 0
        )
          throw new Error('변경 사항을 삭제하려면 확인이 필요합니다.')
        return startups!.removeWorkspace(workspace, () => terminals!.removeWorkspace(workspace, async () => {
          if (options?.localOnly !== true)
            await agents!.releaseWorkspaceResources(workspace)
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
        }))
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
  restoredTerminals = restoredProjects.then(async () => {
    await agents!.reconnectSessions()
    for (const project of projects) {
      const repository = await inspectRepository(project).catch(() => null)
      for (const tree of repository?.worktrees ?? [])
        workspaces.add(resolve(tree.path))
    }
    await terminals!.restoreAfterUpdate(async (workspace) => {
      const directory = requireWorkspace(workspace)
      await requireLinkedWorktree(directory)
      await startups!.requireReady(directory)
    })
  })
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
    await restoredTerminals
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
    if (!window || window.isDestroyed()) createWindow()
  })
})

function createWindow(): void {
  notificationRendererReady = false
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
  window.webContents.on('did-start-loading', () => { notificationRendererReady = false })
  window.on('closed', () => {
    window = null
    if (process.platform !== 'darwin') audioWindow?.destroy()
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
  resetAnnouncements?.close()
  if (quitting || !agents) return
  event.preventDefault()
  quitting = true
  updates?.cancel()
  audioWindow?.destroy()
  void (async () => {
    // 터미널의 세션 ID를 저장한 뒤 관찰 연결을 닫습니다.
    try {
      await Promise.allSettled([startups?.close(), terminals?.close()])
    } finally {
      await agents.close()
    }
  })().finally(() => app.quit())
})
