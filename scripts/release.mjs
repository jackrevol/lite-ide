import { appendFile, readFile, readdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const command = process.argv[2]
if (command === 'metadata') {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'))
  const base = /^(\d+)\.(\d+)\.(\d+)$/.exec(pkg.version)
  const run = Number(process.env.GITHUB_RUN_NUMBER)
  if (!base || !Number.isSafeInteger(run) || run < 1)
    throw new Error('올바른 기본 버전과 Actions 실행 번호가 필요합니다.')
  const version = `${base[1]}.${base[2]}.${Number(base[3]) + run}`
  const output = `version=${version}\ntag=v${version}\n`
  if (process.env.GITHUB_OUTPUT)
    await appendFile(process.env.GITHUB_OUTPUT, output, 'utf8')
  console.log(output.trim())
} else if (command === 'publish') {
  const version = process.env.RELEASE_VERSION
  const sha = process.env.GITHUB_SHA
  const repo = process.env.GH_REPO
  if (
    !/^\d+\.\d+\.\d+$/.test(version ?? '') ||
    !/^[a-f0-9]{40}$/.test(sha ?? '') ||
    !repo
  )
    throw new Error('릴리스 환경 변수가 올바르지 않습니다.')
  const gh = (...args) =>
    execFileSync('gh', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  const tag = `v${version}`
  const directory = 'release-assets'
  const names = [
    `Lite-IDE-${version}-win-x64.exe`,
    `Lite-IDE-${version}-mac-arm64.dmg`,
    `Lite-IDE-${version}-mac-x64.dmg`,
  ]
  const files = await readdir(directory)
  if (
    files.length !== names.length ||
    names.some((name) => !files.includes(name))
  )
    throw new Error(
      '세 플랫폼의 설치 파일이 모두 준비되어야 릴리스할 수 있습니다.',
    )
  const sums = []
  for (const name of names) {
    const content = await readFile(join(directory, name))
    if (!content.length) throw new Error(`빈 설치 파일: ${name}`)
    sums.push(`${createHash('sha256').update(content).digest('hex')}  ${name}`)
  }
  await writeFile(
    join(directory, 'SHA256SUMS.txt'),
    `${sums.join('\n')}\n`,
    'utf8',
  )
  const notes = `main 커밋 ${sha}에서 자동 빌드했습니다.\n\n- Windows x64: .exe 설치 파일\n- macOS Apple Silicon: arm64.dmg\n- macOS Intel: x64.dmg\n- 파일 무결성: SHA256SUMS.txt\n\nGit과 Codex CLI가 필요합니다. 현재 배포 파일은 개발자 인증서 서명 및 Apple 공증을 적용하지 않았습니다.\n`
  await writeFile(join(directory, 'release-notes.md'), notes, 'utf8')
  // 재실행 시 공개된 릴리스는 변경하지 않고, 업로드가 중단된 경우만 이어서 처리합니다.
  const listReleases = () =>
    JSON.parse(
      gh('api', `repos/${repo}/releases?per_page=100`, '--paginate', '--slurp'),
    ).flat()
  const releases = listReleases()
  let release = releases.find((entry) => entry.tag_name === tag)
  if (release && !release.draft) {
    console.log(`이미 공개된 릴리스: ${release.html_url}`)
  } else {
    if (!release) {
      gh(
        'release',
        'create',
        tag,
        '--target',
        sha,
        '--title',
        `Lite IDE ${version}`,
        '--notes-file',
        join(directory, 'release-notes.md'),
        '--generate-notes',
        '--draft',
      )
      release = listReleases().find((entry) => entry.tag_name === tag)
      if (!release) throw new Error('생성한 릴리스를 확인하지 못했습니다.')
    }
    gh(
      'release',
      'upload',
      tag,
      ...[...names, 'SHA256SUMS.txt'].map((name) => join(directory, name)),
      '--clobber',
    )
    // 완료 순서가 달라도 버전이 가장 높은 릴리스를 Latest로 선택합니다.
    const published = JSON.parse(
      gh(
        'api',
        '--method',
        'PATCH',
        `repos/${repo}/releases/${release.id}`,
        '-F',
        'draft=false',
        '-f',
        'make_latest=legacy',
      ),
    )
    console.log(`릴리스 공개 완료: ${published.html_url}`)
  }
} else {
  throw new Error('사용법: node scripts/release.mjs metadata|publish')
}
