import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const fixture = await mkdtemp(join(tmpdir(), 'lite-ide-codex-'))
const launch = () =>
  electron.launch({
    args: [resolve('out/main/index.js')],
    env: {
      ...process.env,
      LITE_IDE_HEADLESS: '1',
      LITE_IDE_TEST_DATA: join(fixture, 'data'),
      LITE_IDE_TEST_CODEX: '',
    },
  })
let app = await launch()
async function waitForTurn(page) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const session = await page.evaluate(
      async () => (await window.desktop.listSessions())[0],
    )
    if (session && ['completed', 'failed', 'waiting'].includes(session.status))
      return session
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error('Codex 응답 대기 시간이 초과되었습니다.')
}
try {
  let page = await app.firstWindow()
  const status = await page.evaluate(() => window.desktop.codexStatus())
  console.log(
    JSON.stringify({
      connected: status.connected,
      authenticated: status.authenticated,
      models: status.models.map((model) => model.id),
      error: status.error,
    }),
  )
  assert.ok(status.connected, status.error)
  assert.ok(status.authenticated, 'Codex 로그인이 필요합니다.')
  const usage = await page.evaluate(() => window.desktop.codexUsage())
  assert.ok(usage.rateLimits)
  console.log(
    JSON.stringify({
      usageRead: true,
      buckets: Object.keys(usage.rateLimitsByLimitId ?? {}),
      resetCreditCountProvided:
        usage.rateLimitResetCredits?.availableCount != null,
      resetCreditDetailsProvided: Array.isArray(
        usage.rateLimitResetCredits?.credits,
      ),
    }),
  )
  if (process.argv.includes('--live')) {
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [directory],
      })
    }, fixture)
    const project = await page.evaluate(() => window.desktop.openProject())
    const model =
      status.models.find((entry) => entry.isDefault) ?? status.models[0]
    await page.evaluate(
      async ({ project, model }) => {
        await window.desktop.sendMessage({
          sessionId: 'live-smoke',
          workspace: project.path,
          text: 'Reply exactly LITE_IDE_OK. Do not use tools or change any files.',
          model: model.id,
          effort: model.efforts.includes('low') ? 'low' : model.defaultEffort,
        })
      },
      { project, model },
    )
    const session = await waitForTurn(page)
    assert.equal(session.status, 'completed', session.error)
    assert.match(
      session.messages
        .filter((message) => message.kind === 'assistant')
        .map((message) => message.text)
        .join('\n'),
      /LITE_IDE_OK/,
    )
    console.log('실제 Codex 모델 응답 확인 완료.')
    if (process.argv.includes('--write')) {
      await app.close()
      app = await launch()
      page = await app.firstWindow()
      await page.evaluate(() => window.desktop.listProjects())
      await page.evaluate(
        async ({ project, model }) => {
          await window.desktop.sendMessage({
            sessionId: 'live-smoke',
            workspace: project.path,
            text: 'Create only codex-smoke.txt in the working directory using apply_patch. Its content must be exactly the marker you replied in the previous turn plus a newline. Do not change other files. Reply DONE when finished.',
            model: model.id,
            effort: model.efforts.includes('low') ? 'low' : model.defaultEffort,
          })
        },
        { project, model },
      )
      const resumed = await waitForTurn(page)
      assert.equal(
        resumed.status,
        'completed',
        resumed.error ?? JSON.stringify(resumed.requests),
      )
      assert.equal(resumed.threadId, session.threadId)
      assert.equal(
        (await readFile(join(fixture, 'codex-smoke.txt'), 'utf8')).trim(),
        'LITE_IDE_OK',
      )
      console.log(
        '앱 재시작 후 실제 Codex 대화 재개·컨텍스트 유지·파일 생성 확인 완료.',
      )
    }
  }
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isVisible(),
    ),
    false,
  )
} finally {
  await app.close()
}
