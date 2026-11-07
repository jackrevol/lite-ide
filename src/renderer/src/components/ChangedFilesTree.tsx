import { useRef, useState } from 'react'
import { ChevronDown, ChevronRight, FileCode2, Folder, FolderOpen } from 'lucide-react'
import type { ChangedFile } from '../../../shared/types'
import { buildFileTree, type FileTreeNode } from '../lib/file-tree'

export function ChangedFilesTree({ files, query, workspace, selected, onSelect }: {
  files: ChangedFile[]
  query: string
  workspace: string
  selected: string
  onSelect: (path: string) => void
}) {
  const [collapsed, setCollapsed] = useState<Record<string, string[]>>({})
  const tree = useRef<HTMLUListElement>(null)
  const nodes = buildFileTree(files, query)
  const toggle = (path: string, close?: boolean) => setCollapsed((previous) => {
    const paths = previous[workspace] ?? []
    return { ...previous, [workspace]: (close ?? !paths.includes(path))
      ? [...new Set([...paths, path])] : paths.filter((item) => item !== path) }
  })
  const render = (node: FileTreeNode, depth: number) => {
    const expanded = !!query || !(collapsed[workspace] ?? []).includes(node.path)
    return <li key={node.path} role="none">
      <button role="treeitem" className={`file-row ${node.file ? '' : 'folder-row'} ${node.file && selected === node.path ? 'selected' : ''}`}
        style={{ paddingLeft: 12 + depth * 15 }} title={node.path} aria-label={node.path}
        aria-expanded={node.file ? undefined : expanded} aria-selected={node.file ? selected === node.path : undefined}
        onClick={() => node.file ? onSelect(node.path) : toggle(node.path)}
        onKeyDown={(event) => {
          if (!node.file && ['ArrowRight', 'ArrowLeft'].includes(event.key)) {
            event.preventDefault()
            toggle(node.path, event.key === 'ArrowLeft')
          }
          const items = [...tree.current?.querySelectorAll<HTMLButtonElement>('[role="treeitem"]') ?? []]
          const index = items.indexOf(event.currentTarget)
          const next = event.key === 'ArrowDown' ? index + 1 : event.key === 'ArrowUp' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1
          if (next >= 0 && next < items.length) { event.preventDefault(); items[next].focus() }
        }}>
        {node.file ? <><span className="tree-chevron" /><FileCode2 size={14} /></> : <>{expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}{expanded ? <FolderOpen size={14} /> : <Folder size={14} />}</>}
        <span className="tree-name">{node.name}</span>
        {node.file && <span className={`file-status ${node.file.status.includes('D') ? 'deleted' : /[?A]/.test(node.file.status) ? 'added' : ''}`}>{node.file.status.trim() === '??' ? 'U' : node.file.status.trim()}</span>}
      </button>
      {!node.file && expanded && <ul role="group">{node.children.map((child) => render(child, depth + 1))}</ul>}
    </li>
  }
  return nodes.length ? <ul className="file-tree" role="tree" aria-label="변경 파일 트리" ref={tree}>{nodes.map((node) => render(node, 0))}</ul>
    : <p className="search-empty">검색 결과가 없습니다.</p>
}
