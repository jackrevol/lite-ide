import { useEffect, useRef, useState } from 'react'
import type { TerminalSnapshot, CodexStatus, Project, TaskAgentSettings, Worktree } from '../../../shared/types'
import type { WorkspaceTask } from '../lib/workspace-state'
import { Button } from './ui/button'
import { BaseBranchSelect, useBranches } from './BaseBranchSelect'
import { AttachmentControls } from './AttachmentControls'
import { useTerminalAttachments } from '../lib/use-terminal-attachments'

export function NewTaskDialog({
  project,
  worktrees,
  connection,
  initialModel,
  initialEffort,
  initialBaseRef,
  onManageBaseBranch,
  onCreate,
  onClose,
}: {
  project: Project
  worktrees: Worktree[]
  connection: CodexStatus
  initialModel: string
  initialEffort: string
  initialBaseRef: string
  onManageBaseBranch: () => void
  onCreate: (task: WorkspaceTask) => Promise<void>
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [name, setName] = useState('')
  const [purpose, setPurpose] = useState('')
  const [requirements, setRequirements] = useState('')
  const requirementsInput = useRef<HTMLTextAreaElement>(null)
  const requirementsSelection = useRef({ start: 0, end: 0 })
  const advancedSettings = useRef<HTMLDetailsElement>(null)
  const attachmentTarget = useRef<TerminalSnapshot | null>({ taskId: crypto.randomUUID(), generation: 'initial',
    kind: 'codex', running: true, workspace: project.path, output: '', sequence: 0, cols: 80, rows: 24 })
  const attachments = useTerminalAttachments(attachmentTarget, true, (attachment) => {
    const { start, end } = requirementsSelection.current
    requirementsSelection.current = { start: start + attachment.reference.length, end: start + attachment.reference.length }
    setRequirements((previous) => previous.slice(0, start) + attachment.reference + previous.slice(end))
    requestAnimationFrame(() => {
      requirementsInput.current?.focus()
      requirementsInput.current?.setSelectionRange(requirementsSelection.current.start, requirementsSelection.current.end)
    })
  })
  const attachmentActions = useRef(attachments)
  attachmentActions.current = attachments
  const retained = useRef(false)
  const files = attachments.drafts.flatMap((draft) => draft.attachment ? [draft.attachment] : [])
  const prompt = [
    purpose.trim() && `## 목적\n${purpose.trim()}`,
    requirements.trim() && `## 요구사항\n${requirements.trim()}`,
  ].filter(Boolean).join('\n\n')
  const hasRequest = !!prompt
  const attachmentsReady = attachments.drafts.every((draft) => draft.phase === 'ready')
  useEffect(() => () => {
    if (!retained.current) for (const draft of attachmentActions.current.draftsRef.current) void attachmentActions.current.remove(draft.id)
  }, [])
  const [branch, setBranch] = useState(
    () =>
      `task/${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`,
  )
  const [model, setModel] = useState(initialModel)
  const [effort, setEffort] = useState(initialEffort)
  const [workStyle, setWorkStyle] = useState<TaskAgentSettings['style']>('single')
  const [subagentModel, setSubagentModel] = useState('')
  const [subagentEffort, setSubagentEffort] = useState('')
  const [subagentLimit, setSubagentLimit] = useState('')
  const [baseRef, setBaseRef] = useState(initialBaseRef)
  const branchList = useBranches(project.path)
  const invalidBaseRef = branchList.loading || !!branchList.error ||
    (baseRef !== 'HEAD' && !branchList.branches.includes(baseRef))
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const created = useRef<WorkspaceTask | null>(null)
  const submitting = useRef(false)
  const selectedModel = connection.models.find((item) => item.id === model)
  const invalidModel = !!model && !selectedModel
  const invalidEffort =
    !!effort && !!selectedModel && !selectedModel.efforts.includes(effort)
  const delegated = workStyle === 'delegated'
  const subagentModelInfo = connection.models.find((item) => item.id === (subagentModel || model))
  const invalidSubagentModel = delegated && !!subagentModel && !subagentModelInfo
  const invalidSubagentEffort = delegated && !!subagentEffort && !subagentModelInfo?.efforts.includes(subagentEffort)
  const maxConcurrent = subagentLimit === '' ? undefined : Number(subagentLimit)
  const invalidSubagentLimit = delegated && maxConcurrent !== undefined &&
    (!Number.isSafeInteger(maxConcurrent + 1) || maxConcurrent < 1)
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  useEffect(() => {
    if (created.current) return
    if (model && !connection.models.some((item) => item.id === model)) return
    const selected =
      connection.models.find((item) => item.id === model) ??
      connection.models.find((item) => item.isDefault) ??
      connection.models[0]
    if (!selected) return
    if (selected.id !== model) setModel(selected.id)
    if (!effort && selected.efforts.includes(selected.defaultEffort))
      setEffort(selected.defaultEffort)
  }, [connection.models, model, effort])
  function addRequirementFiles(files: File[]) {
    if (!files.length || submitting.current || created.current) return
    if (advancedSettings.current) advancedSettings.current.open = true
    void attachments.addFiles(files)
  }

  async function submit() {
    if (submitting.current || !attachmentsReady || invalidSubagentModel ||
      invalidSubagentEffort || invalidSubagentLimit || (!created.current && invalidBaseRef)) return
    submitting.current = true
    setPending(true)
    setError('')
    try {
      if (!created.current) {
        const tree = await window.desktop.createWorktree(
          project.path,
          branch.trim(),
          baseRef,
        )
        const target = tree.path
        created.current = {
          id: attachmentTarget.current!.taskId,
          project: project.path,
          path: target,
          branch: tree.branch,
          name: name.trim() || tree.branch,
          model,
          effort,
          agentSettings: delegated
            ? { style: 'delegated', model: subagentModel || model, effort: subagentEffort, maxConcurrent }
            : { style: 'single' },
          terminalKind: 'codex',
          initialPrompt: prompt || undefined,
        }
      }
      if (files.length && !retained.current) {
        await window.desktop.retainInitialAttachments({ taskId: attachmentTarget.current!.taskId, generation: 'initial', ids: files.map((file) => file.id) })
        retained.current = true
      }
      await onCreate(created.current)
      onClose()
    } catch (cause) {
      setError(
        `${created.current ? '작업 공간과 입력 내용을 보존했습니다. 다시 시도하면 같은 작업에서 시작합니다. ' : ''}${cause instanceof Error ? cause.message : String(cause)}`,
      )
    } finally {
      submitting.current = false
      setPending(false)
    }
  }
  return (
    <dialog
      ref={dialog}
      className="form-dialog new-task-dialog"
      aria-labelledby="new-task-title"
      onCancel={(event) => {
        if (pending) event.preventDefault()
        else onClose()
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <h2 id="new-task-title">새 작업</h2>
        <p title={project.path}>{project.name}에서 작업을 시작합니다.</p>
        <fieldset disabled={pending || !!created.current}>
          <label>
            작업 이름
            <input
              aria-label="새 작업 이름"
              placeholder="선택 사항"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={100}
            />
          </label>
          <div className="task-model-fields">
            <label>
              메인 에이전트 모델
              <select
                aria-label="메인 에이전트 모델"
                value={model}
                disabled={!connection.models.length}
                onChange={(event) => {
                  const next = connection.models.find(
                    (item) => item.id === event.target.value,
                  )
                  setModel(event.target.value)
                  setEffort(next?.defaultEffort ?? '')
                }}
              >
                {!connection.models.length && (
                  <option value="">연결 후 선택</option>
                )}
                {invalidModel && (
                  <option value={model}>{model} (현재 사용 불가)</option>
                )}
                {connection.models.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              메인 에이전트 추론 수준
              <select
                aria-label="메인 에이전트 추론 수준"
                value={effort}
                disabled={
                  !selectedModel ||
                  (!selectedModel.efforts.length && !invalidEffort)
                }
                onChange={(event) => setEffort(event.target.value)}
              >
                {!selectedModel?.efforts.length && (
                  <option value="">기본값</option>
                )}
                {invalidEffort && (
                  <option value={effort}>{effort} (현재 사용 불가)</option>
                )}
                {selectedModel?.efforts.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            목적
            <textarea
              placeholder="이 작업으로 어떤 결과를 얻고 싶은지 적어 주세요."
              value={purpose}
              onChange={(event) => setPurpose(event.target.value)}
              rows={2}
            />
          </label>
          <label>
            요구사항
            <textarea
              ref={requirementsInput}
              readOnly={attachments.drafts.some((draft) => draft.phase === 'loading')}
              placeholder="작업 범위, 지켜야 할 조건, 완료 기준을 적어 주세요."
              value={requirements}
              onChange={(event) => {
                setRequirements(event.target.value)
                requirementsSelection.current = {
                  start: event.target.selectionStart,
                  end: event.target.selectionEnd,
                }
              }}
              onSelect={(event) => {
                if (!event.currentTarget.readOnly) {
                  requirementsSelection.current = {
                    start: event.currentTarget.selectionStart,
                    end: event.currentTarget.selectionEnd,
                  }
                }
              }}
              onPaste={(event) => {
                const files = Array.from(event.clipboardData.files)
                if (files.length) {
                  event.preventDefault()
                  addRequirementFiles(files)
                }
              }}
              onDragOver={(event) => {
                if (event.dataTransfer.types.includes('Files')) event.preventDefault()
              }}
              onDrop={(event) => {
                const files = Array.from(event.dataTransfer.files)
                if (files.length) {
                  event.preventDefault()
                  addRequirementFiles(files)
                }
              }}
              rows={4}
            />
          </label>
          <details ref={advancedSettings} className="new-task-advanced">
            <summary>고급 설정</summary>
            <div className="new-task-advanced-fields">
              <label>
                작업 스타일
                <select
                  value={workStyle}
                  onChange={(event) => setWorkStyle(event.target.value === 'delegated' ? 'delegated' : 'single')}
                >
                  <option value="single">단일 에이전트</option>
                  <option value="delegated">서브에이전트에 위임</option>
                </select>
              </label>
              {delegated && (
                <>
                  <p>
                    메인이 계획·분담·검수를 맡고 구현과 테스트를 위임합니다.
                    모델과 추론 수준은 메인이 서브에이전트를 시작할 때 요청합니다.
                  </p>
                  <div className="task-model-fields">
                    <label>
                      서브에이전트 모델
                      <select
                        value={subagentModel}
                        disabled={!connection.models.length}
                        onChange={(event) => {
                          setSubagentModel(event.target.value)
                          setSubagentEffort('')
                        }}
                      >
                        <option value="">메인과 동일</option>
                        {invalidSubagentModel && <option value={subagentModel}>{subagentModel} (현재 사용 불가)</option>}
                        {connection.models.map((item) => (
                          <option key={item.id} value={item.id}>{item.name}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      서브에이전트 추론 수준
                      <select
                        value={subagentEffort}
                        disabled={!subagentModelInfo?.efforts.length && !invalidSubagentEffort}
                        onChange={(event) => setSubagentEffort(event.target.value)}
                      >
                        <option value="">모델 기본값</option>
                        {invalidSubagentEffort && <option value={subagentEffort}>{subagentEffort} (현재 사용 불가)</option>}
                        {subagentModelInfo?.efforts.map((item) => (
                          <option key={item} value={item}>{item}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <label>
                    서브에이전트 최대 동시 실행 수
                    <input
                      type="number"
                      min={1}
                      step={1}
                      placeholder="Codex 기본값"
                      value={subagentLimit}
                      onChange={(event) => setSubagentLimit(event.target.value)}
                    />
                  </label>
                </>
              )}
              <p>
                선택한 기준 브랜치의 최신 형상을 확인한 뒤 작업 전용 브랜치와 폴더를 생성합니다.
              </p>
              <BaseBranchSelect
                label="기준 브랜치"
                ariaLabel="이번 작업 기준 브랜치"
                value={baseRef}
                onChange={setBaseRef}
                {...branchList}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onManageBaseBranch}
              >
                기본 기준 브랜치 관리
              </Button>
              <label>
                새 브랜치 이름
                <input
                  aria-label="새 브랜치 이름"
                  value={branch}
                  onChange={(event) => setBranch(event.target.value)}
                  required
                  maxLength={100}
                />
              </label>
              <div
                onDragOver={(event) => {
                  if (event.dataTransfer.types.includes('Files')) event.preventDefault()
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  addRequirementFiles(Array.from(event.dataTransfer.files))
                }}
                onPaste={(event) => {
                  const files = Array.from(event.clipboardData.files)
                  if (files.length) {
                    event.preventDefault()
                    addRequirementFiles(files)
                  }
                }}
              >
                <AttachmentControls attachments={attachments} disabled={pending || !!created.current} onInserted={() => {}} />
              </div>
            </div>
          </details>
        </fieldset>
        {!created.current && !branchList.loading && invalidBaseRef && (
          <p className="new-task-branch-warning" role="alert">
            고급 설정에서 기준 브랜치를 확인해 주세요.
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        {(invalidModel || invalidEffort) && (
          <p role="alert">
            프로젝트 기본 모델 또는 추론 수준을 현재 사용할 수 없습니다. 연결을
            확인하거나 이번 작업에 사용할 값을 선택해 주세요.
          </p>
        )}
        {(invalidSubagentModel || invalidSubagentEffort || invalidSubagentLimit) && (
          <p role="alert">고급 설정에서 서브에이전트 모델, 추론 수준 및 최대 동시 실행 수를 확인해 주세요.</p>
        )}
        {hasRequest &&
          (!connection.connected || !connection.authenticated) && (
            <p>Codex 연결과 로그인을 완료한 후 요청을 시작할 수 있습니다.</p>
          )}
        <div className="dialog-actions">
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={onClose}
          >
            {created.current ? '닫기' : '취소'}
          </Button>
          <Button
            type="submit"
            disabled={
              pending ||
              !attachmentsReady ||
              invalidModel ||
              invalidEffort ||
              invalidSubagentModel ||
              invalidSubagentEffort ||
              invalidSubagentLimit ||
              !branch.trim() ||
              !worktrees.length ||
              (!created.current && invalidBaseRef) ||
              (hasRequest &&
                (!connection.connected || !connection.authenticated))
            }
          >
            {pending
              ? '시작 중…'
              : created.current
                ? '다시 시도'
                : hasRequest
                  ? '만들고 시작'
                  : '만들기'}
          </Button>
        </div>
      </form>
    </dialog>
  )
}
