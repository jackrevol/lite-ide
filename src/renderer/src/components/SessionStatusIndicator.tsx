import { Check, Circle, CircleDashed, CircleHelp, CircleX, LoaderCircle, Pause, Unplug } from 'lucide-react'
import type { SessionIndicatorStatus } from '../lib/workspace-sessions'

const icons = {
  running: LoaderCircle, completed: Check, waiting: CircleHelp, failed: CircleX,
  interrupted: Pause, idle: Circle, unknown: CircleDashed, disconnected: Unplug,
}

export function SessionStatusIndicator({ status }: { status: SessionIndicatorStatus }) {
  const Icon = icons[status.state]
  return (
    <span
      className={`session-indicator ${status.state}`}
      data-state={status.state}
      role="img"
      aria-label={status.label}
      title={status.label}
    >
      <Icon size={12} aria-hidden="true" />
    </span>
  )
}
