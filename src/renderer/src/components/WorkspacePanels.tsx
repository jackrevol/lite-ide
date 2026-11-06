import type { ReactNode } from 'react'
import {
  Group,
  Panel,
  Separator,
  useDefaultLayout,
} from 'react-resizable-panels'

const fullPanelIds = ['projects', 'agent', 'changes']
const compactPanelIds = ['projects', 'agent']

export function WorkspacePanels({
  projects,
  agent,
  changes,
}: {
  projects: ReactNode
  agent: ReactNode
  changes?: ReactNode
}) {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: 'lite-ide.workspace-panels.v1',
    panelIds: changes ? fullPanelIds : compactPanelIds,
    onlySaveAfterUserInteractions: true,
  })
  return (
    <Group
      id="workspace-panels"
      className="workspace-panels"
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
      resizeTargetMinimumSize={{ fine: 8, coarse: 24 }}
    >
      <Panel
        id="projects"
        className="workspace-panel"
        defaultSize={230}
        minSize={190}
        maxSize="35%"
      >
        {projects}
      </Panel>
      <Separator
        className="panel-resize-handle"
        aria-label="프로젝트 패널 크기 조절"
      />
      <Panel id="agent" className="workspace-panel" minSize={360}>
        {agent}
      </Panel>
      {changes && (
        <>
          <Separator
            className="panel-resize-handle"
            aria-label="변경 사항 패널 크기 조절"
          />
          <Panel
            id="changes"
            className="workspace-panel"
            defaultSize={300}
            minSize={240}
            maxSize="50%"
          >
            {changes}
          </Panel>
        </>
      )}
    </Group>
  )
}
