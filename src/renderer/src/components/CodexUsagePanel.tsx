import { useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type {
  CodexStatus,
  CodexUsage,
  CodexUsageWindow,
} from '../../../shared/types'

const dateLabel = (seconds: number) =>
  new Date(seconds * 1000).toLocaleString('ko-KR', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })

function windowLabel(minutes: number | null, index: number) {
  if (!minutes || minutes < 0) return index === 0 ? '기본 한도' : '추가 한도'
  if (minutes % 10080 === 0) return `${minutes / 10080}주`
  if (minutes % 1440 === 0) return `${minutes / 1440}일`
  if (minutes % 60 === 0) return `${minutes / 60}시간`
  return `${minutes}분`
}

function resetLabel(seconds: number | null, now: number) {
  if (!seconds || !Number.isFinite(seconds)) return '초기화 시간 미제공'
  const minutes = Math.ceil((seconds * 1000 - now) / 60000)
  if (minutes <= 0) return '초기화 확인 중'
  if (minutes < 60) return `${minutes}분 후 초기화`
  if (minutes < 1440)
    return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분 후 초기화`
  return `${Math.floor(minutes / 1440)}일 ${Math.floor((minutes % 1440) / 60)}시간 후 초기화`
}

function UsageWindow({
  window,
  index,
  now,
}: {
  window: CodexUsageWindow
  index: number
  now: number
}) {
  const label = windowLabel(window.windowDurationMins, index)
  const remaining = Math.max(0, Math.min(100, 100 - window.usedPercent))
  return (
    <div className={`usage-window${remaining <= 10 ? ' usage-low' : ''}`}>
      <div className="usage-row">
        <span>{label}</span>
        <strong>{Number(remaining.toFixed(1))}% 남음</strong>
      </div>
      <div
        className="usage-track"
        role="progressbar"
        aria-label={`${label} 남은 사용량`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={remaining}
      >
        <span style={{ width: `${remaining}%` }} />
      </div>
      <div
        className="usage-reset"
        title={
          window.resetsAt
            ? new Date(window.resetsAt * 1000).toLocaleString('ko-KR')
            : undefined
        }
      >
        {resetLabel(window.resetsAt, now)}
        {window.resetsAt != null && (
          <span className="usage-date">{dateLabel(window.resetsAt)}</span>
        )}
      </div>
    </div>
  )
}

export function CodexUsagePanel({
  connection,
  connecting,
}: {
  connection: CodexStatus
  connecting: boolean
}) {
  const [usage, setUsage] = useState<CodexUsage | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [updatedAt, setUpdatedAt] = useState(0)
  const [now, setNow] = useState(Date.now)
  const refresh = useRef<() => void>(() => {})
  const available = connection.connected && connection.authenticated

  useEffect(() => {
    if (!available) {
      setUsage(null)
      return
    }
    let disposed = false
    let pending = false
    const read = async () => {
      if (pending || disposed) return
      pending = true
      setBusy(true)
      try {
        const result = await window.desktop.codexUsage()
        if (disposed) return
        setUsage(result)
        setNow(Date.now())
        setError('')
        setUpdatedAt(Date.now())
      } catch (cause) {
        if (disposed) return
        setUsage(null)
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        pending = false
        if (!disposed) setBusy(false)
      }
    }
    refresh.current = () => void read()
    const unsubscribe = window.desktop.onCodexUsageChanged(() => void read())
    const timer = window.setInterval(() => {
      setNow(Date.now())
      void read()
    }, 60000)
    window.addEventListener('focus', refresh.current)
    void read()
    return () => {
      disposed = true
      unsubscribe()
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh.current)
    }
  }, [available])

  const buckets =
    usage?.rateLimitsByLimitId && Object.keys(usage.rateLimitsByLimitId).length
      ? Object.entries(usage.rateLimitsByLimitId)
      : usage?.rateLimits
        ? [[usage.rateLimits.limitId ?? 'codex', usage.rateLimits] as const]
        : []
  const limits = buckets.filter(
    ([, limit]) =>
      limit &&
      [limit.primary, limit.secondary].some(
        (item) => item && Number.isFinite(item.usedPercent),
      ),
  )
  const plan = limits.find(([, limit]) => limit.planType)?.[1].planType
  const resetCredits = usage?.rateLimitResetCredits
  const nearestCredit = resetCredits?.credits
    ?.filter(
      (credit) =>
        credit.status === 'available' &&
        (credit.expiresAt == null || credit.expiresAt * 1000 > now),
    )
    .sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity))[0]
  const message = connecting
    ? 'Codex 연결 중…'
    : !connection.connected
      ? '연결 후 한도를 확인할 수 있습니다.'
      : !connection.authenticated
        ? '로그인 후 한도를 확인할 수 있습니다.'
        : error
          ? '한도를 불러오지 못했습니다.'
          : busy && !usage
            ? '사용량 불러오는 중…'
            : !limits.length
              ? '이 계정은 한도 정보를 제공하지 않습니다.'
              : ''

  return (
    <section className="codex-usage" aria-label="Codex 사용량 한도">
      <div className="usage-heading">
        <strong>Codex 사용량</strong>
        {available && !error && plan && (
          <span className="usage-plan">{plan}</span>
        )}
        <button
          aria-label="사용량 새로고침"
          title={
            updatedAt
              ? `마지막 조회 ${new Date(updatedAt).toLocaleTimeString('ko-KR')}`
              : '사용량 새로고침'
          }
          disabled={!available || busy}
          onClick={() => refresh.current()}
        >
          <RefreshCw
            size={12}
            className={busy && available ? 'animate-spin' : undefined}
          />
        </button>
      </div>
      {message ? (
        <p className="usage-empty" role="status" title={error || undefined}>
          {message}
        </p>
      ) : (
        <div className="usage-limits">
          {limits.map(([id, limit]) => (
            <div className="usage-bucket" key={id}>
              {(limits.length > 1 || (id !== 'codex' && id !== 'default')) && (
                <div className="usage-bucket-name">{limit.limitName || id}</div>
              )}
              {[limit.primary, limit.secondary].map((item, index) =>
                item && Number.isFinite(item.usedPercent) ? (
                  <UsageWindow
                    key={index}
                    window={item}
                    index={index}
                    now={now}
                  />
                ) : null,
              )}
            </div>
          ))}
        </div>
      )}
      {available && usage && !error && (
        <div className="usage-credits">
          <div className="usage-row">
            <span>남은 초기화권</span>
            <strong>
              {resetCredits
                ? `${resetCredits.availableCount}개`
                : '정보 미제공'}
            </strong>
          </div>
          {resetCredits && resetCredits.availableCount > 0 && (
            <div className="usage-reset">
              <span>가장 가까운 사용 기간</span>
              {nearestCredit ? (
                <span
                  className="usage-date"
                  title={nearestCredit.title ?? undefined}
                >
                  {dateLabel(nearestCredit.grantedAt)} ~{' '}
                  {nearestCredit.expiresAt == null
                    ? '만료 없음'
                    : dateLabel(nearestCredit.expiresAt)}
                </span>
              ) : (
                <span className="usage-date">사용 기간 정보 미제공</span>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
