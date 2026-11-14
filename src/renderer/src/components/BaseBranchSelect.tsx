import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from './ui/button'

export function useBranches(projectPath: string) {
  const [branches, setBranches] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let disposed = false
    setLoading(true)
    setError('')
    setBranches([])
    if (!projectPath) {
      setLoading(false)
      return
    }
    void window.desktop
      .listBranches(projectPath)
      .then((refs) => {
        if (!disposed) setBranches(refs)
      })
      .catch((cause) => {
        if (!disposed)
          setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (!disposed) setLoading(false)
      })
    return () => {
      disposed = true
    }
  }, [projectPath, revision])
  return {
    branches,
    loading,
    error,
    refresh: () => {
      setLoading(true)
      setRevision((value) => value + 1)
    },
  }
}

export function BaseBranchSelect({
  label,
  ariaLabel,
  value,
  onChange,
  branches,
  loading,
  error,
  refresh,
}: {
  label: string
  ariaLabel: string
  value: string
  onChange: (ref: string) => void
} & ReturnType<typeof useBranches>) {
  const missing = value !== 'HEAD' && !branches.includes(value)
  return (
    <div className="base-branch-field">
      <div className="base-branch-controls">
        <label>
          {label}
          <select
            aria-label={ariaLabel}
            value={value}
            disabled={loading || !!error}
            onChange={(event) => onChange(event.target.value)}
          >
            <option value="HEAD">프로젝트의 현재 HEAD</option>
            {missing && <option value={value}>{value} (현재 확인 불가)</option>}
            {[
              ['로컬 브랜치', 'refs/heads/'],
              ['원격 브랜치', 'refs/remotes/'],
            ].map(([group, prefix]) => {
              const refs = branches.filter((ref) => ref.startsWith(prefix))
              return refs.length > 0 && (
                <optgroup label={group} key={prefix}>
                  {refs.map((ref) => (
                    <option key={ref} value={ref}>
                      {ref.slice(prefix.length)}
                    </option>
                  ))}
                </optgroup>
              )
            })}
          </select>
        </label>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label="브랜치 목록 새로고침"
          title="로컬에 저장된 브랜치 목록 다시 읽기"
          disabled={loading}
          onClick={refresh}
        >
          <RefreshCw size={14} />
        </Button>
      </div>
      {loading && <p role="status">브랜치 목록을 불러오는 중…</p>}
      {error && <p role="alert">브랜치 목록을 불러오지 못했습니다. {error}</p>}
      {!loading && !error && missing && (
        <p role="alert">
          저장된 기준 브랜치가 없습니다. 사용할 브랜치를 다시 선택해 주세요.
        </p>
      )}
      <p>
        생성할 때마다 원격 최신 형상을 가져옵니다. HEAD와 로컬 브랜치는 추적
        브랜치(없으면 origin 또는 유일한 원격의 같은 이름 브랜치)의 최신 커밋을
        사용합니다. 연결된 원격 브랜치가 없으면 로컬 커밋을 사용합니다.
      </p>
    </div>
  )
}
