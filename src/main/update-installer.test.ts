import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import {
  installAfterExit,
  installErrorFile,
  startMacInstallWorker,
} from './update-installer.ts'

const run = promisify(execFile)
async function waitForFile(path: string) {
  for (let i = 0; i < 300; i++) {
    const text = await readFile(path, 'utf8').catch(() => '')
    if (text) return text
    await delay(50)
  }
  throw new Error(`설치 도우미 결과 대기 시간 초과: ${path}`)
}
function parent() {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    windowsHide: true,
    stdio: 'ignore',
  })
}

test(
  'Windows 설치 도우미는 앱 종료 후에만 silent 설치와 재실행 옵션을 전달한다',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'lite-installer-'))
    t.after(() =>
      rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      }),
    )
    const installer = join(directory, '한글 installer.exe')
    const source = join(directory, 'compile.ps1')
    await writeFile(
      source,
      String.raw`param([string]$Destination)
Add-Type -OutputAssembly $Destination -OutputType ConsoleApplication -TypeDefinition @'
using System;
using System.IO;
using System.Reflection;
public class Fixture {
  public static void Main(string[] args) {
    File.WriteAllText(Path.Combine(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location), "installed.txt"), String.Join(" ", args));
  }
}
'@
`,
      'utf8',
    )
    await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        source,
        installer,
      ],
      { windowsHide: true },
    )
    const sha256 = createHash('sha256')
      .update(await readFile(installer))
      .digest('hex')
    for (const tamper of [false, true]) {
      const cache = join(directory, tamper ? 'tamper-cache' : 'cache')
      const app = parent()
      try {
        await installAfterExit({
          platform: 'win32',
          installer,
          sha256,
          executable: join(directory, 'not-installed.exe'),
          cacheDirectory: cache,
          version: '0.2.0',
          parentPid: app.pid!,
        })
        if (!tamper)
          assert.equal(
            await readFile(join(directory, 'installed.txt'), 'utf8').catch(
              () => '',
            ),
            '',
          )
        if (tamper) await writeFile(installer, 'tampered', 'utf8')
        app.kill()
        if (tamper)
          assert.match(
            await waitForFile(join(cache, installErrorFile)),
            /checksum/,
          )
        else
          assert.equal(
            await waitForFile(join(directory, 'installed.txt')).catch(
              async (error) => {
                throw new Error(
                  await readFile(join(cache, installErrorFile), 'utf8').catch(
                    () => String(error),
                  ),
                )
              },
            ),
            '/S --force-run',
          )
        await delay(300)
        if (!tamper) {
          await rm(join(directory, 'installed.txt'))
          const driver = join(directory, 'driver.mjs')
          await writeFile(
            driver,
            `import { installAfterExit } from ${JSON.stringify(new URL('./update-installer.ts', import.meta.url).href)};\nawait installAfterExit(${JSON.stringify({ platform: 'win32', installer, sha256, executable: join(directory, 'not-installed.exe'), cacheDirectory: join(directory, 'exit-cache'), version: '0.2.0' })});\n`,
            'utf8',
          )
          await run(process.execPath, ['--experimental-strip-types', driver], {
            windowsHide: true,
            timeout: 20000,
          })
          assert.equal(
            await waitForFile(join(directory, 'installed.txt')),
            '/S --force-run',
          )
          await delay(300)
        }
      } finally {
        app.kill()
      }
    }
  },
)

test(
  'macOS 설치 도우미는 검증된 업데이트의 격리만 해제하고 변조된 앱은 교체하지 않는다',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'lite-installer-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const target = join(root, '한글 Lite IDE.app')
    const quarantine = '0081;00000000;LiteIDEUpdateTest;'
    const unrelated = join(root, '다른 다운로드.txt')
    await writeFile(unrelated, 'unrelated', 'utf8')
    await run('/usr/bin/xattr', ['-w', 'com.apple.quarantine', quarantine, unrelated])
    for (const { tamper, quarantined } of [
      { tamper: false, quarantined: false },
      { tamper: false, quarantined: true },
      { tamper: true, quarantined: true },
    ]) {
      await mkdir(join(target, 'Contents', 'Resources'), { recursive: true })
      await writeFile(
        join(target, 'Contents', 'Resources', 'marker'),
        'old',
        'utf8',
      )
      const staging = await mkdtemp(join(root, '.lite-ide-update-'))
      const staged = join(staging, 'Lite IDE.app')
      await mkdir(join(staged, 'Contents', 'MacOS'), { recursive: true })
      await copyFile('/usr/bin/true', join(staged, 'Contents', 'MacOS', 'test'))
      await writeFile(
        join(staged, 'Contents', 'Info.plist'),
        '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.jackrevol.liteide</string><key>CFBundleExecutable</key><string>test</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>',
        'utf8',
      )
      await mkdir(join(staged, 'Contents', 'Resources'), { recursive: true })
      await writeFile(
        join(staged, 'Contents', 'Resources', 'marker'),
        'new',
        'utf8',
      )
      await run('/usr/bin/codesign', ['--force', '--sign', '-', staged])
      await run('/usr/bin/xattr', ['-w', 'dev.liteide.test', 'preserved', staged])
      if (quarantined) {
        // 앱 루트뿐 아니라 내부 파일에 남은 다운로드 격리도 처리해야 합니다.
        await run('/usr/bin/xattr', ['-w', '-r', 'com.apple.quarantine', quarantine, staged])
      }
      if (tamper)
        await writeFile(
          join(staged, 'Contents', 'Resources', 'marker'),
          'tampered',
          'utf8',
        )
      const directory = await mkdtemp(join(root, 'worker-'))
      const app = parent()
      try {
        await startMacInstallWorker({
          staging,
          target,
          directory,
          parentPid: app.pid!,
          relaunch: false,
        })
        assert.equal(
          await readFile(
            join(target, 'Contents', 'Resources', 'marker'),
            'utf8',
          ),
          'old',
        )
        app.kill()
        if (tamper) {
          await waitForFile(join(root, installErrorFile))
          assert.equal(
            (await run('/usr/bin/xattr', ['-p', 'com.apple.quarantine', staged])).stdout.trim(),
            quarantine,
            '서명 검증에 실패한 앱은 격리를 해제하지 않아야 합니다.',
          )
          assert.equal(
            await readFile(
              join(target, 'Contents', 'Resources', 'marker'),
              'utf8',
            ),
            'old',
          )
        } else {
          for (let i = 0; i < 100; i++) {
            if (
              (await readFile(
                join(target, 'Contents', 'Resources', 'marker'),
                'utf8',
              ).catch(() => '')) === 'new'
            )
              break
            await delay(50)
          }
          assert.equal(
            await readFile(
              join(target, 'Contents', 'Resources', 'marker'),
              'utf8',
            ),
            'new',
          )
          assert.doesNotMatch(
            (await run('/usr/bin/xattr', ['-r', target])).stdout,
            /com\.apple\.quarantine/,
          )
          assert.equal(
            (await run('/usr/bin/xattr', ['-p', 'dev.liteide.test', target])).stdout.trim(),
            'preserved',
          )
          await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', target])
          await run(join(target, 'Contents', 'MacOS', 'test'))
        }
        assert.equal(
          (await run('/usr/bin/xattr', ['-p', 'com.apple.quarantine', unrelated])).stdout.trim(),
          quarantine,
          '업데이트 앱 밖의 다운로드는 변경하지 않아야 합니다.',
        )
        await delay(300)
      } finally {
        app.kill()
      }
    }
  },
)
