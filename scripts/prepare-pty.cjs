const { chmod, readdir, stat } = require('node:fs/promises')
const { dirname, join } = require('node:path')

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
  if (context.electronPlatformName !== 'darwin') return
  const resources = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
  await preparePty(join(resources, 'app.asar.unpacked', 'node_modules', 'node-pty'))
}
module.exports.preparePty = preparePty

if (require.main === module && process.platform === 'darwin') {
  preparePty(dirname(require.resolve('node-pty/package.json'))).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
