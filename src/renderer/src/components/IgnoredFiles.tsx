import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, FileCode2, Folder, FolderOpen } from 'lucide-react'
import type { ChangedFile, IgnoredDirectory } from '../../../shared/types'

interface IgnoredFilesProps {
  files: ChangedFile[]
  total: number
  workspace: string
  query: string
  selected: string
  onSelect: (path: string) => void
  refresh: number
}

function IgnoredEntry({ file, depth, ...props }: Omit<IgnoredFilesProps, 'files' | 'total'> & { file: ChangedFile; depth: number }) {
  const [expanded, setExpanded] = useState(false)
  const [pages, setPages] = useState(1)
  const [listing, setListing] = useState<IgnoredDirectory | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const directory = file.path.endsWith('/')
  useEffect(() => {
    if (!directory || !expanded) return
    let disposed = false
    setLoading(true)
    void (async () => {
      const entries: ChangedFile[] = []
      let result: IgnoredDirectory
      for (let page = 0; page < pages; page++) {
        result = await window.desktop.readIgnoredDirectory(props.workspace, file.path, page * 200)
        entries.push(...result.entries)
        if (!result.hasMore) break
      }
      if (!disposed) { setListing({ entries, hasMore: result!.hasMore }); setError('') }
    })().catch((cause) => {
      if (!disposed) setError(cause instanceof Error ? cause.message : String(cause))
    }).finally(() => { if (!disposed) setLoading(false) })
    return () => { disposed = true }
  }, [directory, expanded, pages, file.path, props.workspace, props.refresh])
  if (!directory && !file.path.toLowerCase().includes(props.query.toLowerCase())) return null
  return <li>
    <button className={`file-row ignored-row ${!directory && props.selected === file.path ? 'selected' : ''}`}
      style={{ paddingLeft: 12 + depth * 15 }} title={file.path} aria-label={file.path}
      aria-expanded={directory ? expanded : undefined}
      onClick={() => directory ? setExpanded((value) => !value) : props.onSelect(file.path)}>
      {directory ? <>{expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}{expanded ? <FolderOpen size={14} /> : <Folder size={14} />}</> : <><span className="tree-chevron" /><FileCode2 size={14} /></>}
      <span className="tree-name">{depth ? file.path.replace(/\/$/, '').split('/').at(-1) : file.path}</span><span className="file-status ignored">!!</span>
    </button>
    {directory && expanded && <ul>
      {listing?.entries.map((child) => <IgnoredEntry key={child.path} {...props} file={child} depth={depth + 1} />)}
      {loading && <li className="ignored-note" role="status">폴더 확인 중…</li>}
      {error && <li className="ignored-note" role="alert">{error}</li>}
      {!loading && !error && listing?.entries.length === 0 && <li className="ignored-note">빈 폴더입니다.</li>}
      {listing?.hasMore && <li><button className="ignored-more" disabled={loading} onClick={() => setPages((value) => value + 1)}>다음 200개 표시</button></li>}
    </ul>}
  </li>
}

export function IgnoredFiles({ files, total, ...props }: IgnoredFilesProps) {
  return <section className="ignored-files" aria-label="Git 무시 파일">
    <h3>무시된 파일·폴더 <span className="count">{total}</span></h3>
    <p className="ignored-note">Git 비교 기준이 없어 파일 전체를 표시합니다. 폴더는 펼칠 때 읽으며, 검색은 읽은 경로에 적용됩니다.</p>
    <ul className="file-tree">{files.map((file) => <IgnoredEntry key={file.path} {...props} file={file} depth={0} />)}</ul>
    {total > files.length && <p className="file-limit">{files.length} / {total}개 항목 표시</p>}
  </section>
}
