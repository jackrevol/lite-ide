import { useEffect, useRef } from 'react'
import { Code2, Plus } from 'lucide-react'

export function TaskTabs({
  tasks,
  selected,
  onSelect,
  onAdd,
}: {
  tasks: { id: string; title: string; active: boolean }[]
  selected?: string
  onSelect: (id: string) => void
  onAdd: () => void
}) {
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
    })
  }, [selected])
  return (
    <div className="agent-tabs-bar">
      <div
        className="agent-tabs"
        role="tablist"
        aria-label="작업 탭"
        ref={list}
      >
        {tasks.map((task, index) => (
          <button
            key={task.id}
            role="tab"
            aria-selected={selected === task.id}
            aria-controls="agent-task-content"
            id={`task-tab-${task.id}`}
            tabIndex={selected === task.id ? 0 : -1}
            title={task.title}
            onClick={() => onSelect(task.id)}
            onKeyDown={(event) => {
              const next =
                event.key === 'ArrowRight'
                  ? (index + 1) % tasks.length
                  : event.key === 'ArrowLeft'
                    ? (index - 1 + tasks.length) % tasks.length
                    : event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? tasks.length - 1
                        : -1
              if (next < 0) return
              event.preventDefault()
              onSelect(tasks[next].id)
              list.current
                ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                [next]?.focus()
            }}
          >
            <Code2 size={13} />
            <span>{task.title}</span>
            {task.active && (
              <span className="tab-running-dot" aria-label="작업 중" />
            )}
          </button>
        ))}
      </div>
      <button
        className="agent-tab-add"
        aria-label="새 Worktree 작업"
        title="새 작업 (Ctrl N)"
        onClick={onAdd}
      >
        <Plus size={15} />
      </button>
    </div>
  )
}
