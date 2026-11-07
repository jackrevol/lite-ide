import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'

const run = promisify(execFile)
export const installErrorFile = 'last-install-error.txt'

// 경로는 스크립트에 삽입하지 않고 별도 인수로 전달합니다.
const windowsWorker = String.raw`param(
  [int]$AppProcessId, [string]$Installer, [string]$ExpectedHash,
  [string]$Ready, [string]$Failure, [string]$AppExecutable
)
$ErrorActionPreference = 'Stop'
$parent = [System.Diagnostics.Process]::GetProcessById($AppProcessId)
[System.IO.File]::WriteAllText($Ready, 'ready')
try {
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while (-not [System.IO.File]::Exists($Ready + '.go')) {
    if ([DateTime]::UtcNow -gt $deadline) { throw 'App did not authorize installation.' }
    [System.Threading.Thread]::Sleep(50)
  }
  if (-not $parent.WaitForExit(300000)) { throw 'App did not exit within five minutes.' }
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($Installer)
  try { $actualHash = [System.BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '') }
  finally { $stream.Dispose(); $algorithm.Dispose() }
  if ($actualHash -ne $ExpectedHash) {
    throw 'Installer checksum changed after download.'
  }
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = $Installer
  $start.Arguments = '/S --force-run'
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $setup = [System.Diagnostics.Process]::Start($start)
  $setup.WaitForExit()
  if ($setup.ExitCode -ne 0) { throw ('Installer exited with code ' + $setup.ExitCode) }
} catch {
  [System.IO.File]::WriteAllText($Failure, $_.Exception.Message, (New-Object System.Text.UTF8Encoding($false)))
  if ($parent.HasExited -and [System.IO.File]::Exists($AppExecutable)) {
    $restart = New-Object System.Diagnostics.ProcessStartInfo
    $restart.FileName = $AppExecutable
    $restart.UseShellExecute = $false
    [System.Diagnostics.Process]::Start($restart) | Out-Null
  }
  exit 1
}
`

const macWorker = String.raw`#!/bin/sh
set -eu
pid="$1"
staging="$2"
target="$3"
ready="$4"
failure="$5"
relaunch="$6"
parent=$(/usr/bin/dirname "$target")
case "$staging" in "$parent"/.lite-ide-update-*) ;; *) exit 1;; esac
staged="$staging/Lite IDE.app"
backup="$staging/previous.app"
moved=0
installed=0
recover() {
  trap - EXIT
  printf '%s\n' 'The app update could not finish. The previous version was restored when possible.' > "$failure"
  if [ "$installed" = 1 ]; then /bin/mv "$target" "$staging/failed.app" || true; fi
  if [ "$moved" = 1 ]; then /bin/mv "$backup" "$target" || true; fi
  if [ "$relaunch" = 1 ] && ! kill -0 "$pid" 2>/dev/null; then /usr/bin/open "$target" || true; fi
  exit 1
}
trap recover EXIT
kill -0 "$pid"
printf ready > "$ready"
count=0
while [ ! -f "$ready.go" ]; do
  count=$((count + 1))
  if [ "$count" -gt 30 ]; then exit 1; fi
  sleep 1
done
count=0
while kill -0 "$pid" 2>/dev/null; do
  count=$((count + 1))
  if [ "$count" -gt 300 ]; then exit 1; fi
  sleep 1
done
/usr/bin/codesign --verify --deep --strict "$staged"
# 첫 실행을 허용한 앱의 자체 업데이트입니다. 검증한 새 앱의 다운로드 격리만 해제합니다.
# 심볼릭 링크는 링크 자체를 처리해 앱 밖의 파일을 변경하지 않습니다.
/usr/bin/xattr -drs com.apple.quarantine "$staged"
/bin/mv "$target" "$backup"
moved=1
/bin/mv "$staged" "$target"
installed=1
if [ "$relaunch" = 1 ]; then /usr/bin/open "$target"; fi
trap - EXIT
# 검증한 동일 부모 디렉터리의 업데이트 임시 폴더만 정리합니다.
/bin/rm -rf -- "$staging"
`

async function hashFile(path: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function startWorker(command: string, args: string[], ready: string) {
  let launchArgs = args
  if (process.platform === 'win32') {
    // 별도 숨김 콘솔에서 시작해야 앱 프로세스의 콘솔 종료 신호를 받지 않습니다.
    const quote = (value: string) =>
      '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"'
    const encodedPath = Buffer.from(command, 'utf8').toString('base64')
    const encodedArgs = Buffer.from(args.map(quote).join(' '), 'utf8').toString(
      'base64',
    )
    const bootstrap = `$ErrorActionPreference = 'Stop'; $start = New-Object System.Diagnostics.ProcessStartInfo; $start.FileName = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}')); $start.Arguments = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedArgs}')); $start.UseShellExecute = $true; $start.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden; [System.Diagnostics.Process]::Start($start) | Out-Null`
    launchArgs = [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-EncodedCommand',
      Buffer.from(bootstrap, 'utf16le').toString('base64'),
    ]
  }
  const child = spawn(command, launchArgs, {
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let failure: Error | undefined
  let details = ''
  child.stderr?.on('data', (data: Buffer) => {
    details = (details + data.toString('utf8')).slice(-4000)
  })
  child.on('error', (error) => {
    failure = error
  })
  child.on('exit', (code) => {
    if (process.platform !== 'win32' || code !== 0)
      failure = new Error(`설치 도우미가 종료되었습니다 (${code}).`)
  })
  try {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      if (failure) throw new Error(`${failure.message} ${details}`.trim())
      if (
        await access(ready).then(
          () => true,
          () => false,
        )
      ) {
        await writeFile(ready + '.go', 'go', 'utf8')
        child.unref()
        child.stderr?.destroy()
        return
      }
      await delay(50)
    }
    throw new Error(
      '설치 도우미를 시작하지 못했습니다. 앱을 종료하지 않았습니다.',
    )
  } catch (error) {
    child.kill()
    throw error
  }
}

export async function startMacInstallWorker(options: {
  staging: string
  target: string
  directory: string
  parentPid: number
  relaunch?: boolean
}) {
  const script = join(options.directory, 'install.sh')
  const ready = join(options.directory, 'ready')
  await writeFile(script, macWorker, 'utf8')
  await startWorker(
    '/bin/sh',
    [
      script,
      String(options.parentPid),
      options.staging,
      options.target,
      ready,
      join(dirname(options.directory), installErrorFile),
      options.relaunch === false ? '0' : '1',
    ],
    ready,
  )
}

export async function installAfterExit(options: {
  platform: string
  installer: string
  sha256: string
  executable: string
  cacheDirectory: string
  version: string
  parentPid?: number
}) {
  const parentPid = options.parentPid ?? process.pid
  if ((await hashFile(options.installer)) !== options.sha256)
    throw new Error('설치 파일이 변경되었습니다. 다시 다운로드해 주세요.')
  await mkdir(options.cacheDirectory, { recursive: true })
  const directory = await mkdtemp(join(options.cacheDirectory, 'install-'))
  if (options.platform === 'win32') {
    const script = join(directory, 'install.ps1')
    const ready = join(directory, 'ready')
    await writeFile(script, windowsWorker, 'utf8')
    const powershell = join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    )
    await startWorker(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        script,
        '-AppProcessId',
        String(parentPid),
        '-Installer',
        options.installer,
        '-ExpectedHash',
        options.sha256,
        '-Ready',
        ready,
        '-Failure',
        join(options.cacheDirectory, installErrorFile),
        '-AppExecutable',
        options.executable,
      ],
      ready,
    )
    return
  }
  if (options.platform !== 'darwin')
    throw new Error('지원하지 않는 운영체제입니다.')
  const target = await realpath(dirname(dirname(dirname(options.executable))))
  if (!target.endsWith('.app'))
    throw new Error('설치된 앱 위치를 확인할 수 없습니다.')
  const plist = (bundle: string, field: string) =>
    run('/usr/libexec/PlistBuddy', [
      '-c',
      `Print :${field}`,
      join(bundle, 'Contents', 'Info.plist'),
    ])
  if (
    (await plist(target, 'CFBundleIdentifier')).stdout.trim() !==
    'dev.jackrevol.liteide'
  )
    throw new Error('Lite IDE 앱 위치가 아닙니다.')
  let staging: string
  try {
    staging = await mkdtemp(join(dirname(target), '.lite-ide-update-'))
  } catch {
    throw new Error(
      '앱 폴더에 쓸 수 없습니다. Lite IDE를 쓰기 가능한 Applications 폴더에 설치한 뒤 다시 시도해 주세요.',
    )
  }
  const mount = join(directory, 'volume')
  await mkdir(mount)
  let mounted = false
  try {
    await run('/usr/bin/hdiutil', [
      'attach',
      '-readonly',
      '-nobrowse',
      '-mountpoint',
      mount,
      options.installer,
    ])
    mounted = true
    const source = join(mount, 'Lite IDE.app')
    if (
      basename(await realpath(source)) !== 'Lite IDE.app' ||
      dirname(await realpath(source)) !== (await realpath(mount))
    )
      throw new Error('설치 이미지의 앱 위치가 올바르지 않습니다.')
    if (
      (await plist(source, 'CFBundleIdentifier')).stdout.trim() !==
        'dev.jackrevol.liteide' ||
      (await plist(source, 'CFBundleShortVersionString')).stdout.trim() !==
        options.version
    )
      throw new Error('설치 이미지의 앱 또는 버전이 일치하지 않습니다.')
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', source])
    await run('/usr/bin/ditto', [source, join(staging, 'Lite IDE.app')])
    await run('/usr/bin/codesign', [
      '--verify',
      '--deep',
      '--strict',
      join(staging, 'Lite IDE.app'),
    ])
    await run('/usr/bin/hdiutil', ['detach', mount])
    mounted = false
    await startMacInstallWorker({ staging, target, directory, parentPid })
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  } finally {
    if (mounted)
      await run('/usr/bin/hdiutil', ['detach', mount]).catch(() => {})
  }
}

export async function takeInstallError(cacheDirectory: string) {
  const path = join(cacheDirectory, installErrorFile)
  const error = await readFile(path, 'utf8').catch(() => '')
  if (error) await rm(path, { force: true })
  return error
}
