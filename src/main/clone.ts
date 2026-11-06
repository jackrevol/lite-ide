import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, realpath, rm } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

const execute = promisify(execFile)

export function validateCloneInput(url: string, name: string) {
  if (
    typeof url !== 'string' ||
    !url.trim() ||
    url.length > 2048 ||
    /[\s\x00-\x1f]/.test(url)
  )
    throw new Error('올바른 Git 저장소 URL을 입력해 주세요.')
  const scp = /^[\w.-]+@[\w.-]+:[\w./~%-]+$/.test(url)
  if (!scp) {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error('HTTPS 또는 SSH 저장소 주소를 입력해 주세요.')
    }
    if (
      !['https:', 'http:', 'ssh:'].includes(parsed.protocol) ||
      !parsed.hostname ||
      parsed.password ||
      (parsed.protocol !== 'ssh:' && parsed.username) ||
      parsed.search ||
      parsed.hash
    )
      throw new Error(
        '인증 정보가 없는 HTTPS 또는 SSH 저장소 주소를 입력해 주세요.',
      )
  }
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name.length > 100 ||
    /[<>:"/\\|?*\x00-\x1f]/.test(name) ||
    /[. ]$/.test(name) ||
    /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name) ||
    name === '.' ||
    name === '..'
  )
    throw new Error('올바른 프로젝트 폴더 이름을 입력해 주세요.')
}

export async function cloneRepository(
  url: string,
  parent: string,
  name: string,
): Promise<string> {
  validateCloneInput(url, name)
  const root = await realpath(parent)
  const target = resolve(root, name)
  const scope = relative(root, target)
  if (!scope || scope.startsWith('..') || isAbsolute(scope))
    throw new Error('선택한 폴더 안에만 저장할 수 있습니다.')
  // 기존 폴더는 비어 있어도 덮어쓰지 않습니다.
  await mkdir(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST')
      throw new Error(
        '같은 이름의 폴더가 이미 있습니다. 다른 이름을 입력해 주세요.',
      )
    throw error
  })
  try {
    await execute(
      'git',
      ['-c', 'core.hooksPath=', 'clone', '--', url, target],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 600_000,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'Never',
          GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
        },
      },
    )
    return target
  } catch (error) {
    // 이번 요청에서 만든 경로만 정리합니다. 사용자의 기존 디렉터리는 건드리지 않습니다.
    if (relative(root, resolve(target)) === name && target !== root)
      await rm(target, { recursive: true, force: true }).catch(() => {})
    const detail = error as { stderr?: string; code?: string; killed?: boolean }
    if (detail.code === 'ENOENT')
      throw new Error('Git을 찾을 수 없습니다. Git 설치 후 다시 시도해 주세요.')
    if (detail.killed)
      throw new Error('저장소 복제 시간이 초과되었습니다. 다시 시도해 주세요.')
    throw new Error(
      `저장소를 복제하지 못했습니다. 주소와 Git 인증을 확인해 주세요.\n${(detail.stderr ?? '').trim().slice(-1500)}`,
    )
  }
}
