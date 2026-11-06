import { useCallback, useEffect, useRef, useState } from 'react'
import { Activity, ChevronDown, ChevronRight, RefreshCw, Square } from 'lucide-react'
import type { ManagedProcess, WorkspaceProcessSnapshot } from '../../../shared/types'
import { Button } from './ui/button'

export function ProcessPanel({ workspace }: { workspace: string }) {
  const [expanded, setExpanded] = useState(false)
  const [snapshot, setSnapshot] = useState<WorkspaceProcessSnapshot | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [stopping, setStopping] = useState<string | null>(null)
  const [target, setTarget] = useState<ManagedProcess | null>(null)
  const request = useRef(0)
  const inFlight = useRef(false)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false; request.current++ }, [])
  const refresh = useCallback(async () => {
    if (!window.desktop.inspectProcesses || inFlight.current) return
    inFlight.current = true
    const token = ++request.current
    setLoading(true)
    try {
      const result = await window.desktop.inspectProcesses(workspace)
      if (mounted.current && token === request.current) { setSnapshot(result); setError('') }
    } catch (cause) {
      if (mounted.current && token === request.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      inFlight.current = false
      if (mounted.current && token === request.current) setLoading(false)
    }
  }, [workspace])
  useEffect(() => {
    mounted.current = true
    if (!expanded) return
    void refresh()
    const timer = setInterval(() => { if (!document.hidden) void refresh() }, 4000)
    return () => { clearInterval(timer); request.current++ }
  }, [expanded, refresh])
  async function stop(process: ManagedProcess) {
    if (!window.desktop.stopProcess || stopping) return
    setStopping(process.identity)
    setError('')
    try {
      await window.desktop.stopProcess({ workspace, taskId: process.taskId, generation: process.generation, pid: process.pid, identity: process.identity })
      if (mounted.current) { setTarget(null); await refresh() }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally { if (mounted.current) setStopping(null) }
  }
  return (
    <section className="process-panel" aria-label="워크트리 프로세스">
      <div className="process-panel-heading">
        <button aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<Activity size={13} />프로세스
          {expanded && snapshot && <span>{snapshot.processes.length}</span>}
        </button>
        {expanded && <Button variant="ghost" size="xs" disabled={loading || !!stopping} aria-label="프로세스 새로고침" onClick={() => void refresh()}><RefreshCw size={12} className={loading ? 'spinning' : ''} /></Button>}
      </div>
      {expanded && <div className="process-panel-body">
        <p className="process-scope">이 Worktree의 앱 터미널과 현재 연결된 자식 프로세스 · 4초마다 갱신. 명령 출력은 터미널·세션 탭에서 확인합니다.</p>
        {!window.desktop.inspectProcesses && <p role="status">현재 실행 환경은 프로세스 조회를 지원하지 않습니다.</p>}
        {(error || snapshot?.error) && <p className="error-message" role="alert">{error || snapshot?.error}</p>}
        {snapshot?.processes.length ? <div className="process-table-scroll"><table className="process-table">
          <thead><tr><th>PID / 부모</th><th>명령</th><th>상태</th><th>관리</th></tr></thead>
          <tbody>{snapshot.processes.map((process) => <tr key={`${process.taskId}-${process.pid}-${process.identity}`}>
            <td title={`시작: ${process.startedAt}`}><strong>{process.pid}</strong><small>{process.root ? '터미널' : `↳ ${process.ppid}`}</small></td>
            <td><code title={process.command}>{process.command}</code></td>
            <td>{process.state}</td>
            <td><Button variant="ghost" size="xs" disabled={!process.canStop || !!stopping} aria-label={`프로세스 ${process.pid} 종료`} onClick={() => setTarget(process)}><Square size={11} />종료</Button></td>
          </tr>)}</tbody>
        </table></div> : <p className="process-empty">{loading ? '프로세스를 조회하고 있습니다…' : '관찰 가능한 실행 프로세스가 없습니다.'}</p>}
        {target && <div className="process-confirm" role="group" aria-label="프로세스 종료 확인">
          <span>PID {target.pid}{target.root ? ' 터미널' : ''}과 하위 프로세스를 종료할까요?</span>
          <Button size="xs" variant="outline" disabled={!!stopping} onClick={() => setTarget(null)}>취소</Button>
          <Button size="xs" disabled={!!stopping} onClick={() => void stop(target)}>{stopping ? '종료 중…' : '프로세스 종료 확인'}</Button>
        </div>}
      </div>}
    </section>
  )
}
