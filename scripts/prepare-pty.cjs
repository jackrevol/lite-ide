const { chmod, readdir, stat } = require('node:fs/promises')
const { dirname, join } = require('node:path')

async function verifyPtyPrebuild(directory, platform, arch) {
  const required = platform === 'darwin'
    ? ['pty.node', 'spawn-helper']
    : platform === 'win32'
      ? ['conpty.node', 'conpty_console_list.node', 'pty.node', 'winpty-agent.exe',
          'winpty.dll', 'conpty/conpty.dll', 'conpty/OpenConsole.exe']
      : null
  if (!required) throw new Error(`지원하지 않는 PTY 플랫폼: ${platform}`)
  const prebuild = join(directory, 'prebuilds', `${platform}-${arch}`)
  for (const file of required) {
    const info = await stat(join(prebuild, file)).catch(() => null)
    if (!info?.isFile() || info.size === 0)
      throw new Error(`node-pty 사전 빌드 파일이 없습니다: ${platform}-${arch}/${file}`)
  }
}

// node-pty 1.1.0의 macOS 사전 빌드에는 spawn-helper 실행 권한이 빠져 있습니다.
// 설치 직후와 패키징 후(서명 전)에 모두 적용합니다.
async function preparePty(directory) {
  const prebuilds = join(directory, 'prebuilds')
  const architectures = await readdir(prebuilds)
  const helpers = [
    join(directory, 'build', 'Release', 'spawn-helper'),
    join(directory, 'build', 'Debug', 'spawn-helper'),
    ...architectures.filter((name) => name.startsWith('darwin-'))
      .map((name) => join(prebuilds, name, 'spawn-helper')),
  ]
  let found = false
  for (const helper of helpers) {
    const info = await stat(helper).catch((error) => {
      if (error.code !== 'ENOENT') throw error
      return null
    })
    if (!info) continue
    await chmod(helper, info.mode | 0o111)
    found = true
  }
  if (!found) throw new Error('node-pty spawn-helper를 찾을 수 없습니다.')
}

module.exports = async (context) => {
  const platform = context.electronPlatformName
  const arch = require('builder-util').Arch[context.arch]
  const resources = platform === 'darwin'
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : join(context.appOutDir, 'resources')
  const directory = join(resources, 'app.asar.unpacked', 'node_modules', 'node-pty')
  // 재컴파일을 생략하는 대신 실제 배포 대상의 바이너리가 포함됐는지 확인합니다.
  await verifyPtyPrebuild(directory, platform, arch)
  if (platform === 'darwin') await preparePty(directory)
}
module.exports.preparePty = preparePty
module.exports.verifyPtyPrebuild = verifyPtyPrebuild

if (require.main === module && process.platform === 'darwin') {
  preparePty(dirname(require.resolve('node-pty/package.json'))).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
