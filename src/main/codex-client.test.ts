import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolve } from 'node:path'
import { CodexClient } from './codex-client.ts'

test('Codex 초기화와 동시 RPC, 종료 중인 요청의 거절을 처리한다', async () => {
  const previousHeadless = process.env.LITE_IDE_HEADLESS
  const previousBinary = process.env.LITE_IDE_TEST_CODEX
  process.env.LITE_IDE_HEADLESS = '1'
  process.env.LITE_IDE_TEST_CODEX = resolve('scripts/fixtures/codex-server.mjs')
  const client = new CodexClient()
  try {
    const cancelled = client.start()
    const rejectedStart = assert.rejects(cancelled, /연결이 종료/)
    client.stop()
    // 취소된 이전 초기화가 새 연결을 종료하지 않아야 합니다.
    const restarted = client.start()
    await rejectedStart
    await restarted
    const cancelledAgain = client.start()
    await cancelledAgain
    client.stop()
    await assert.rejects(client.request('account/read', {}), /연결되어 있지/)
    await Promise.all([client.start(), client.start()])
    const [account, models] = await Promise.all([
      client.request<{ account: { type: string } }>('account/read', {}),
      client.request<{ data: { model: string }[] }>('model/list', {}),
    ])
    assert.equal(account.account.type, 'chatgpt')
    assert.equal(models.data[0].model, 'fixture-model')
    const pending = client.request('test/no-response', {})
    const rejected = assert.rejects(pending, /연결이 종료/)
    client.stop()
    await rejected
    await client.start()
    assert.equal(
      (await client.request<{ account: { type: string } }>('account/read', {}))
        .account.type,
      'chatgpt',
    )
  } finally {
    client.stop()
    if (previousHeadless === undefined) delete process.env.LITE_IDE_HEADLESS
    else process.env.LITE_IDE_HEADLESS = previousHeadless
    if (previousBinary === undefined) delete process.env.LITE_IDE_TEST_CODEX
    else process.env.LITE_IDE_TEST_CODEX = previousBinary
  }
})
