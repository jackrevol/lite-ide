import { useEffect, useRef, useState } from 'react'
import { CloudDownload, Crosshair, GitFork, RefreshCw, X } from 'lucide-react'
import type { Project, RepositoryOverview } from '../../../shared/types'
import { RepositoryGraph } from './RepositoryGraph'
import { Button } from './ui/button'
import './RepositoryTreeDialog.css'

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)

export function RepositoryTreeDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [overview, setOverview] = useState<RepositoryOverview | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  const [selectedRef, setSelectedRef] = useState('')
  const [focusRequest, setFocusRequest] = useState(0)
  const [fetching, setFetching] = useState(false)
  const [query, setQuery] = useState('')
  useEffect(() => { dialog.current?.showModal() }, [])
  useEffect(() => {
    let disposed = false
    let pending = false
    const inspect = async () => {
      if (pending) return
      pending = true
      setLoading(true)
      try {
        const result = await window.desktop.inspectRepositoryOverview(project.path)
        if (!disposed) { setOverview(result); setError('') }
      } catch (cause) { if (!disposed) setError(message(cause)) }
      finally { pending = false; if (!disposed) setLoading(false) }
    }
    void inspect()
    const timer = setInterval(() => { if (!document.hidden) void inspect() }, 10000)
    return () => { disposed = true; clearInterval(timer) }
  }, [project.path, revision])
  async function refreshRemotes() {
    setFetching(true)
    try {
      await window.desktop.refreshRepositoryRemotes(project.path)
      setError('')
      setRevision((value) => value + 1)
    } catch (cause) { setError(message(cause)) }
    finally { setFetching(false) }
  }
  function locate(ref: string) {
    setSelectedRef(ref)
    setFocusRequest((value) => value + 1)
  }
  const selected = overview?.branches.find((branch) => branch.ref === selectedRef)
  return <dialog ref={dialog} className="repository-tree-dialog" aria-labelledby="repository-tree-title" onCancel={onClose}>
    <header className="repository-tree-heading">
      <div><h2 id="repository-tree-title"><GitFork size={18} />{project.name} · Git 트리</h2><p title={project.path}>{project.path}</p></div>
      <Button variant="outline" size="xs" aria-label="원격 브랜치 갱신" disabled={fetching} onClick={() => void refreshRemotes()}><CloudDownload size={14} className={fetching ? 'spinning' : ''} />{fetching ? '원격 조회 중…' : '원격 갱신'}</Button>
      <Button variant="ghost" size="icon-sm" aria-label="Git 트리 새로고침" disabled={loading} onClick={() => setRevision((value) => value + 1)}><RefreshCw size={15} className={loading ? 'spinning' : ''} /></Button>
      <Button variant="ghost" size="icon-sm" aria-label="Git 트리 닫기" onClick={onClose}><X size={17} /></Button>
    </header>
    <div className="repository-tree-toolbar">
      <label>브랜치 위치<select aria-label="위치를 추적할 브랜치" value={selectedRef} onChange={(event) => locate(event.target.value)}>
        <option value="">브랜치 선택…</option>
        {(['local', 'remote'] as const).map((kind) => <optgroup label={kind === 'local' ? '로컬' : '원격'} key={kind}>
          {overview?.branches.filter((branch) => branch.kind === kind).map((branch) => <option key={branch.ref} value={branch.ref}>{branch.name}</option>)}
        </optgroup>)}
        {selectedRef && !selected && <option value={selectedRef}>삭제된 브랜치</option>}
      </select></label>
      <Button variant="outline" size="xs" aria-label="선택 브랜치로 이동" disabled={!selected} onClick={() => locate(selectedRef)}><Crosshair size={13} />위치로 이동</Button>
      <input aria-label="브랜치 검색" placeholder="브랜치 이름 찾기…" value={query} onChange={(event) => setQuery(event.target.value)} />
      <span>로컬 {overview?.branches.filter((branch) => branch.kind === 'local').length ?? 0} · 원격 {overview?.branches.filter((branch) => branch.kind === 'remote').length ?? 0} · Worktree {overview?.workspaces.length ?? 0}</span>
    </div>
    <p className="repository-tracking-status" role="status" aria-live="polite">
      {selected ? `${selected.kind === 'remote' ? '원격' : '로컬'} · ${selected.name} 위치 추적 중 · 브랜치가 이동하면 새 위치를 따라갑니다.`
        : selectedRef ? '선택한 브랜치가 삭제되었습니다. 다른 브랜치를 선택해 주세요.' : '브랜치를 선택하면 그래프에서 해당 위치로 이동합니다.'}
    </p>
    {error && <p className="error-message" role="alert">{error}</p>}
    {loading && !overview && <p className="repository-tree-empty" role="status">전체 브랜치를 확인하고 있습니다…</p>}
    {overview && <section className="repository-history" aria-label="커밋 연결 관계">
      <RepositoryGraph overview={overview} query={query} selectedRef={selectedRef} focusRequest={focusRequest} onSelect={locate} />
    </section>}
  </dialog>
}
