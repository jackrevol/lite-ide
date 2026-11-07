import { useEffect, useState } from 'react'
import type { NotificationSettings } from '../../../shared/types'
import { notificationSounds } from '../../../shared/notifications'
import { Button } from './ui/button'

export function NotificationSettingsPanel({ initial, onSaved }: {
  initial: NotificationSettings
  onSaved: (value: NotificationSettings) => void
}) {
  const [settings, setSettings] = useState(initial)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [supported, setSupported] = useState<boolean | null>(null)
  useEffect(() => { void window.desktop.notificationStatus().then((status) => setSupported(status.supported)).catch(() => {}) }, [])
  async function perform(action: () => Promise<void>) {
    setPending(true); setError(''); setNotice('')
    try { await action() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setPending(false) }
  }
  return <form className="notification-settings-panel" onSubmit={(event) => {
    event.preventDefault()
    void perform(async () => {
      const next = await window.desktop.updateNotificationSettings(settings)
      setSettings(next.notifications); onSaved(next.notifications)
      setNotice('알림 설정을 저장했습니다.')
    })
  }}>
    <h3>Codex 응답 대기 알림</h3>
    <p>Codex가 질문, 승인 또는 계획 확인을 기다리면 데스크톱 알림을 표시합니다. 다른 작업을 보거나 앱을 최소화해도 알려드립니다.</p>
    {supported === false && <p>현재 환경에서 데스크톱 알림을 사용할 수 없습니다.</p>}
    <p>운영체제의 알림 권한과 방해 금지 설정에 따라 알림이 표시되지 않을 수 있습니다.</p>
    <fieldset disabled={pending} className="notification-settings">
      <label className="notification-toggle"><input type="checkbox" checked={settings.enabled}
        onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })} />데스크톱 알림 사용</label>
      <label className="notification-toggle"><input type="checkbox" checked={settings.soundEnabled} disabled={!settings.enabled}
        onChange={(event) => setSettings({ ...settings, soundEnabled: event.target.checked })} />알림 소리 사용</label>
      <label>알림음<select aria-label="알림음" value={settings.sound}
        onChange={(event) => setSettings({ ...settings, sound: event.target.value as NotificationSettings['sound'] })}>
        {notificationSounds.map((sound) => <option key={sound.id} value={sound.id}>{sound.name}</option>)}
        {settings.customSound && <option value="custom">사용자 음원 · {settings.customSound.name}</option>}
      </select></label>
      <label>알림음 볼륨 · {settings.volume}%<input type="range" aria-label="알림음 볼륨" min="0" max="100" step="1" value={settings.volume}
        onChange={(event) => setSettings({ ...settings, volume: Number(event.target.value) })} /></label>
      <p>사용자 음원: WAV, MP3, OGG · 최대 10MB. 파일을 앱에 복사하여 보관하며 최대 5초 재생합니다.</p>
      <div className="dialog-actions">
        <Button type="button" variant="outline" onClick={() => void perform(async () => {
          const customSound = await window.desktop.chooseNotificationSound()
          if (customSound) setSettings({ ...settings, customSound, sound: 'custom' })
        })}>음원 파일 선택</Button>
        {settings.customSound && <Button type="button" variant="outline" onClick={() => {
          const { customSound: _custom, ...next } = settings
          setSettings({ ...next, sound: settings.sound === 'custom' ? 'chime' : settings.sound })
        }}>사용자 음원 제거</Button>}
        <Button type="button" variant="outline" onClick={() => void perform(async () => {
          await window.desktop.previewNotificationSound(settings)
          setNotice('선택한 알림음을 미리듣기했습니다.')
        })}>미리듣기</Button>
        <Button type="submit">알림 설정 저장</Button>
      </div>
    </fieldset>
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </form>
}
