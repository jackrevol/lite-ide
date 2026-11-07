import { LoaderCircle, X } from 'lucide-react'

export function DiffView({ path, diff, loading, onClose }: { path: string; diff: string; loading: boolean; onClose: () => void }) {
  return <section className="diff-preview main-diff" aria-label="파일 변경 내용">
    <div className="diff-heading"><span title={path}>{path}</span><button aria-label="변경 내용 닫기" onClick={onClose}><X size={14} /></button></div>
    {loading ? <div className="panel-empty"><LoaderCircle size={18} className="spinning" /></div> : <pre>{diff.split('\n').map((line, index) => <div key={index} className={line.startsWith('+') && !line.startsWith('+++') ? 'diff-add' : line.startsWith('-') && !line.startsWith('---') ? 'diff-remove' : line.startsWith('@@') ? 'diff-hunk' : ''}><span className="line-number">{index + 1}</span>{line || ' '}</div>)}</pre>}
  </section>
}
