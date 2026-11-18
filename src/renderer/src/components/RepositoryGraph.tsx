import { useEffect, useRef, useState } from 'react'
import { Cloud, Minus, Plus } from 'lucide-react'
import type { RepositoryOverview } from '../../../shared/types'
import { buildCommitGraph } from '../lib/commit-graph'
import { Button } from './ui/button'

export function RepositoryGraph({ overview, query, selectedRef, focusRequest, onSelect }: {
  overview: RepositoryOverview
  query: string
  selectedRef: string
  focusRequest: number
  onSelect: (ref: string) => void
}) {
  const viewport = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)
  const minimumZoom = .05
  const selected = overview.branches.find((branch) => branch.ref === selectedRef)
  const workspaceNodes = overview.workspaces.map((workspace) => ({
    hash: `workspace:${workspace.path}`, parents: workspace.commit ? [workspace.commit] : [], subject: '',
  }))
  const rows = buildCommitGraph([...workspaceNodes, ...overview.commits])
  const width = Math.max(64, ...rows.map((row) => row.width * 24 + 24))
  const selectedRow = rows.findIndex((row) => row.commit.hash === selected?.commit)
  const needle = query.trim().toLowerCase()
  useEffect(() => {
    if (!selected) return
    setZoom((value) => Math.max(.9, value))
    // 확대 후 배치가 확정되면 선택한 라벨을 그래프 안의 중앙으로 이동합니다.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const element = viewport.current
        const target = [...element?.querySelectorAll<HTMLElement>('[data-branch-ref]') ?? []]
          .find((node) => node.dataset.branchRef === selectedRef)
        if (!element || !target) return
        const boundary = element.getBoundingClientRect(), position = target.getBoundingClientRect()
        element.scrollTo({
          left: element.scrollLeft + position.left - boundary.left - (element.clientWidth - position.width) / 2,
          top: element.scrollTop + position.top - boundary.top - (element.clientHeight - position.height) / 2,
          behavior: 'instant',
        })
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [selectedRef, selected?.commit, selectedRow, width, focusRequest])
  function fit() {
    const element = viewport.current
    const content = element?.firstElementChild as HTMLElement | null
    if (!element || !content) return
    setZoom(Math.max(minimumZoom, Math.min(1, element.clientWidth / content.scrollWidth, element.clientHeight / content.scrollHeight)))
  }
  return <>
    <div className="repository-graph-heading">
      <div><h3>전체 브랜치 트리</h3><p>로컬 · 원격 · 모든 Worktree</p></div>
      <Button variant="ghost" size="icon-sm" aria-label="그래프 축소" disabled={zoom <= minimumZoom} onClick={() => setZoom(Math.max(minimumZoom, zoom - .15))}><Minus size={13} /></Button>
      <Button variant="ghost" size="icon-sm" aria-label="그래프 확대" disabled={zoom >= 1.6} onClick={() => setZoom(Math.min(1.6, zoom + .15))}><Plus size={13} /></Button>
      <Button variant="ghost" size="xs" onClick={fit}>전체 맞춤</Button>
    </div>
    <div className="repository-graph-viewport" ref={viewport} aria-label="모든 브랜치 그래프" data-tracked-ref={selected?.ref} data-tracked-commit={selected?.commit}>
      <div className="repository-commit-list" style={{ zoom }}>
        {rows.map(({ commit, column, incoming, lines }) => {
          const workspace = overview.workspaces.find((tree) => `workspace:${tree.path}` === commit.hash)
          const refs = overview.branches.filter((branch) => branch.commit === commit.hash)
          const matches = !!needle && [...refs.map((branch) => branch.name), workspace?.branch].some((name) => name?.toLowerCase().includes(needle))
          const active = selected?.commit === commit.hash
          return <div className={`repository-commit ${workspace ? 'workspace-node' : ''} ${active ? 'selected' : ''} ${matches ? 'search-match' : ''}`}
            key={commit.hash} data-commit={commit.hash} data-workspace={workspace?.path}>
            <svg width={width} height={40} aria-hidden="true">
              {lines.map((line, index) => <path key={index} d={`M ${20 + line.from * 24} ${line.parent ? 20 : 0} C ${20 + line.from * 24} 29, ${20 + line.to * 24} 29, ${20 + line.to * 24} 40`}
                fill="none" stroke={`var(--graph-${line.from % 4})`} strokeWidth={2} strokeDasharray={workspace && line.parent ? '4 3' : undefined} />)}
              {incoming && <path d={`M ${20 + column * 24} 0 V 20`} stroke={`var(--graph-${column % 4})`} strokeWidth={2} />}
              {active && <circle className="repository-location-ring" cx={20 + column * 24} cy={20} r={10} fill="none" stroke="var(--graph-focus)" strokeWidth={2} />}
              {workspace ? <rect x={16 + column * 24} y={16} width={8} height={8} rx={2} fill="var(--surface)" stroke={`var(--graph-${column % 4})`} strokeWidth={2} />
                : <circle cx={20 + column * 24} cy={20} r={4} fill={`var(--graph-${column % 4})`} />}
            </svg>
            <div className="repository-node-refs">
              {refs.map((branch) => <button key={branch.ref} data-branch-ref={branch.ref} aria-pressed={selectedRef === branch.ref}
                className={`repository-ref ${branch.kind}`} onClick={() => onSelect(branch.ref)} title={`${branch.kind === 'remote' ? '원격' : '로컬'} · ${branch.name}`}>
                {branch.kind === 'remote' && <Cloud size={11} />}{branch.name}
              </button>)}
              {workspace && <span className="repository-tree-ref">{workspace.main ? '로컬' : 'Worktree'} · {workspace.branch}<small>{workspace.error ? '조회 실패' : `변경 ${workspace.totalChanges}`}</small></span>}
            </div>
          </div>
        })}
      </div>
      {!rows.length && <p className="repository-tree-empty">아직 커밋이 없습니다.</p>}
    </div>
    <p className="repository-graph-legend"><span>● 분기 · 병합</span><span>□ 로컬 · Worktree 작업</span><span>10초마다 갱신 · 원격은 마지막 fetch 기준</span></p>
  </>
}
