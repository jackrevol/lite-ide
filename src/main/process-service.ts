import { execFile } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import type {
  ManagedProcess,
  StopProcessInput,
  WorkspaceProcessSnapshot,
} from '../shared/types.ts'

export interface ProcessRecord {
  pid: number
  ppid: number
  command: string
  identity: string
  startedAt: string
  state: string
}

export interface TerminalProcessRoot {
  taskId: string
  generation: string
  workspace: string
  pid: number
}

type ProcessSource = () => Promise<ProcessRecord[]>
type ProcessKiller = (record: ProcessRecord) => Promise<void>

// PID는 재사용되므로 최초 생성 시각과 현재 부모 관계를 함께 확인합니다.
export class ProcessService {
  private identities = new Map<string, string>()
  private read: ProcessSource
  private kill: ProcessKiller

  constructor(
    read: ProcessSource = readSystemProcesses,
    kill: ProcessKiller = terminateProcess,
  ) {
    this.read = read
    this.kill = kill
  }

  async register(root: TerminalProcessRoot) {
    const record = (await this.read()).find((row) => row.pid === root.pid)
    if (record?.identity) this.identities.set(root.generation, record.identity)
  }

  forget(generation: string) {
    this.identities.delete(generation)
  }

  private owned(
    roots: TerminalProcessRoot[],
    records: ProcessRecord[],
  ): ManagedProcess[] {
    const result: ManagedProcess[] = []
    for (const root of roots) {
      const record = records.find((row) => row.pid === root.pid)
      const identity = this.identities.get(root.generation)
      if (!record || !identity || record.identity !== identity) continue
      const descendants = descendantsOf(root.pid, records)
      for (const row of [record, ...descendants]) {
        result.push({
          ...row,
          taskId: root.taskId,
          generation: root.generation,
          workspace: root.workspace,
          root: row.pid === root.pid,
          canStop: !!row.identity,
        })
      }
    }
    return result
  }

  async inspect(
    workspace: string,
    roots: TerminalProcessRoot[],
  ): Promise<WorkspaceProcessSnapshot> {
    if (!roots.length)
      return { workspace, observedAt: Date.now(), scope: 'terminal-descendants', processes: [] }
    try {
      const records = await this.read()
      const processes = this.owned(roots, records)
      const missing = roots.some((root) => !processes.some((row) => row.generation === root.generation && row.root))
      return {
        workspace,
        observedAt: Date.now(),
        scope: 'terminal-descendants',
        processes,
        ...(missing ? { error: '일부 터미널의 프로세스 생성 시각을 확인할 수 없습니다. 다시 연결해 주세요.' } : {}),
      }
    } catch (error) {
      return {
        workspace,
        observedAt: Date.now(),
        scope: 'terminal-descendants',
        processes: [],
        error: `프로세스를 확인할 수 없습니다: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  async stop(
    roots: () => TerminalProcessRoot[],
    input: StopProcessInput,
    stopRoot: () => Promise<void>,
  ) {
    if (!Number.isSafeInteger(input.pid) || input.pid <= 0 || typeof input.identity !== 'string' || !input.identity)
      throw new Error('올바른 프로세스를 선택해 주세요.')
    const currentRoots = roots()
    const owner = currentRoots.find((root) => root.taskId === input.taskId && root.generation === input.generation && root.workspace === input.workspace)
    if (!owner) throw new Error('터미널이 변경되었거나 종료되었습니다. 목록을 새로 고쳐 주세요.')
    const records = await this.read()
    const selected = this.owned([owner], records).find((row) => row.pid === input.pid && row.identity === input.identity)
    if (!selected) throw new Error('이 터미널 소유의 실행 중인 프로세스가 아닙니다. 목록을 새로 고쳐 주세요.')
    const targets = descendantsOf(selected.pid, records).reverse()
    if (!selected.root) targets.push(selected)
    for (const target of targets) {
      // 중단 직전 다시 읽어 PID 재사용, 부모 변경, 터미널 재연결을 거부합니다.
      const activeOwner = roots().find((root) => root.taskId === owner.taskId && root.generation === owner.generation && root.pid === owner.pid)
      if (!activeOwner) throw new Error('터미널이 변경되었거나 종료되었습니다.')
      const current = this.owned([activeOwner], await this.read())
      const live = current.find((row) => row.pid === target.pid && row.identity === target.identity)
      if (!live) continue
      const selectedLive = current.find((row) => row.pid === selected.pid && row.identity === selected.identity)
      if (!selectedLive) throw new Error('선택한 프로세스가 종료되었거나 변경되었습니다.')
      if (live.pid !== selected.pid && !descendantsOf(selected.pid, current).some((row) => row.pid === live.pid)) continue
      if (!roots().some((root) => root.generation === owner.generation && root.pid === owner.pid))
        throw new Error('터미널이 변경되었거나 종료되었습니다.')
      await this.kill(live)
    }
    if (selected.root) {
      const active = roots().some((root) => root.generation === owner.generation && root.pid === owner.pid)
      if (!active) throw new Error('터미널이 변경되었거나 종료되었습니다.')
      const live = this.owned([owner], await this.read()).some((row) => row.pid === selected.pid && row.identity === selected.identity)
      if (live) await stopRoot()
    }
  }

  async stopDescendants(root: TerminalProcessRoot, roots: () => TerminalProcessRoot[]) {
    const identity = this.identities.get(root.generation)
    if (!identity) throw new Error('터미널 프로세스의 소유권을 확인할 수 없어 삭제를 중단했습니다. 다시 연결해 주세요.')
    const targets = this.owned([root], await this.read()).filter((row) => !row.root)
    await this.stop(roots, { ...root, identity }, async () => {})
    // 종료 신호 전송만으로는 cwd 핸들이 해제되지 않습니다. 재부모화된 자손도 기다립니다.
    const deadline = Date.now() + 5000
    while (targets.length) {
      const records = await this.read()
      if (!targets.some((target) => records.some((row) =>
        row.pid === target.pid && row.identity === target.identity && !row.state.startsWith('Z'),
      ))) return
      if (Date.now() >= deadline)
        throw new Error('터미널 자식 프로세스가 아직 종료되지 않아 삭제를 중단했습니다. 다시 시도해 주세요.')
      await delay(100)
    }
  }
}

export function descendantsOf(pid: number, records: ProcessRecord[]): ProcessRecord[] {
  const found: ProcessRecord[] = []
  const visited = new Set([pid])
  const queue = [pid]
  for (let index = 0; index < queue.length; index++) {
    for (const row of records) {
      if (row.ppid !== queue[index] || visited.has(row.pid)) continue
      const parent = records.find((record) => record.pid === row.ppid)
      // 부모 PID가 재사용된 경우 이전 프로세스의 자식을 현재 터미널에 귀속하지 않습니다.
      if (parent && Date.parse(row.startedAt) < Date.parse(parent.startedAt)) continue
      visited.add(row.pid)
      queue.push(row.pid)
      found.push(row)
    }
  }
  return found
}

function run(file: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 8000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, LC_ALL: 'C' },
      },
      (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout)
      },
    )
  })
}

export async function readSystemProcesses(): Promise<ProcessRecord[]> {
  if (process.platform === 'win32') {
    const output = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); @(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; command = $(if ($_.CommandLine) { $_.CommandLine } else { $_.Name }); identity = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' }); startedAt = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' }); state = 'running' } }) | ConvertTo-Json -Compress"])
    const parsed: unknown = JSON.parse(output.replace(/^\uFEFF/, '').trim() || '[]')
    return (Array.isArray(parsed) ? parsed : [parsed]).filter(isProcessRecord)
  }
  return parsePs(await run('/bin/ps', ['-axww', '-o', 'pid=,ppid=,lstart=,stat=,command=']))
}

function isProcessRecord(value: unknown): value is ProcessRecord {
  if (!value || typeof value !== 'object') return false
  const row = value as ProcessRecord
  return Number.isSafeInteger(row.pid) && row.pid > 0 && Number.isSafeInteger(row.ppid) &&
    typeof row.command === 'string' && typeof row.identity === 'string' && typeof row.startedAt === 'string' && typeof row.state === 'string'
}

export function parsePs(output: string): ProcessRecord[] {
  const result: ProcessRecord[] = []
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(\S+)\s+(.+)$/)
    if (!match) continue
    const startedAt = match[3].replace(/\s+/g, ' ')
    result.push({ pid: Number(match[1]), ppid: Number(match[2]), identity: startedAt, startedAt, state: match[4], command: match[5] })
  }
  return result
}

async function terminateProcess(record: ProcessRecord) {
  if (process.platform === 'win32') {
    // 생성 시각은 OS에서 읽은 ISO 문자열만 허용하며 명령줄 문자열을 실행하지 않습니다.
    if (!/^[\dT:.Z+-]+$/.test(record.identity)) throw new Error('프로세스 생성 시각이 올바르지 않습니다.')
    await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${record.pid}'; if ($p -and $p.CreationDate.ToUniversalTime().ToString('o') -eq '${record.identity}') { $r = Invoke-CimMethod -InputObject $p -MethodName Terminate; if ($r.ReturnValue -ne 0) { throw '프로세스를 종료할 수 없습니다.' } }`])
  } else {
    try {
      process.kill(record.pid, 'SIGTERM')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
}
