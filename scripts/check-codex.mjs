import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
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
  if (process.argv.includes('--live') || process.argv.includes('--terminal')) {
    const sourceProject = join(fixture, 'project')
    await mkdir(sourceProject)
    const git = (...args) => execFileSync('git', ['-C', sourceProject, ...args], { windowsHide: true })
    git('init', '--initial-branch=main')
    await writeFile(join(sourceProject, 'README.md'), 'Codex smoke fixture\n', 'utf8')
    git('add', '.')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture')
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [directory],
      })
    }, sourceProject)
    const project = await page.evaluate(() => window.desktop.openProject())
    const worktree = await page.evaluate((project) =>
      window.desktop.createWorktree(project.path, 'task/live-smoke', 'refs/heads/main'), project,
    )
    const model = status.models.find((entry) => entry.isDefault) ?? status.models[0]
    if (process.argv.includes('--terminal')) {
      await page.evaluate(async ({ workspace, model }) => {
        await window.desktop.sendMessage({
          sessionId: 'terminal-smoke', workspace,
          text: 'Reply exactly SESSION_RESTORE_OK. Do not use tools or change any files.',
          model: model.id,
          effort: model.efforts.includes('low') ? 'low' : model.defaultEffort,
        })
      }, { workspace: worktree.path, model })
      const session = await waitForTurn(page)
      assert.equal(session.status, 'completed', session.error)
      const input = { taskId: 'terminal-smoke', workspace: worktree.path, kind: 'codex', cols: 100, rows: 30, threadId: session.threadId }
      await page.evaluate((input) => window.desktop.openTerminal(input), input)
      await new Promise((resolve) => setTimeout(resolve, 8000))
      const terminal = await page.evaluate(() => window.desktop.terminalSnapshot('terminal-smoke'))
      assert.equal(terminal.running, true, terminal.output)
      assert.doesNotMatch(terminal.output, /No saved session found|Error:/)
      const threadFile = join(fixture, 'data', 'terminal-resume.json.threads.json')
      const before = JSON.parse(await readFile(threadFile, 'utf8'))
      assert.equal(before.length, 1)
      await page.evaluate(async ({ workspace, model }) => {
        await window.desktop.sendMessage({
          sessionId: 'terminal-smoke', workspace,
          text: 'Run exactly one shell command that sleeps for 20 seconds, then reply SESSION_CONTINUED. Do not change any files.',
          model: model.id,
          effort: model.efforts.includes('low') ? 'low' : model.defaultEffort,
        })
      }, { workspace: worktree.path, model })
      const active = await page.evaluate(async () => (await window.desktop.listSessions())[0])
      assert.equal(active.status, 'running')
      // 설치 전 체크포인트를 재현하고 숨겨진 창을 재시작해 자동 연결을 확인합니다.
      await writeFile(join(fixture, 'data', 'terminal-resume.json.update.json'), JSON.stringify([input]), 'utf8')
      await app.close()
      app = await launch()
      page = await app.firstWindow()
      await page.evaluate(() => window.desktop.listProjects())
      await new Promise((resolve) => setTimeout(resolve, 5000))
      const restored = await page.evaluate(() => window.desktop.terminalSnapshot('terminal-smoke'))
      assert.equal(restored?.running, true, restored?.output)
      assert.deepEqual(JSON.parse(await readFile(threadFile, 'utf8')), before)
      const continued = await waitForTurn(page)
      assert.equal(continued.status, 'completed', continued.error)
      assert.equal(continued.turnId, active.turnId)
      assert.equal(continued.messages.filter((message) => message.kind === 'user').length, 2)
      assert.ok(continued.messages.some((message) => message.kind === 'assistant' && message.text.includes('SESSION_CONTINUED')))
      console.log('실제 Codex 실행 중 재시작·동일 세션/턴 유지·작업 완료·입력 중복 방지·터미널 자동 연결 확인 완료.')
    }
    if (process.argv.includes('--live')) {
      await page.evaluate(
        async ({ worktree, model }) => {
          await window.desktop.sendMessage({
            sessionId: 'live-smoke',
            workspace: worktree.path,
            text: 'Reply exactly LITE_IDE_OK. Do not use tools or change any files.',
            model: model.id,
            effort: model.efforts.includes('low') ? 'low' : model.defaultEffort,
          })
        },
        { worktree, model },
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
        await page.evaluate((project) => window.desktop.inspectRepository(project.path), project)
        await page.evaluate(
          async ({ worktree, model }) => {
            await window.desktop.sendMessage({
              sessionId: 'live-smoke',
              workspace: worktree.path,
              text: 'Create only codex-smoke.txt in the working directory using apply_patch. Its content must be exactly the marker you replied in the previous turn plus a newline. Do not change other files. Reply DONE when finished.',
              model: model.id,
              effort: model.efforts.includes('low') ? 'low' : model.defaultEffort,
            })
          },
          { worktree, model },
        )
        const resumed = await waitForTurn(page)
        assert.equal(
          resumed.status,
          'completed',
          resumed.error ?? JSON.stringify(resumed.requests),
        )
        assert.equal(resumed.threadId, session.threadId)
        assert.equal(
          (await readFile(join(worktree.path, 'codex-smoke.txt'), 'utf8')).trim(),
          'LITE_IDE_OK',
        )
        console.log(
          '앱 재시작 후 실제 Codex 대화 재개·컨텍스트 유지·파일 생성 확인 완료.',
        )
      }
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
