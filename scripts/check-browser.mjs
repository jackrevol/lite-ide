import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { BrowserService, browserServerName } from '../src/main/browser-service.ts'
import { CodexClient } from '../src/main/codex-client.ts'

// 모델을 호출하지 않고 앱의 Node 런타임·Chrome·실제 daemon MCP 경로를 검사합니다.
const require = createRequire(import.meta.url)
const directory = await mkdtemp(join(tmpdir(), 'lite-ide-browser-smoke-'))
const browsers = new BrowserService(directory, {
  command: require('electron'),
  cli: join(dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js'),
})
const client = new CodexClient()
let threadId
try {
  const check = await browsers.check({ browser: 'chrome' })
  assert.equal(check.ok, true, check.message)
  await client.start()
  for (const browser of ['chrome', 'disabled']) {
    const { thread } = await client.request('thread/start', {
      cwd: directory, ephemeral: true, approvalPolicy: 'never', sandbox: 'danger-full-access',
      config: browsers.config({ browser }, directory),
    })
    threadId = thread.id
    const status = await client.request('mcpServerStatus/list', { threadId, serverName: browserServerName })
    const server = status.data.find((item) => item.name === browserServerName)
    assert.ok(server)
    if (browser === 'disabled') assert.equal(Object.keys(server.tools).length, 0)
    else {
      assert.equal(server.runtimeStatus, 'connected', server.toolsError)
      assert.ok(server.tools.browser_navigate)
      const result = await client.request('mcpServer/tool/call', {
        threadId, server: browserServerName, tool: 'browser_navigate', arguments: { url: 'about:blank' },
      })
      assert.ok(!result.isError, JSON.stringify(result))
      await client.request('mcpServer/tool/call', {
        threadId, server: browserServerName, tool: 'browser_close', arguments: {},
      })
    }
    await client.request('thread/unsubscribe', { threadId })
    threadId = undefined
  }
  console.log('브라우저 실연결 검증 통과: Electron Node 런타임, Chrome 백그라운드 실행, Codex daemon의 도구 등록·실제 호출·사용 안 함. 모델 사용량 없음.')
} finally {
  if (threadId) await client.request('thread/unsubscribe', { threadId }).catch(() => {})
  client.stop()
  await rm(directory, { recursive: true, force: true })
}
