import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SettingsService, validateDefaults } from './settings-service.ts'
import { pathKey } from './git.ts'
import { defaultNotificationSettings } from '../shared/notifications.ts'

test('프로젝트별 설정을 직렬 저장하고 재시작 및 선택 프로젝트 초기화를 지원한다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lite-ide-settings-'))
  const file = join(root, 'settings.json')
  const service = new SettingsService(file)
  const projectA = join(root, 'project-a'),
    projectB = join(root, 'project-b')
  const first = {
    baseRef: 'refs/heads/main',
    model: 'offline-model',
    effort: 'high',
  }
  const second = { baseRef: 'HEAD', model: 'second-model', effort: '' }
  try {
    await Promise.all([
      service.update(projectA, first),
      service.update(projectB, second),
    ])
    const restarted = new SettingsService(file)
    assert.deepEqual((await restarted.get()).projects, {
      [pathKey(projectA)]: first,
      [pathKey(projectB)]: second,
    })
    const next = await restarted.update(projectA, null)
    assert.deepEqual(next.projects, { [pathKey(projectB)]: second })
    assert.equal((await new SettingsService(file).get()).schemaVersion, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('이전 설정은 알림 기본값으로 마이그레이션하고 알림·프로젝트 동시 저장을 보존한다', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lite-settings-notifications-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'settings.json')
  await writeFile(file, JSON.stringify({ schemaVersion: 1, projects: {} }), 'utf8')
  const service = new SettingsService(file)
  assert.deepEqual((await service.get()).notifications, defaultNotificationSettings)
  const notifications = { enabled: false, soundEnabled: false, sound: 'custom' as const, volume: 35,
    customSound: { fileName: '12345678-1234-1234-1234-123456789abc.wav', name: '한글 음원.wav' } }
  const defaults = { baseRef: 'HEAD', model: 'test-model', effort: 'high', startupScriptPath: 'scripts/startup.ps1', startupAutoRun: false }
  await Promise.all([service.updateNotifications(notifications), service.update(root, defaults)])
  const saved = await new SettingsService(file).get()
  assert.deepEqual(saved.notifications, notifications)
  assert.deepEqual(saved.projects, { [pathKey(root)]: defaults })
  await service.updateNotifications({ ...notifications, volume: 40 })
  assert.deepEqual((await new SettingsService(file).get()).projects, { [pathKey(root)]: defaults })
  await service.updateNotifications(notifications)
  await assert.rejects(service.updateNotifications({ ...notifications, volume: NaN }))
  assert.deepEqual((await service.get()).notifications, notifications)
  await mkdir(file + '.tmp')
  await assert.rejects(service.updateNotifications(defaultNotificationSettings))
  assert.deepEqual((await service.get()).notifications, notifications)
  assert.equal((await readFile(file, 'utf8')).includes('한글 음원.wav'), true)
})

test('잘못된 설정과 저장 실패를 거부하고 성공하지 않은 값을 메모리에 반영하지 않는다', async () => {
  for (const invalid of [
    null,
    [],
    {},
    { baseRef: '--detach', model: '', effort: '' },
    { baseRef: 'refs/tags/v1', model: '', effort: '' },
    { baseRef: 'HEAD', model: 'line\nbreak', effort: '' },
  ])
    assert.throws(() => validateDefaults(invalid))
  const root = await mkdtemp(join(tmpdir(), 'lite-ide-settings-fail-'))
  const file = join(root, 'settings.json')
  const service = new SettingsService(file)
  try {
    await service.get()
    await mkdir(`${file}.tmp`)
    await assert.rejects(
      service.update(root, { baseRef: 'HEAD', model: 'model', effort: 'high' }),
    )
    assert.deepEqual((await service.get()).projects, {})
    await assert.rejects(
      service.update('../outside', { baseRef: 'HEAD', model: '', effort: '' }),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('손상되거나 지원하지 않는 설정 파일을 오류로 표시하고 덮어쓰지 않는다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lite-ide-settings-corrupt-'))
  const file = join(root, 'settings.json')
  try {
    for (const content of [
      'broken JSON',
      JSON.stringify({ schemaVersion: 99, projects: {} }),
    ]) {
      await writeFile(file, content, 'utf8')
      const service = new SettingsService(file)
      await assert.rejects(service.get())
      await assert.rejects(
        service.update(root, { baseRef: 'HEAD', model: '', effort: '' }),
      )
      assert.equal(await readFile(file, 'utf8'), content)
      await writeFile(
        file,
        JSON.stringify({ schemaVersion: 1, projects: {} }),
        'utf8',
      )
      assert.deepEqual((await service.get()).projects, {})
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Startup 파일 경로와 자동 실행 설정을 UTF-8로 저장하고 잘못된 경로를 거부한다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lite-ide-startup-settings-'))
  const file = join(root, 'settings.json')
  const defaults = { baseRef: 'HEAD', model: '', effort: '', startupScriptPath: 'scripts/한글 startup.ps1', startupAutoRun: false }
  try {
    await new SettingsService(file).update(root, defaults)
    assert.deepEqual((await new SettingsService(file).get()).projects[pathKey(root)], defaults)
    assert.notEqual((await readFile(file))[0], 0xef)
    for (const startupScriptPath of [42, 'a'.repeat(4097), '\0', 'echo ok\nexit 0', '../outside.ps1', '/tmp/startup.sh', 'C:\\startup.ps1', 'C:startup.ps1', '\\\\server\\startup.ps1'])
      assert.throws(() => validateDefaults({ ...defaults, startupScriptPath }))
    assert.equal(validateDefaults({ ...defaults, startupScriptPath: ' scripts\\startup.ps1 ' }).startupScriptPath, 'scripts/startup.ps1')
    assert.throws(() => validateDefaults({ ...defaults, startupAutoRun: 'yes' }))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('이전 Startup 명령은 복사할 수 있도록 보존하고 파일 경로로 해석하지 않는다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lite-ide-startup-legacy-'))
  const file = join(root, 'settings.json')
  const defaults = { baseRef: 'HEAD', model: '', effort: '', startupScript: "echo '한글'\nnpm install" }
  try {
    await writeFile(file, JSON.stringify({ schemaVersion: 1, projects: { [root]: defaults } }), 'utf8')
    const service = new SettingsService(file)
    const loaded = (await service.get()).projects[pathKey(root)]
    assert.equal(loaded.startupScript, defaults.startupScript)
    assert.equal(loaded.startupScriptPath, undefined)
    await service.update(root, { ...loaded, startupScriptPath: 'scripts/startup.ps1' })
    const saved = (await new SettingsService(file).get()).projects[pathKey(root)]
    assert.equal(saved.startupScriptPath, 'scripts/startup.ps1')
    assert.equal(saved.startupScript, defaults.startupScript)
  } finally { await rm(root, { recursive: true, force: true }) }
})
