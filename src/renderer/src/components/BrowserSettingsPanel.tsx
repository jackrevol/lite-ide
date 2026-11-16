import { useState } from 'react'
import { browserOptions, type BrowserSettings, type BrowserCheck } from '../../../shared/browser'
import type { AppSettings } from '../../../shared/types'
import { Button } from './ui/button'

export function BrowserSettingsPanel({ initial, onSaved }: {
  initial: BrowserSettings
  onSaved: (settings: AppSettings) => void
}) {
  const [settings, setSettings] = useState(initial)
  const [pending, setPending] = useState<'save' | 'check' | null>(null)
  const [result, setResult] = useState<BrowserCheck | null>(null)
  async function run(action: 'save' | 'check') {
    if (pending) return
    setPending(action)
    setResult(null)
    try {
      if (action === 'check') setResult(await window.desktop.checkBrowser(settings))
      else {
        const next = await window.desktop.updateBrowserSettings(settings)
        onSaved(next)
        setSettings(next.browser)
        setResult({ ok: true, message: '브라우저 설정을 저장했습니다. 새 Codex 대화부터 적용됩니다.' })
      }
    } catch (error) {
      setResult({ ok: false, message: error instanceof Error ? error.message : String(error) })
    } finally { setPending(null) }
  }
  return <section className="settings-section browser-settings-panel">
    <h3>Codex 브라우저</h3>
    <label className="settings-inline-field">
      사용할 브라우저
      <select aria-label="Codex 브라우저" value={settings.browser} disabled={!!pending}
        onChange={(event) => {
          setSettings({ browser: event.target.value as BrowserSettings['browser'] })
          setResult(null)
        }}>
        {browserOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
    <p>선택한 브라우저가 PC에 설치되어 있어야 합니다. Codex가 필요할 때 독립된 세션으로 백그라운드 실행하며, 개인 브라우저의 탭과 로그인은 공유하지 않습니다.</p>
    <p>새 Codex 대화부터 자동 연결됩니다. 기존 대화와 실행 중인 작업은 현재 연결을 유지합니다.</p>
    <div className="dialog-actions">
      <Button size="sm" variant="outline" disabled={!!pending || settings.browser === 'disabled'} onClick={() => void run('check')}>
        {pending === 'check' ? '연결 확인 중…' : '브라우저 연결 확인'}
      </Button>
      <Button size="sm" disabled={!!pending} onClick={() => void run('save')}>
        {pending === 'save' ? '저장 중…' : '브라우저 설정 저장'}
      </Button>
    </div>
    {result && <p role={result.ok ? 'status' : 'alert'} className="browser-check-result">{result.message}</p>}
  </section>
}
