import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const script = new URL('./release.mjs', import.meta.url)
test('배포는 package.json 버전을 그대로 사용하고 실행 번호나 재실행으로 변경하지 않는다', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lite-release-version-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, 'package.json'), JSON.stringify({ version: '0.2.0' }))
  for (const run of ['1', '49', '']) {
    const output = join(directory, `output-${run}`)
    execFileSync(process.execPath, [script.pathname, 'metadata'], {
      cwd: directory,
      env: { ...process.env, GITHUB_RUN_NUMBER: run, GITHUB_OUTPUT: output },
    })
    assert.equal(await readFile(output, 'utf8'), 'version=0.2.0\ntag=v0.2.0\n')
  }
  for (const version of ['v0.2.0', '0.2.0-beta', '0.2.0\ntag=wrong', '01.2.0', 2, null]) {
    await writeFile(join(directory, 'package.json'), JSON.stringify({ version }))
    const result = spawnSync(process.execPath, [script.pathname, 'metadata'], {
      cwd: directory, encoding: 'utf8',
      env: { ...process.env, GITHUB_RUN_NUMBER: '49', GITHUB_OUTPUT: '' },
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /package.json 버전/)
  }
})
