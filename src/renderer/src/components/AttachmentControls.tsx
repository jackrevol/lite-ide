import { useRef } from 'react'
import { LoaderCircle, Paperclip, RefreshCw, X } from 'lucide-react'
import type { useTerminalAttachments } from '../lib/use-terminal-attachments'
import { Button } from './ui/button'
import './AttachmentControls.css'

export function AttachmentControls({ attachments, disabled, onInserted }: {
  attachments: ReturnType<typeof useTerminalAttachments>
  disabled: boolean
  onInserted: () => void
}) {
  const picker = useRef<HTMLInputElement>(null)
  const loading = attachments.drafts.filter((draft) => draft.phase === 'loading').length
  const failures = attachments.drafts.filter((draft) => draft.phase === 'error')
  const references = attachments.drafts.flatMap((draft) => draft.phase === 'ready' && draft.attachment ? [draft.attachment] : [])
  return <section className="attachment-area" aria-label="파일 첨부" aria-busy={attachments.busy || loading > 0}>
    <div className="attachment-tools">
      <input type="file" ref={picker} multiple hidden aria-label="첨부할 파일 선택" onChange={(event) => {
        const files = Array.from(event.currentTarget.files ?? [])
        event.currentTarget.value = ''
        void attachments.addFiles(files).then(onInserted)
      }} />
      <Button type="button" variant="ghost" size="xs" title="파일·이미지 첨부 · 파일당 50MB · 합계 100MB · 최대 20개"
        disabled={disabled || attachments.busy} onClick={() => picker.current?.click()}><Paperclip size={13} />파일 첨부</Button>
      {references.length > 0 && <ul className="attachment-references" aria-label="첨부 번호와 파일명">
        {references.map((file) => <li key={file.id} title={`${file.reference} ${file.name}`}>
          <span className="attachment-reference">{file.reference}</span>{' '}<span className="attachment-filename">{file.name}</span>
        </li>)}
      </ul>}
      {loading > 0 && <span className="attachment-progress" role="status"><LoaderCircle size={12} className="spinning" aria-hidden="true" />{loading}개 파일 준비 중…</span>}
      {attachments.notice && <span className="attachment-notice" role="status">{attachments.notice}</span>}
    </div>
    {failures.map((draft) => <div className="attachment-error" role="alert" key={draft.id}>
      <span>{draft.name}: {draft.error}</span>
      {(draft.file || draft.attachment) && <Button type="button" variant="ghost" size="icon-xs" aria-label={`${draft.name} 첨부 재시도`}
        disabled={disabled || attachments.busy} onClick={() => attachments.retry(draft.id)}><RefreshCw size={12} /></Button>}
      <Button type="button" variant="ghost" size="icon-xs" aria-label={`${draft.name} 첨부 취소`} disabled={disabled || attachments.busy}
        onClick={() => void attachments.remove(draft.id).then(onInserted)}><X size={12} /></Button>
    </div>)}
    {attachments.error && <div className="attachment-error" role="alert"><span>{attachments.error}</span>
      <Button type="button" variant="ghost" size="icon-xs" aria-label="첨부 오류 닫기" onClick={() => attachments.setError('')}><X size={12} /></Button>
    </div>}
  </section>
}
