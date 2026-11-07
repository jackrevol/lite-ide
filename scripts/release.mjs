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
  const notes = `main 커밋 ${sha}에서 자동 빌드했습니다.

- Windows x64: .exe 설치 파일
- macOS Apple Silicon: arm64.dmg
- macOS Intel: x64.dmg
- 파일 무결성: SHA256SUMS.txt

Git과 Codex CLI가 필요합니다. 현재 배포 파일은 개발자 인증서 서명 및 Apple 공증을 적용하지 않았습니다.

## macOS 첫 설치

1. CPU에 맞는 DMG를 열고 Lite IDE.app을 쓰기 가능한 응용 프로그램(Applications) 폴더로 복사한 뒤 DMG를 추출합니다.
2. 복사한 앱을 실행하고 Apple이 악성 코드 여부를 확인할 수 없다는 경고가 나오면 닫습니다.
3. 이 저장소에서 받은 앱인지 확인한 뒤 **시스템 설정 → 개인정보 보호 및 보안 → 그래도 열기**에서 Lite IDE 실행을 허용합니다.

자세한 절차: [Apple의 앱 실행 허용 안내](https://support.apple.com/ko-kr/102445)

## 이후 업데이트

새 버전이 있으면 앱 타이틀바의 **업데이트** 버튼을 사용해 주세요. 앱이 설치 파일을 다운로드하고 SHA-256·앱 ID·버전·코드 서명을 검증한 뒤 종료·교체·재실행합니다. 검증한 새 앱의 다운로드 격리 속성을 제거해 업데이트 후 같은 경고가 반복되는 것을 방지합니다.

브라우저에서 DMG를 새로 받아 수동으로 설치하면 실행 허용이 다시 필요할 수 있습니다. 업데이트에 실패하면 기존 앱을 보존하거나 복구하며, 앱 설치 폴더에 쓰기 권한이 필요합니다.
`
  await writeFile(join(directory, 'release-notes.md'), notes, 'utf8')
  // 재실행 시 공개된 릴리스는 변경하지 않고, 업로드가 중단된 경우만 이어서 처리합니다.
  let release
  try {
    const existing = JSON.parse(
      gh('release', 'view', tag, '--json', 'databaseId,isDraft,url'),
    )
    release = {
      id: existing.databaseId,
      draft: existing.isDraft,
      html_url: existing.url,
    }
  } catch (error) {
    if (
      !/release not found|HTTP 404/i.test(String(error.stderr ?? error.message))
    )
      throw error
  }
  if (release && !release.draft) {
    console.log(`이미 공개된 릴리스: ${release.html_url}`)
  } else {
    if (!release) {
      // 생성 응답의 ID를 바로 사용해 목록 API의 반영 지연에 의존하지 않습니다.
      release = JSON.parse(
        execFileSync(
          'gh',
          ['api', '--method', 'POST', `repos/${repo}/releases`, '--input', '-'],
          {
            encoding: 'utf8',
            input: JSON.stringify({
              tag_name: tag,
              target_commitish: sha,
              name: `Lite IDE ${version}`,
              body: notes,
              generate_release_notes: true,
              draft: true,
            }),
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        ),
      )
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
