import { useEffect, useRef, useState, type RefObject } from 'react'
import type { TerminalSnapshot } from '../../../shared/types'
import type { Attachment, AttachmentTarget } from '../../../shared/attachments'
import { maxAttachmentBytes, maxAttachmentCount, maxAttachmentTotalBytes } from '../../../shared/attachments'

export interface AttachmentDraft {
  id: string
  name: string
  size: number
  target: AttachmentTarget
  phase: 'loading' | 'ready' | 'error'
  attachment?: Attachment
  file?: File
  error?: string
}

export const attachmentErrorText = (cause: unknown) =>
  (cause instanceof Error ? cause.message : String(cause)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')

export function useTerminalAttachments(targetRef: RefObject<TerminalSnapshot | null>, initial = false) {
  const draftsRef = useRef<AttachmentDraft[]>([])
  const removed = useRef(new Set<string>())
  const fingerprints = useRef(new Map<string, string>())
  const mounted = useRef(true)
  const delivering = useRef(false)
  const restoring = useRef<Promise<void>>(Promise.resolve())
  const [drafts, setDrafts] = useState<AttachmentDraft[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const update = (items: AttachmentDraft[]) => { draftsRef.current = items; if (mounted.current) setDrafts(items) }
  const target = () => {
    const current = targetRef.current
    if (!current?.running || current.kind !== 'codex') throw new Error('Codex 터미널 연결 후 파일을 첨부해 주세요.')
    return { taskId: current.taskId, generation: current.generation }
  }
  const upload = async (draft: AttachmentDraft) => {
    try {
      const buffer = await draft.file!.arrayBuffer()
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)), (byte) => byte.toString(16).padStart(2, '0')).join('')
      const key = `${draft.name.normalize('NFC')}\0${digest}`
      const existing = fingerprints.current.get(key)
      if (existing && existing !== draft.id) {
        update(draftsRef.current.filter((item) => item.id !== draft.id))
        if (mounted.current) setNotice('이미 첨부 목록에 있는 파일입니다.')
        return
      }
      if (removed.current.has(draft.id)) return
      fingerprints.current.set(key, draft.id)
      const [attachment] = await (initial ? window.desktop.stageInitialAttachments : window.desktop.stageAttachments)({ ...draft.target,
        files: [{ name: draft.name, data: new Uint8Array(buffer) }] })
      if (removed.current.has(draft.id)) {
        await window.desktop.discardAttachments({ ...draft.target, ids: [attachment.id] })
      } else update(draftsRef.current.map((item) => item.id === draft.id ? { ...item, attachment, phase: 'ready', error: undefined } : item))
    } catch (cause) {
      for (const [key, id] of fingerprints.current) if (id === draft.id) fingerprints.current.delete(key)
      update(draftsRef.current.map((item) => item.id === draft.id ? { ...item, phase: 'error', error: attachmentErrorText(cause) } : item))
    }
  }
  const addFiles = async (files: File[]) => {
    if (!files.length) return
    setError(''); setNotice('')
    try {
      await restoring.current
      const owner = target()
      const unique = files.filter((file, index) => !draftsRef.current.some((item) => item.file === file) && files.indexOf(file) === index)
      if (!unique.length) { setNotice('이미 첨부 목록에 있는 파일입니다.'); return }
      if (draftsRef.current.length + unique.length > maxAttachmentCount) throw new Error(`파일은 최대 ${maxAttachmentCount}개까지 첨부할 수 있습니다.`)
      if (unique.some((file) => file.size > maxAttachmentBytes)) throw new Error('파일 하나는 50MB까지 첨부할 수 있습니다.')
      if ([...draftsRef.current, ...unique].reduce((sum, item) => sum + item.size, 0) > maxAttachmentTotalBytes)
        throw new Error('첨부 파일의 합계는 100MB까지 가능합니다.')
      const added: AttachmentDraft[] = unique.map((file) => ({ id: crypto.randomUUID(), name: file.name,
        size: file.size, target: owner, phase: 'loading', file }))
      update([...draftsRef.current, ...added])
      for (const item of added) void upload(item)
    } catch (cause) { setError(attachmentErrorText(cause)) }
  }
  const restore = (owner: AttachmentTarget) => {
    const operation = (async () => {
      try {
        const items = await window.desktop.listAttachments(owner)
        if (!mounted.current || targetRef.current?.generation !== owner.generation) return
        const keep = draftsRef.current.filter((item) => item.target.generation === owner.generation || item.phase !== 'ready')
          .map((item) => ({ ...item, target: owner }))
        for (const item of items) {
          const existing = keep.find((draft) => draft.attachment?.id === item.id)
          fingerprints.current.set(`${item.name.normalize('NFC')}\0${item.digest}`, existing?.id ?? item.id)
        }
        update([...keep, ...items.filter((item) => !keep.some((draft) => draft.attachment?.id === item.id))
          .map((attachment): AttachmentDraft => ({ id: attachment.id, name: attachment.name, size: attachment.size,
            target: owner, phase: 'ready', attachment }))])
      } catch (cause) { if (mounted.current) setError(attachmentErrorText(cause)) }
    })()
    restoring.current = operation
    return operation
  }
  const remove = async (id: string) => {
    if (delivering.current) return
    const draft = draftsRef.current.find((item) => item.id === id)
    if (!draft) return
    try {
      if (draft.attachment) await window.desktop.discardAttachments({ ...draft.target, ids: [draft.attachment.id] })
      removed.current.add(id)
      for (const [key, owner] of fingerprints.current) if (owner === id) fingerprints.current.delete(key)
      update(draftsRef.current.filter((item) => item.id !== id))
      setError(''); setNotice('')
    } catch (cause) { setError(attachmentErrorText(cause)) }
  }
  const insert = async (submit = false): Promise<boolean> => {
    if (delivering.current) return false
    const current = draftsRef.current
    if (!current.length) return false
    setError('')
    if (current.some((item) => item.phase !== 'ready')) { setError('준비 중이거나 실패한 파일이 있습니다. 준비가 끝난 뒤 다시 시도하거나 해당 파일을 제거해 주세요.'); return false }
    delivering.current = true; setBusy(true)
    try {
      const owner = target()
      if (current.some((item) => item.target.generation !== owner.generation)) throw new Error('터미널이 변경되었습니다. 파일을 다시 첨부해 주세요.')
      await window.desktop.insertAttachments({ ...owner, ids: current.map((item) => item.attachment!.id), submit })
      for (const [key, id] of fingerprints.current) if (current.some((item) => item.id === id)) fingerprints.current.delete(key)
      update(draftsRef.current.filter((item) => !current.some((sent) => sent.id === item.id)))
      setNotice(submit ? '' : `${current.length}개 파일을 입력에 추가했습니다. Enter로 요청을 전송하세요.`)
      return true
    } catch (cause) { setError(attachmentErrorText(cause)); return false }
    finally { delivering.current = false; if (mounted.current) setBusy(false) }
  }
  const pasteClipboard = async (): Promise<boolean> => {
    try {
      await restoring.current
      if (draftsRef.current.length >= maxAttachmentCount) throw new Error(`파일은 최대 ${maxAttachmentCount}개까지 첨부할 수 있습니다.`)
      const owner = target()
      const attachments = await window.desktop.stageClipboardAttachment(owner)
      if (!attachments.length) return false
      update([...draftsRef.current, ...attachments.map((attachment): AttachmentDraft => ({
        id: attachment.id, name: attachment.name, size: attachment.size, target: owner, phase: 'ready', attachment }))])
      setError(''); setNotice('')
    } catch (cause) { setError(attachmentErrorText(cause)) }
    return true
  }
  const retry = (id: string) => {
    const draft = draftsRef.current.find((item) => item.id === id)
    if (!draft?.file || delivering.current) return
    try {
      setError(''); setNotice('')
      const next = { ...draft, target: target(), phase: 'loading' as const, error: undefined }
      update(draftsRef.current.map((item) => item.id === id ? next : item))
      void upload(next)
    } catch (cause) { setError(attachmentErrorText(cause)) }
  }
  return { drafts, draftsRef, busy, delivering, error, setError, notice, setNotice, addFiles, restore, remove, retry, insert, pasteClipboard }
}
