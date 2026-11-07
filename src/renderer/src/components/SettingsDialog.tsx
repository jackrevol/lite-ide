import { useEffect, useRef, useState } from 'react'
import type {
  AppInfo,
  AppSettings,
  CodexStatus,
  Project,
  ProjectDefaults,
} from '../../../shared/types'
import { Button } from './ui/button'
import { UpdatePanel } from './UpdatePanel'
import { BaseBranchSelect, useBranches } from './BaseBranchSelect'
import { NotificationSettingsPanel } from './NotificationSettingsPanel'

export const projectSettingsKey = (path: string) =>
  window.desktop.platform === 'win32' ? path.toLowerCase() : path
const emptyDefaults: ProjectDefaults = {
  baseRef: 'HEAD',
  model: '',
  effort: '',
}

export function SettingsDialog({
  projects,
  currentProject,
  initialTab = 'general',
  connection,
  theme,
  onTheme,
  onClose,
}: {
  projects: Project[]
  currentProject: string
  initialTab?: 'general' | 'project'
  connection: CodexStatus
  theme: string
  onTheme: (theme: string) => void
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [tab, setTab] = useState<string>(initialTab)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [project, setProject] = useState(
    currentProject || projects[0]?.path || '',
  )
  const [defaults, setDefaults] = useState<ProjectDefaults>(emptyDefaults)
  const branchList = useBranches(project)
  const invalidBaseRef =
    branchList.loading || !!branchList.error ||
    (defaults.baseRef !== 'HEAD' && !branchList.branches.includes(defaults.baseRef))
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [notice, setNotice] = useState('')
  const busy = useRef(false)
  const disposed = useRef(false)
  const selectedModel =
    connection.models.find((item) => item.id === defaults.model) ??
    (!defaults.model
      ? (connection.models.find((item) => item.isDefault) ??
        connection.models[0])
      : undefined)
  const missingModel =
    !!defaults.model &&
    !connection.models.some((item) => item.id === defaults.model)
  async function loadData() {
    setLoadError('')
    const [settingsResult, infoResult] = await Promise.allSettled([
      window.desktop.getSettings(),
      window.desktop.getAppInfo(),
    ])
    if (disposed.current) return
    if (settingsResult.status === 'fulfilled') setSettings(settingsResult.value)
    if (infoResult.status === 'fulfilled') setInfo(infoResult.value)
    setLoadError(
      [settingsResult, infoResult]
        .flatMap((result) =>
          result.status === 'rejected' ? [String(result.reason)] : [],
        )
        .join('\n'),
    )
  }
  useEffect(() => {
    dialog.current?.showModal()
    disposed.current = false
    void loadData()
    return () => {
      disposed.current = true
    }
  }, [])
  useEffect(() => {
    setDefaults(
      settings?.projects[projectSettingsKey(project)] ?? emptyDefaults,
    )
  }, [project, settings])
  async function save(reset = false) {
    if (!project || busy.current || !settings || (!reset && invalidBaseRef)) return
    busy.current = true
    setPending(true)
    setError('')
    setNotice('')
    try {
      const next = reset
        ? await window.desktop.resetProjectSettings(project)
        : await window.desktop.updateProjectSettings(project, defaults)
      setSettings(next)
      setNotice(
        reset
          ? '이 프로젝트의 기본값을 초기화했습니다.'
          : '프로젝트 기본값을 저장했습니다. 다음 새 작업부터 적용됩니다.',
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      busy.current = false
      setPending(false)
    }
  }
  return (
    <dialog
      ref={dialog}
      className="form-dialog settings-dialog"
      aria-labelledby="settings-title"
      onCancel={(event) => {
        if (pending) event.preventDefault()
        else onClose()
      }}
    >
      <div className="settings-heading">
        <h2 id="settings-title">설정</h2>
        <Button variant="ghost" size="sm" disabled={pending} onClick={onClose}>
          닫기
        </Button>
      </div>
      <div role="tablist" aria-label="설정 분류" className="settings-tabs">
        {[
          ['general', '일반'],
          ['project', '프로젝트'],
          ['about', '프로그램 정보'],
        ].map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            aria-controls={`settings-${id}`}
            id={`settings-tab-${id}`}
            disabled={pending}
            onClick={() => {
              setTab(id)
              setError('')
              setNotice('')
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {loadError && (
        <div className="settings-load-error">
          <p role="alert">설정을 읽지 못했습니다. {loadError}</p>
          <Button size="sm" variant="outline" onClick={() => void loadData()}>
            다시 불러오기
          </Button>
        </div>
      )}
      <section
        role="tabpanel"
        id={`settings-${tab}`}
        aria-labelledby={`settings-tab-${tab}`}
        className="settings-content"
      >
        {tab === 'general' && (
          <>
            <h3>화면</h3>
            <label>
              테마
              <select
                aria-label="설정 테마"
                value={theme}
                onChange={(event) => onTheme(event.target.value)}
              >
                <option value="dark">다크</option>
                <option value="light">라이트</option>
              </select>
            </label>
            {settings && <NotificationSettingsPanel initial={settings.notifications}
              onSaved={(notifications) => setSettings({ ...settings, notifications })} />}
            <h3>앱 업데이트</h3>
            <UpdatePanel />
          </>
        )}
        {tab === 'project' && (
          <>
            <h3>새 작업 기본값</h3>
            <p>
              새 Worktree를 만들 때 사용할 기준 브랜치와 Codex 설정입니다. 기존
              작업에는 적용하지 않습니다. 원격 브랜치는 마지막으로 가져온 상태를
              사용합니다.
            </p>
            {!projects.length ? (
              <p>프로젝트를 먼저 열어 주세요.</p>
            ) : (
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  void save()
                }}
              >
                <fieldset disabled={pending || !settings}>
                  <label>
                    프로젝트
                    <select
                      aria-label="설정 프로젝트"
                      value={project}
                      onChange={(event) => {
                        setProject(event.target.value)
                        setNotice('')
                        setError('')
                      }}
                    >
                      {projects.map((item) => (
                        <option key={item.path} value={item.path}>
                          {item.name} · {item.path}
                        </option>
                      ))}
                    </select>
                  </label>
                  <BaseBranchSelect
                    label="기본 기준 브랜치"
                    ariaLabel="기본 기준 브랜치"
                    value={defaults.baseRef}
                    onChange={(baseRef) => setDefaults({ ...defaults, baseRef })}
                    {...branchList}
                  />
                  <label>
                    기본 모델
                    <select
                      aria-label="기본 모델"
                      value={defaults.model}
                      onChange={(event) =>
                        setDefaults({
                          ...defaults,
                          model: event.target.value,
                          effort: '',
                        })
                      }
                    >
                      <option value="">Codex 기본 모델</option>
                      {missingModel && (
                        <option value={defaults.model}>
                          {defaults.model} (현재 사용 불가)
                        </option>
                      )}
                      {connection.models.map((item) => (
                        <option value={item.id} key={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {missingModel && (
                    <p>
                      저장된 모델을 현재 연결에서 확인할 수 없습니다. 설정은
                      보존되며 새 작업에서 사용 가능한 모델을 선택해야 합니다.
                    </p>
                  )}
                  <label>
                    기본 추론 수준
                    <select
                      aria-label="기본 추론 수준"
                      value={defaults.effort}
                      onChange={(event) =>
                        setDefaults({ ...defaults, effort: event.target.value })
                      }
                    >
                      <option value="">모델 기본값</option>
                      {defaults.effort &&
                        !selectedModel?.efforts.includes(defaults.effort) && (
                          <option value={defaults.effort}>
                            {defaults.effort} (현재 확인 불가)
                          </option>
                        )}
                      {selectedModel?.efforts.map((effort) => (
                        <option value={effort} key={effort}>
                          {effort}
                        </option>
                      ))}
                    </select>
                  </label>
                </fieldset>
                <div className="dialog-actions">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={pending || !settings}
                    onClick={() => void save(true)}
                  >
                    프로젝트 기본값 초기화
                  </Button>
                  <Button
                    type="submit"
                    disabled={pending || !settings || invalidBaseRef}
                  >
                    {pending ? '저장 중…' : '저장'}
                  </Button>
                </div>
              </form>
            )}
          </>
        )}
        {tab === 'about' && (
          <>
            <h3>{info?.name ?? '프로그램 정보'}</h3>
            {info && (
              <dl className="app-info">
                {[
                  ['이름', info.name],
                  ['버전', info.version],
                  [
                    '빌드 날짜 (UTC)',
                    info.buildTime
                      ? `${info.buildTime} (UTC)`
                      : '개발 실행 · 빌드 날짜 없음',
                  ],
                  ['Git 주소', info.repositoryUrl],
                  ['Git commit', info.commit ?? '확인 불가'],
                  [
                    '소스 상태',
                    info.dirty === null
                      ? '확인 불가'
                      : info.dirty
                        ? '빌드 당시 미커밋 변경 있음'
                        : '빌드 당시 변경 없음',
                  ],
                  ['운영체제 / 아키텍처', `${info.platform} / ${info.arch}`],
                  [
                    'Electron / Node.js',
                    `${info.electronVersion} / ${info.nodeVersion}`,
                  ],
                  ['실행 환경', info.packaged ? '배포 앱' : '개발 실행'],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            )}
            <div className="dialog-actions">
              <Button
                variant="outline"
                disabled={!info}
                onClick={() =>
                  void window.desktop
                    .copyAppInfo()
                    .then(() => setNotice('프로그램 정보를 복사했습니다.'))
                    .catch((cause) => setError(String(cause)))
                }
              >
                정보 복사
              </Button>
              <Button
                disabled={!info}
                onClick={() =>
                  info &&
                  void window.desktop
                    .openLink(info.repositoryUrl)
                    .catch((cause) => setError(String(cause)))
                }
              >
                GitHub 열기
              </Button>
            </div>
          </>
        )}
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
      </section>
    </dialog>
  )
}
