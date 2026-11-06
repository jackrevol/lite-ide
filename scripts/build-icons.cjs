const { app, nativeImage } = require('electron')
const { mkdirSync, writeFileSync } = require('node:fs')
const { resolve, join } = require('node:path')

app.setPath('userData', resolve('artifacts/icon-build'))
app
  .whenReady()
  .then(() => {
    const resources = resolve('resources')
    const publicDir = resolve('src/renderer/public')
    mkdirSync(publicDir, { recursive: true })
    const source = nativeImage.createFromPath(
      join(resources, 'icon-source.png'),
    )
    if (source.isEmpty()) throw new Error('아이콘 원본을 읽을 수 없습니다.')
    const png = (size) =>
      source.resize({ width: size, height: size, quality: 'best' }).toPNG()
    writeFileSync(join(resources, 'icon.png'), png(1024))
    writeFileSync(join(publicDir, 'app-icon.png'), png(256))
    writeFileSync(join(publicDir, 'favicon.png'), png(32))

    // ICO에는 각 해상도의 PNG를 넣어 Windows 배율에 맞는 이미지를 제공합니다.
    const sizes = [16, 24, 32, 48, 64, 128, 256]
    const images = sizes.map(png)
    const header = Buffer.alloc(6 + images.length * 16)
    header.writeUInt16LE(1, 2)
    header.writeUInt16LE(images.length, 4)
    let offset = header.length
    images.forEach((data, index) => {
      const start = 6 + index * 16
      header[start] = sizes[index] === 256 ? 0 : sizes[index]
      header[start + 1] = header[start]
      header.writeUInt16LE(1, start + 4)
      header.writeUInt16LE(32, start + 6)
      header.writeUInt32LE(data.length, start + 8)
      header.writeUInt32LE(offset, start + 12)
      offset += data.length
    })
    writeFileSync(
      join(resources, 'icon.ico'),
      Buffer.concat([header, ...images]),
    )

    // ICNS의 PNG 기반 슬롯은 Retina를 포함한 16~1024px 크기를 지원합니다.
    const slots = [
      ['icp4', 16],
      ['icp5', 32],
      ['icp6', 64],
      ['ic07', 128],
      ['ic08', 256],
      ['ic09', 512],
      ['ic10', 1024],
      ['ic11', 32],
      ['ic12', 64],
      ['ic13', 256],
      ['ic14', 512],
    ]
    const chunks = slots.map(([type, size]) => {
      const data = png(size)
      const chunk = Buffer.alloc(8)
      chunk.write(type, 0, 4, 'ascii')
      chunk.writeUInt32BE(data.length + 8, 4)
      return Buffer.concat([chunk, data])
    })
    const icns = Buffer.alloc(8)
    icns.write('icns', 0, 4, 'ascii')
    icns.writeUInt32BE(
      8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0),
      4,
    )
    writeFileSync(
      join(resources, 'icon.icns'),
      Buffer.concat([icns, ...chunks]),
    )
    console.log(
      '아이콘 생성 완료: PNG, Windows ICO 7개 크기, macOS ICNS 11개 슬롯',
    )
    app.quit()
  })
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
