import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { inspectRepository, readDiff } from './git'

const projects = new Set<string>()
const workspaces = new Set<string>()
let window: BrowserWindow | null = null

function requireWorkspace(value: unknown): string {
  if (typeof value !== 'string' || !workspaces.has(resolve(value))) {
    throw new Error('프로젝트를 먼저 열어주세요.')
  }
  return resolve(value)
}

app.setName('Lite IDE')
app.setPath('userData', join(app.getPath('appData'), 'lite-ide'))

app.whenReady().then(() => {
  ipcMain.handle('project:open', async () => {
    if (!window) return null
    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory'],
    })
    if (result.canceled || !result.filePaths[0]) return null
    const directory = resolve(result.filePaths[0])
    projects.add(directory)
    workspaces.add(directory)
    return { path: directory, name: basename(directory) }
  })
  ipcMain.handle('repository:inspect', async (_event, projectPath: unknown) => {
    const directory = requireWorkspace(projectPath)
    const snapshot = await inspectRepository(directory)
    // 사용자가 연 프로젝트에서 확인된 Worktree만 추가 접근을 허용합니다.
    if (projects.has(directory)) {
      for (const worktree of snapshot.worktrees)
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
    backgroundColor: '#fafafa',
    autoHideMenuBar: true,
    show: process.env.LITE_IDE_HEADLESS !== '1',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
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
