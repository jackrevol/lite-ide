import { useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Check,
  ChevronDown,
  Code2,
  Copy,
  FileCode2,
  LoaderCircle,
  Terminal,
  Wrench,
} from 'lucide-react'
import { Button } from './ui/button'
import type {
  AgentMessage,
  AgentRequest,
  AgentSession,
  RequestAnswer,
} from '../../../shared/types'

function Message({ message }: { message: AgentMessage }) {
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  if (message.kind === 'user')
    return <div className="user-message">{message.text}</div>
  if (message.kind === 'assistant')
    return (
      <article className="assistant-message">
        <div className="message-author">
          <Code2 size={16} />
          <strong>Codex</strong>
          <button
            aria-label="응답 복사"
            onClick={() => {
              void navigator.clipboard
                .writeText(message.text)
                .then(() => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                })
                .catch(() => setError('클립보드에 복사하지 못했습니다.'))
            }}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
        </div>
        <div className="markdown">
          <Markdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ children, href }) =>
                href && /^https?:\/\//i.test(href) ? (
                  <a
                    href={href}
                    onClick={(event) => {
                      event.preventDefault()
                      void window.desktop
                        .openLink(href)
                        .catch(() => setError('링크를 열지 못했습니다.'))
                    }}
                  >
                    {children}
                  </a>
                ) : (
                  <span title={href}>{children}</span>
                ),
            }}
          >
            {message.text}
          </Markdown>
        </div>
        {error && (
          <p role="alert" className="turn-note">
            {error}
          </p>
        )}
      </article>
    )
  if (message.kind === 'reasoning' && !message.text) return null
  const Icon =
    message.kind === 'command'
      ? Terminal
      : message.kind === 'files'
        ? FileCode2
        : Wrench
  return (
    <details className="tool-message">
      <summary>
        <Icon size={14} />
        <span>
          {message.kind === 'reasoning'
            ? '작업 계획'
            : message.text.split('\n')[0]}
        </span>
        {message.status === 'inProgress' ? (
          <LoaderCircle className="spinning" size={13} />
        ) : (
          <ChevronDown size={13} />
        )}
      </summary>
      <pre>
        {message.text}
        {message.detail ? `\n\n${message.detail}` : ''}
      </pre>
    </details>
  )
}

function RequestCard({
  request,
  answer,
}: {
  request: AgentRequest
  answer: (value: RequestAnswer) => Promise<void>
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  async function submit(value: RequestAnswer) {
    setPending(true)
    try {
      await answer(value)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setPending(false)
    }
  }
  return (
    <section className="request-card">
      <h3>{request.title}</h3>
      {request.detail && <pre>{request.detail}</pre>}
      {request.questions?.map((question) => (
        <fieldset key={question.id}>
          <legend>{question.question}</legend>
          {question.options?.map((option) => (
            <button
              key={option.label}
              className={`answer-option ${answers[question.id] === option.label ? 'selected' : ''}`}
              onClick={() =>
                setAnswers({ ...answers, [question.id]: option.label })
              }
            >
              <strong>{option.label}</strong>
              <span>{option.description}</span>
            </button>
          ))}
          <input
            aria-label={question.question}
            placeholder="직접 답변 입력"
            value={answers[question.id] ?? ''}
            onChange={(event) =>
              setAnswers({ ...answers, [question.id]: event.target.value })
            }
          />
        </fieldset>
      ))}
      {error && <p role="alert">{error}</p>}
      <div className="request-actions">
        {request.kind === 'questions' ? (
          <Button disabled={pending} onClick={() => void submit({ answers })}>
            답변 보내기
          </Button>
        ) : (
          <>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => void submit({ approved: false })}
            >
              거절
            </Button>
            <Button
              disabled={pending}
              onClick={() => void submit({ approved: true })}
            >
              이번 실행 허용
            </Button>
          </>
        )}
      </div>
    </section>
  )
}

export function Conversation({ session }: { session?: AgentSession }) {
  const scroll = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  useEffect(() => {
    follow.current = true
  }, [session?.id])
  useEffect(() => {
    if (follow.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight
  }, [session])
  return (
    <div
      className="conversation"
      ref={scroll}
      onScroll={() => {
        const node = scroll.current
        if (node)
          follow.current =
            node.scrollHeight - node.scrollTop - node.clientHeight < 100
      }}
    >
      <div className="conversation-inner">
        {session?.messages.map((message) => (
          <Message key={message.id} message={message} />
        ))}
        {session?.requests.map((request) => (
          <RequestCard
            key={request.id}
            request={request}
            answer={(answer) =>
              window.desktop.answerRequest(session.id, request.id, answer)
            }
          />
        ))}
        {session?.status === 'running' && (
          <div className="working-indicator" role="status">
            <LoaderCircle size={14} className="spinning" />
            Codex가 작업하고 있습니다
          </div>
        )}
        {session?.status === 'interrupted' && (
          <p className="turn-note">
            작업을 중단했습니다. 메시지를 보내 이어갈 수 있습니다.
          </p>
        )}
        {session?.error && (
          <p className="error-message" role="alert">
            {session.error}
          </p>
        )}
      </div>
    </div>
  )
}
