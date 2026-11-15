import { useEffect, useRef, useState } from 'react'
import { File, FileArchive, FileCode, FileText, Image, LoaderCircle, Paperclip, RefreshCw, X } from 'lucide-react'
import type { AttachmentPreview } from '../../../shared/attachments'
import { attachmentErrorText, type AttachmentDraft, type useTerminalAttachments } from '../lib/use-terminal-attachments'
import { Button } from './ui/button'

function sizeLabel(size: number) {
  return size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`
}
function FileIcon({ name, image }: { name: string; image?: boolean }) {
  const Icon = image ? Image : /\.(zip|gz|7z|rar|tar)$/i.test(name) ? FileArchive
    : /\.(tsx?|jsx?|py|rs|go|html|css|sql|sh|json|ya?ml)$/i.test(name) ? FileCode
      : /\.(txt|md|csv|log|pdf|docx?)$/i.test(name) ? FileText : File
  return <Icon size={22} aria-hidden="true" />
}

export function AttachmentTray({ attachments, disabled, onInserted }: {
  attachments: ReturnType<typeof useTerminalAttachments>
  disabled: boolean
  onInserted: () => void
}) {
  const picker = useRef<HTMLInputElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const [preview, setPreview] = useState<AttachmentPreview | null>(null)
  const [previewError, setPreviewError] = useState('')
  const [previewLoading, setPreviewLoading] = useState(false)
  const previewVersion = useRef(0)
  const close = () => { previewVersion.current++; dialog.current?.close(); setPreview(null); setPreviewError('') }
  useEffect(() => () => { previewVersion.current++ }, [])
  const openPreview = async (draft: AttachmentDraft) => {
    if (!draft.attachment) return
    const version = ++previewVersion.current
    setPreview({ name: draft.name, size: draft.size }); setPreviewError(''); setPreviewLoading(true)
    dialog.current?.showModal()
    try {
      const value = await window.desktop.previewAttachment(draft.target, draft.attachment.id)
      if (version === previewVersion.current) setPreview(value)
    } catch (cause) { if (version === previewVersion.current) setPreviewError(attachmentErrorText(cause)) }
    finally { if (version === previewVersion.current) setPreviewLoading(false) }
  }
  return (
    <section className="attachment-area" aria-label="파일 첨부">
      {attachments.drafts.length > 0 && <div className="attachment-list" role="list" aria-label="전송 대기 첨부 파일">
        {attachments.drafts.map((draft) => <div className={`attachment-card ${draft.phase}`} key={draft.id} role="listitem">
          <button type="button" className="attachment-open" aria-label={`${draft.name} 미리보기`}
            disabled={draft.phase !== 'ready' || attachments.busy} onClick={() => void openPreview(draft)}>
            {draft.attachment?.thumbnail ? <img src={draft.attachment.thumbnail} alt="" className="attachment-thumb" />
              : <span className="attachment-file-icon"><FileIcon name={draft.name} image={draft.attachment?.kind === 'image'} /></span>}
            <span className="attachment-description"><strong title={draft.name}>{draft.name}</strong>
              <small>{sizeLabel(draft.size)} · {draft.phase === 'loading' ? '준비 중' : draft.phase === 'error' ? '추가 실패' : '전송 대기'}</small>
            </span>
            {draft.phase === 'loading' && <LoaderCircle size={12} className="spinning" aria-hidden="true" />}
          </button>
          <button type="button" className="attachment-remove" aria-label={`${draft.name} 첨부 제거`} disabled={attachments.busy}
            onClick={() => void attachments.remove(draft.id).then(onInserted)}><X size={12} /></button>
          {draft.phase === 'error' && <div className="attachment-retry"><span role="alert" title={draft.error}>{draft.error}</span>
            {draft.file && <button type="button" aria-label={`${draft.name} 첨부 재시도`} onClick={() => attachments.retry(draft.id)}><RefreshCw size={12} /></button>}
          </div>}
        </div>)}
      </div>}
      <div className="attachment-tools">
        <input type="file" ref={picker} multiple hidden aria-label="첨부할 파일 선택" onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; void attachments.addFiles(files).then(onInserted)
        }} />
        <Button type="button" variant="ghost" size="xs" disabled={disabled || attachments.busy} onClick={() => picker.current?.click()}>
          <Paperclip size={13} />파일 첨부
        </Button>
        <span className="attachment-hint" title="최대 20개 · 파일당 50MB · 합계 100MB. 이미지는 이미지로, 그 외 파일은 참조 경로로 전달합니다.">
          {attachments.notice || (attachments.drafts.length ? `${attachments.drafts.length}개 · Enter로 요청과 함께 전송` : '파일을 끌어 놓거나 이미지를 붙여넣으세요.')}
        </span>
        {attachments.drafts.length > 0 && <>
          <Button type="button" variant="ghost" size="xs" disabled={attachments.busy} onClick={() => {
            for (const draft of attachments.drafts) void attachments.remove(draft.id)
          }}>모두 제거</Button>
          <Button type="button" variant="outline" size="xs" disabled={disabled || attachments.busy || attachments.drafts.some((draft) => draft.phase !== 'ready')}
            onClick={() => void attachments.insert().then((ok) => { if (ok) onInserted() })}>{attachments.busy ? '전달 중…' : '입력에 추가'}</Button>
        </>}
      </div>
      {attachments.error && <div className="attachment-error" role="alert"><span>{attachments.error}</span>
        <button type="button" aria-label="첨부 오류 닫기" onClick={() => attachments.setError('')}><X size={12} /></button>
      </div>}
      <dialog ref={dialog} className="attachment-preview" aria-label="첨부 파일 미리보기" onCancel={close}>
        <header><div><strong>{preview?.name}</strong><small>{preview && sizeLabel(preview.size)}</small></div>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="첨부 미리보기 닫기" onClick={close}><X /></Button>
        </header>
        <div className="attachment-preview-body">
          {previewLoading ? <p role="status">미리보기를 불러오는 중…</p> : previewError ? <p role="alert">{previewError}</p>
            : preview?.image ? <img src={preview.image} alt={preview.name} />
              : preview?.text !== undefined ? <><pre>{preview.text || '(빈 파일)'}</pre>{preview.truncated && <p>미리보기에는 앞부분만 표시합니다. 원본 파일 전체가 전달됩니다.</p>}</>
                : <p>이 형식은 미리보기를 지원하지 않습니다. 파일은 요청에 첨부할 수 있습니다.</p>}
        </div>
      </dialog>
    </section>
  )
}
