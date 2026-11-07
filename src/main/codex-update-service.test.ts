import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CodexUpdateService, codexUpdateCommand } from './codex-update-service.ts'

for (const latest of ['0.166.0', '0.165.0'])
  test(`설치 버전보다 높지 않은 ${latest} 버전은 설치하지 않는다`, async () => {
    let installs = 0
    const service = new CodexUpdateService({
      find: async () => '/codex', version: async () => '0.166.0',
      latest: async () => latest, install: async () => { installs++ }, skip: () => false,
    })
    assert.equal(await service.prepare(), '/codex')
    assert.equal(installs, 0)
  })

test('동시 시작은 한 번만 업데이트하고 설치 후 경로를 다시 찾으며 다음 시작 때 다시 확인한다', async () => {
  let binary = '/old/codex'
  let checks = 0
  let installs = 0
  let release!: () => void
  const installing = new Promise<void>((resolve) => { release = resolve })
  const service = new CodexUpdateService({
    find: async () => binary,
    version: async () => binary === '/old/codex' ? '0.165.0' : '0.166.0',
    latest: async () => { checks++; return '0.166.0' }, skip: () => false,
    install: async () => { installs++; await installing; binary = '/new/codex' },
  })
  const first = service.prepare()
  const second = service.prepare()
  assert.equal(first, second)
  release()
  assert.deepEqual(await Promise.all([first, second]), ['/new/codex', '/new/codex'])
  assert.equal(installs, 1)
  assert.equal(checks, 1)
  await service.prepare()
  assert.equal(checks, 2)
  assert.equal(installs, 1)
})

for (const failure of ['version', 'latest', 'install'] as const)
  test(`${failure} 실패 시 기존 CLI로 시작하고 다음 시작에서 재시도한다`, async () => {
    let failing = true
    let installs = 0
    const warnings: string[] = []
    const check = (stage: string) => { if (failing && failure === stage) throw new Error('테스트 실패') }
    const service = new CodexUpdateService({
      find: async () => '/codex', skip: () => false,
      version: async () => { check('version'); return '0.165.0' },
      latest: async () => { check('latest'); return '0.166.0' },
      install: async () => { check('install'); installs++ },
      warn: (message) => warnings.push(message),
    })
    assert.equal(await service.prepare(), '/codex')
    assert.equal(installs, 0)
    assert.match(warnings[0], /설치된 버전으로 시작.*테스트 실패/)
    failing = false
    assert.equal(await service.prepare(), '/codex')
    assert.equal(installs, 1)
  })

test('Codex가 없으면 설치를 시도하지 않고 기존 설치 안내를 유지한다', async () => {
  const service = new CodexUpdateService({
    find: async () => { throw new Error('Codex CLI를 찾을 수 없습니다.') },
    install: async () => { assert.fail('설치를 실행하면 안 됩니다.') },
  })
  await assert.rejects(service.prepare(), /Codex CLI를 찾을 수 없습니다/)
})

test('픽스처 실행은 버전 조회와 업데이트를 건너뛴다', async () => {
  const service = new CodexUpdateService({
    find: async () => '/fixture', skip: () => true,
    version: async () => { assert.fail('버전을 조회하면 안 됩니다.') },
    latest: async () => { assert.fail('네트워크에 연결하면 안 됩니다.') },
    install: async () => { assert.fail('설치를 실행하면 안 됩니다.') },
  })
  assert.equal(await service.prepare(), '/fixture')
})

test('npm의 중첩된 플랫폼 바이너리는 Node 모드의 래퍼로 비대화형 업데이트한다', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lite-codex-update-한글 '))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const binary = join(directory, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'target', 'bin', 'codex.exe')
  const wrapper = join(directory, 'bin', 'codex.js')
  const marker = join(directory, 'updated.json')
  await mkdir(join(directory, 'bin'), { recursive: true })
  await mkdir(join(binary, '..'), { recursive: true })
  await writeFile(binary, '', 'utf8')
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: '@openai/codex', type: 'module' }), 'utf8')
  await writeFile(wrapper, `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ args: process.argv.slice(2), node: process.env.ELECTRON_RUN_AS_NODE, interactive: process.env.CODEX_NON_INTERACTIVE }), 'utf8');`, 'utf8')
  const service = new CodexUpdateService({
    find: async () => binary, skip: () => false,
    version: async () => '0.165.0', latest: async () => '0.166.0',
    warn: (message) => assert.fail(message),
  })
  await service.prepare()
  assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), {
    args: ['update'], node: '1', interactive: '1',
  })
  const standalone = join(directory, 'standalone', 'codex')
  await mkdir(join(directory, 'standalone'))
  await writeFile(standalone, '', 'utf8')
  // 독립 바이너리는 npm 패키지의 하위 경로와 구분합니다.
  await writeFile(join(directory, 'package.json'), '{}', 'utf8')
  const command = await codexUpdateCommand(standalone)
  assert.equal(command.binary, standalone)
  assert.deepEqual(command.args, ['update'])
  assert.equal(command.env.ELECTRON_RUN_AS_NODE, undefined)
})
