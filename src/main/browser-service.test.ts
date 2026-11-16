import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BrowserService, browserServerName } from './browser-service.ts'

test('브라우저 실행은 셸 없이 인자를 보존하고 독립된 백그라운드 세션과 작업별 출력 경로를 사용한다', () => {
  const service = new BrowserService('/앱 데이터/output', { command: '/Program Files/Lite IDE.exe', cli: '/앱 경로/cli.js' })
  const config = service.config({ browser: 'chrome' }, '/프로젝트/작업')[`mcp_servers.${browserServerName}`] as {
    command: string; args: string[]; env: Record<string, string>; enabled: boolean
  }
  assert.equal(config.command, '/Program Files/Lite IDE.exe')
  assert.deepEqual(config.args.slice(0, 5), ['/앱 경로/cli.js', '--browser', 'chrome', '--headless', '--isolated'])
  assert.equal(config.env.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(config.enabled, true)
  assert.notDeepEqual(service.config({ browser: 'chrome' }, '/다른 작업'), service.config({ browser: 'chrome' }, '/프로젝트/작업'))
  const disabled = service.config({ browser: 'disabled' }, '/프로젝트')[`mcp_servers.${browserServerName}`] as { enabled: boolean }
  assert.equal(disabled.enabled, false)
})

test('실행 파일이 없으면 연결 성공으로 표시하지 않고 오류를 반환한다', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lite-browser-missing-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const service = new BrowserService(directory, { command: join(directory, 'missing-runtime'), cli: join(directory, 'missing-cli') })
  const result = await service.check({ browser: 'chrome' })
  assert.equal(result.ok, false)
  assert.match(result.message, /연결하지 못했습니다/)
  assert.match(result.message, /ENOENT/)
  assert.deepEqual(await service.check({ browser: 'disabled' }), { ok: false, message: '브라우저 자동 연결이 꺼져 있습니다.' })
})
