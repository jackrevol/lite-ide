import { Check, CircleHelp, LoaderCircle, Unplug } from 'lucide-react'
import type { SessionIndicatorStatus } from '../lib/workspace-sessions'

const icons = {
  running: LoaderCircle, completed: Check, waiting: CircleHelp, disconnected: Unplug,
}

export function SessionStatusIndicator({ status }: { status: SessionIndicatorStatus }) {
  const Icon = icons[status.state]
  return (
    <span
      className={`session-indicator ${status.state}`}
      data-state={status.state}
      role="img"
      aria-label={status.label}
      title={status.detail ? `${status.label} · ${status.detail}` : status.label}
    >
      <Icon size={12} aria-hidden="true" />
    </span>
  )
}

export function SessionStatusBadge({ status }: { status: SessionIndicatorStatus }) {
  return <span className={`status-label ${status.state}`} title={status.detail}>{status.label}</span>
}
