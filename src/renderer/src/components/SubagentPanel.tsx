import { useEffect, useRef, useState } from 'react'
import {
  ArrowUp,
  Bot,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Search,
  Square,
  X,
} from 'lucide-react'
import type { AgentSession, AgentStatus } from '../../../shared/types'
import { Conversation } from './Conversation'
import { Button } from './ui/button'
import { getSubagents, isAgentActive as isActive } from '../lib/subagents'

const labels: Record<AgentStatus, string> = {
  idle: '준비 중',
  running: '작업 중',
  waiting: '응답 필요',
  completed: '완료',
  interrupted: '중단됨',
  failed: '오류',
}
const needsAttention = (session: AgentSession) =>
  session.status === 'waiting' ||
  session.status === 'failed' ||
  !!session.observationError
const lastActivity = (session: AgentSession) =>
  session.error ||
  session.messages.at(-1)?.text ||
  session.task ||
  '활동을 기다리고 있습니다.'
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

export function SubagentPanel({
  parent,
  agents,
}: {
  parent: AgentSession
  agents: Record<string, AgentSession>
}) {
  const [requestDrafts, setRequestDrafts] = useState<Record<string, Record<string, string>>>({})
  const [expanded, setExpanded] = useState(true)
  const [filter, setFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [pending, setPending] = useState('')
  const [error, setError] = useState('')
  const [now, setNow] = useState(Date.now())
  const dialog = useRef<HTMLDialogElement>(null)
  const children = getSubagents(parent.id, agents)
  children.sort(
    (a, b) =>
      Number(needsAttention(b)) - Number(needsAttention(a)) ||
      Number(isActive(b)) - Number(isActive(a)) ||
      b.updatedAt - a.updatedAt ||
      a.id.localeCompare(b.id),
  )
  const selected = selectedId ? agents[selectedId] : undefined
  const active = children.filter(isActive).length
  const attention = children.filter(needsAttention).length
  const filters = [
    { id: 'all', label: '전체', count: children.length },
    { id: 'active', label: '진행 중', count: active },
    { id: 'attention', label: '확인 필요', count: attention },
    {
      id: 'finished',
      label: '종료',
      count:
        children.length -
        active -
        children.filter((item) => item.status === 'idle').length,
    },
  ]
  const visible = children.filter(
    (item) =>
      (filter === 'all' ||
        (filter === 'active' && isActive(item)) ||
        (filter === 'attention' && needsAttention(item)) ||
        (filter === 'finished' && !isActive(item) && item.status !== 'idle')) &&
      `${item.title} ${item.role ?? ''} ${item.task ?? ''} ${item.threadId ?? ''}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  )

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    if (!selectedId) return
    setError('')
    dialog.current?.showModal()
    void window.desktop
      .inspectSubagent(selectedId)
      .catch((cause) => setError(errorText(cause)))
  }, [selectedId])

  async function perform(action: string, operation: () => Promise<void>) {
    setPending(action)
    setError('')
    try {
      await operation()
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setPending('')
    }
  }

  function updated(session: AgentSession) {
    const seconds = Math.max(0, Math.floor((now - session.updatedAt) / 1000))
    return seconds < 60
      ? '방금 활동'
      : seconds < 3600
        ? `${Math.floor(seconds / 60)}분 전 활동`
        : `${Math.floor(seconds / 3600)}시간 전 활동`
  }

  if (!children.length) return null
  return (
    <section className="subagent-monitor" aria-label="서브에이전트 관리">
      <button
        className="subagent-toggle"
        aria-expanded={expanded}
        aria-controls={`subagents-${parent.id}`}
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <Bot size={15} />
        <strong>서브에이전트</strong>
        <span className="count">{children.length}</span>
        <span className="subagent-overview" role="status">
          작업 중 {active}
          {attention > 0 && <b> · 확인 필요 {attention}</b>}
        </span>
      </button>
      {expanded && (
        <div id={`subagents-${parent.id}`}>
          <div className="subagent-toolbar">
            <div
              className="subagent-filters"
              aria-label="서브에이전트 상태 필터"
            >
              {filters.map((item) => (
                <button
                  key={item.id}
                  aria-pressed={filter === item.id}
                  onClick={() => setFilter(item.id)}
                >
                  {item.label} <span>{item.count}</span>
                </button>
              ))}
            </div>
            <label className="subagent-search">
              <Search size={12} />
              <input
                aria-label="서브에이전트 검색"
                placeholder="이름·작업 검색"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          </div>
          <div className="subagent-list">
            {visible.map((child) => (
              <button
                key={child.id}
                className="subagent-card"
                aria-label={`${child.title} 상세 보기`}
                onClick={() => setSelectedId(child.id)}
              >
                <div className="subagent-card-title">
                  <span className={`session-dot ${child.status}`} />
                  <strong>{child.title}</strong>
                  {child.role && <small>{child.role}</small>}
                  <span className={`status-label ${child.status}`}>
                    {child.closed ? '종료됨' : labels[child.status]}
                  </span>
                </div>
                <p>{child.task || lastActivity(child)}</p>
                <div className="subagent-card-meta">
                  <span>
                    {child.parentSessionId !== parent.id
                      ? `↳ ${agents[child.parentSessionId!]?.title ?? '하위 작업'}`
                      : lastActivity(child)}
                  </span>
                  <time
                    dateTime={new Date(child.updatedAt).toISOString()}
                    title={new Date(child.updatedAt).toLocaleString()}
                  >
                    {updated(child)}
                  </time>
                </div>
                {(child.requests.length > 0 || child.observationError) && (
                  <div className="subagent-attention">
                    {child.observationError
                      ? '활동 조회 실패 · 상세에서 다시 확인'
                      : `승인·답변 ${child.requests.length}건 대기`}
                  </div>
                )}
              </button>
            ))}
            {!visible.length && (
              <p className="subagent-empty">
                조건에 맞는 서브에이전트가 없습니다.
              </p>
            )}
          </div>
        </div>
      )}
      <dialog
        ref={dialog}
        className="subagent-dialog"
        aria-labelledby={`subagent-title-${parent.id}`}
        onClose={() => {
          setSelectedId('')
          setError('')
        }}
      >
        {selected && (
          <>
            <header className="subagent-detail-heading">
              <Bot size={18} />
              <div>
                <h2 id={`subagent-title-${parent.id}`}>{selected.title}</h2>
                <p>
                  부모 작업:{' '}
                  {agents[selected.parentSessionId!]?.title ?? parent.title}
                </p>
              </div>
              <span className={`status-label ${selected.status}`}>
                {selected.closed ? '종료됨' : labels[selected.status]}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="서브에이전트 상세 닫기"
                onClick={() => dialog.current?.close()}
              >
                <X />
              </Button>
            </header>
            <div className="subagent-detail-meta">
              <span>
                {[selected.role, selected.model].filter(Boolean).join(' · ') ||
                  'Codex 서브에이전트'}
              </span>
              <time title={new Date(selected.updatedAt).toLocaleString()}>
                {updated(selected)}
              </time>
              <Button
                variant="ghost"
                size="sm"
                disabled={!!pending}
                onClick={() =>
                  void perform('refresh', () =>
                    window.desktop.inspectSubagent(selected.id),
                  )
                }
              >
                <RefreshCw
                  size={12}
                  className={pending === 'refresh' ? 'spinning' : ''}
                />
                활동 새로고침
              </Button>
            </div>
            {selected.task && <p className="subagent-task">{selected.task}</p>}
            <div className="subagent-detail-conversation">
              <Conversation session={selected} requestDrafts={requestDrafts} setRequestDrafts={setRequestDrafts} />
              {!selected.messages.length && (
                <p className="subagent-empty">
                  아직 수신된 대화가 없습니다. 새로고침하여 활동을 확인할 수
                  있습니다.
                </p>
              )}
            </div>
            {(error || selected.observationError) && (
              <p className="error-message" role="alert">
                {error || `활동 조회 실패: ${selected.observationError}`}
              </p>
            )}
            <form
              className="subagent-composer"
              onSubmit={(event) => {
                event.preventDefault()
                const text = drafts[selected.id] ?? ''
                if (!text.trim() || pending) return
                void perform('send', async () => {
                  await window.desktop.sendSubagentMessage(selected.id, text)
                  setDrafts((previous) => ({ ...previous, [selected.id]: '' }))
                })
              }}
            >
              <textarea
                aria-label="서브에이전트에게 추가 지시"
                placeholder={
                  selected.canAcceptDirectInput === false || selected.closed
                    ? '부모 작업에서 지시해 주세요.'
                    : '추가 지시를 입력하세요…'
                }
                value={drafts[selected.id] ?? ''}
                onChange={(event) =>
                  setDrafts({ ...drafts, [selected.id]: event.target.value })
                }
                disabled={
                  selected.canAcceptDirectInput === false || selected.closed
                }
                rows={2}
              />
              <div>
                <span>
                  {selected.closed || selected.canAcceptDirectInput === false
                    ? '직접 지시를 지원하지 않는 에이전트입니다.'
                    : selected.status === 'waiting'
                      ? '승인·질문을 먼저 처리해 주세요.'
                      : isActive(selected)
                        ? '진행 중인 작업에 지시를 전달합니다.'
                        : '같은 대화에서 작업을 이어갑니다.'}
                </span>
                {isActive(selected) && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!!pending}
                    onClick={() =>
                      void perform('interrupt', () =>
                        window.desktop.interruptSession(selected.id),
                      )
                    }
                  >
                    <Square size={12} />
                    {pending === 'interrupt'
                      ? '중단 요청 중…'
                      : '서브에이전트 중단'}
                  </Button>
                )}
                <Button
                  type="submit"
                  size="sm"
                  disabled={
                    !!pending ||
                    !drafts[selected.id]?.trim() ||
                    selected.status === 'waiting' ||
                    selected.closed ||
                    selected.canAcceptDirectInput === false
                  }
                >
                  <ArrowUp size={13} />
                  {pending === 'send' ? '전송 중…' : '지시 보내기'}
                </Button>
              </div>
            </form>
          </>
        )}
      </dialog>
    </section>
  )
}
