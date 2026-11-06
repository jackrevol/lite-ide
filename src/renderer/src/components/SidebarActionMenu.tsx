import { Menu } from '@base-ui/react/menu'
import type { ReactNode } from 'react'

interface SidebarAction {
  label: string
  icon: ReactNode
  onClick: () => void
  disabled?: boolean
  destructive?: boolean
}

export function SidebarActionMenu({
  label,
  heading,
  icon,
  className,
  disabled,
  actions,
}: {
  label: string
  heading: string
  icon: ReactNode
  className: string
  disabled?: boolean
  actions: SidebarAction[]
}) {
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        className={className}
        aria-label={label}
        title={label}
        disabled={disabled}
      >
        {icon}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          align="end"
          sideOffset={4}
          className="sidebar-menu-positioner"
        >
          <Menu.Popup
            className="sidebar-action-menu"
            aria-label={label}
            finalFocus={() =>
              !document.querySelector('dialog[open]') &&
              document.activeElement?.tagName !== 'TEXTAREA'
            }
          >
            <Menu.Group>
              <Menu.GroupLabel className="sidebar-menu-heading">
                {heading}
              </Menu.GroupLabel>
              {actions.map((action) => (
                <Menu.Item
                  key={action.label}
                  className={`sidebar-menu-item ${action.destructive ? 'destructive' : ''}`}
                  disabled={action.disabled}
                  onClick={action.onClick}
                >
                  {action.icon}
                  <span>{action.label}</span>
                </Menu.Item>
              ))}
            </Menu.Group>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}
