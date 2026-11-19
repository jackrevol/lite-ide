import type { CodexModel, TaskAgentSettings } from '../../../shared/types'
import { validSubagentLimit } from '../../../shared/task-agent-settings'

export interface TaskAgentForm {
  style: TaskAgentSettings['style']
  model: string
  effort: string
  limit: string
}

export function taskAgentForm(value?: TaskAgentSettings): TaskAgentForm {
  return value?.style === 'delegated'
    ? { style: 'delegated', model: value.model, effort: value.effort, limit: String(value.maxConcurrent ?? '') }
    : { style: 'single', model: '', effort: '', limit: '' }
}

export function taskAgentSettings(form: TaskAgentForm, inheritedModel = ''): TaskAgentSettings {
  return form.style === 'single' ? { style: 'single' } : {
    style: 'delegated',
    model: form.model || inheritedModel,
    effort: form.effort,
    ...(form.limit ? { maxConcurrent: Number(form.limit) } : {}),
  }
}

export function invalidAgentLimit(form: TaskAgentForm) {
  return form.style === 'delegated' && form.limit !== '' && !validSubagentLimit(Number(form.limit))
}

export function TaskAgentFields({ value, onChange, models, mainModel }: {
  value: TaskAgentForm
  onChange: (value: TaskAgentForm) => void
  models: CodexModel[]
  mainModel?: CodexModel
}) {
  const selected = value.model ? models.find((model) => model.id === value.model) : mainModel
  const unavailableEffort = !!value.effort && !selected?.efforts.includes(value.effort)
  return (
    <>
      <label>
        작업 스타일
        <select value={value.style} onChange={(event) => onChange({ ...value,
          style: event.target.value === 'delegated' ? 'delegated' : 'single',
        })}>
          <option value="single">단일 에이전트</option>
          <option value="delegated">서브에이전트에 위임</option>
        </select>
      </label>
      {value.style === 'delegated' && (
        <>
          <p>
            메인이 계획·분담·검수를 맡고 구현과 테스트를 위임합니다.
            모델과 추론 수준은 메인이 서브에이전트를 시작할 때 요청합니다.
          </p>
          <div className="task-model-fields">
            <label>
              서브에이전트 모델
              <select value={value.model} disabled={!models.length && !value.model}
                onChange={(event) => onChange({ ...value, model: event.target.value, effort: '' })}>
                <option value="">메인과 동일</option>
                {value.model && !selected && <option value={value.model}>{value.model} (현재 사용 불가)</option>}
                {models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
              </select>
            </label>
            <label>
              서브에이전트 추론 수준
              <select value={value.effort} disabled={!selected?.efforts.length && !unavailableEffort}
                onChange={(event) => onChange({ ...value, effort: event.target.value })}>
                <option value="">모델 기본값</option>
                {unavailableEffort && <option value={value.effort}>{value.effort} (현재 사용 불가)</option>}
                {selected?.efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
              </select>
            </label>
          </div>
          <label>
            서브에이전트 최대 동시 실행 수
            <input type="number" min={1} step={1} placeholder="Codex 기본값" value={value.limit}
              onChange={(event) => onChange({ ...value, limit: event.target.value })} />
          </label>
        </>
      )}
    </>
  )
}
