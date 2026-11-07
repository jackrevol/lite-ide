import { useEffect, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { ResetAnnouncementState } from '../../../shared/types'
import { resetAnnouncementLabels, resetAnnouncementSource } from '../../../shared/reset-announcements'

const dateLabel = (value: number) => new Date(value).toLocaleString('ko-KR', {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
})

export function ResetAnnouncementPanel() {
  const [state, setState] = useState<ResetAnnouncementState | null>(null)
  const [now, setNow] = useState(Date.now)
  const [linkError, setLinkError] = useState('')
  useEffect(() => {
    let disposed = false
    let received = false
    const unsubscribe = window.desktop.onResetAnnouncements((next) => {
      received = true
      if (!disposed) { setState(next); setNow(Date.now()) }
    })
    void window.desktop.resetAnnouncementStatus().then((next) => {
      if (!disposed && !received) setState(next)
    }).catch(() => {
      if (!disposed && !received) setState({ checkedAt: null, generatedAt: null,
        error: '리셋 공지를 불러오지 못했습니다.', announcements: [] })
    })
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => { disposed = true; unsubscribe(); window.clearInterval(timer) }
  }, [])

  const stale = !!state?.error || (state?.generatedAt != null && now - state.generatedAt > 30 * 60_000)
  const upcoming = state?.announcements.filter((event) =>
    ['announced', 'hinted'].includes(event.kind) && !stale && now - event.publishedAt <= 72 * 60 * 60_000 &&
    (event.scheduledAt === null || event.scheduledAt > now)) ?? []
  const recent = state?.announcements.filter((event) => ['banked', 'regular'].includes(event.kind)) ?? []
  async function open(url: string) {
    setLinkError('')
    try { await window.desktop.openLink(url) }
    catch { setLinkError('원문을 열지 못했습니다.') }
  }
  return <details className="usage-reset-news" aria-label="초기화권 및 리셋 소식">
    <summary>
      <ChevronRight size={12} />
      <strong>리셋 소식</strong>
      <span>{stale ? '갱신 지연' : upcoming.length ? `예고 ${upcoming.length}건` : state?.checkedAt ? '예고 없음' : '조회 중…'}</span>
    </summary>
    <div className="usage-reset-news-details">
    {!state?.checkedAt && !state?.error && <p className="usage-empty" role="status">리셋 공지 조회 중…</p>}
    {stale ? <p className="usage-empty" role="status" title={state?.error ?? undefined}>
      공지 갱신 지연 · 예고 확인 불가
    </p> : state?.checkedAt && !upcoming.length ? <p className="usage-empty">수집된 리셋 예고 없음</p> : null}
    {[...upcoming, ...recent].map((event) => <div className="usage-reset-news-item" key={event.id}>
      <button className="usage-reset-news-link" onClick={() => void open(event.url)}
        title={event.text || 'Tibo의 X 원문 보기'} aria-label={`${resetAnnouncementLabels[event.kind]} 원문 보기`}>
        <span>{resetAnnouncementLabels[event.kind]}</span><span>{dateLabel(event.publishedAt)} ↗</span>
      </button>
      {['announced', 'hinted'].includes(event.kind) && <p className="usage-empty">
        {event.scheduledAt !== null ? `예고 시각 ${dateLabel(event.scheduledAt)}`
          : event.scheduledDay ? `예고 날짜 ${event.scheduledDay} · 시각·시간대 미제공` : '예정 시각 미제공'}
        {event.kind === 'hinted' && ' · 확정 예고 아님'}
      </p>}
      {event.kind === 'regular' && <p className="usage-empty">
        {event.deliveredAt !== null ? `제공처 반영 보고 ${dateLabel(event.deliveredAt)}` : '실제 반영 시각 미확인'}
      </p>}
    </div>)}
    <p className="usage-empty">공지는 계정별 지급·초기화를 보장하지 않습니다.</p>
    <div className="usage-reset-news-source">
      <button onClick={() => void open(`${resetAnnouncementSource}/developers/`)}>CodexReset · 비공식 ↗</button>
      {state?.checkedAt != null && <span title={`제공처 갱신 ${state.generatedAt ? dateLabel(state.generatedAt) : '미제공'} · 5분마다 조회`}>
        조회 {dateLabel(state.checkedAt)}
      </span>}
    </div>
    {linkError && <p className="usage-empty" role="alert">{linkError}</p>}
    </div>
  </details>
}
