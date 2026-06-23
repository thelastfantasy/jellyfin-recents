import { useEffect, useRef,useState } from 'react'

import {
  getHwDecodeSettings,
  type HwDecodeSettingsDto,
  setHwDecodeSettings,
} from '../api/frameExportQueueApi'
import {
  getEnhancerStatus,
  getGestureConfig,
  injectEnhancer,
  removeEnhancer,
  setGestureConfig,
} from '../api/playerEnhancerApi'
import { useLocale } from '../i18n/context'

interface Props {
  onClose: () => void
}

type Hint = 'reload' | 'error' | null

export function PlayerEnhancerPanel({ onClose }: Props) {
  const { t } = useLocale()
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState<Hint>(null)
  const [seekSeconds, setSeekSeconds] = useState(10)
  const [speedRate, setSpeedRate] = useState(2.0)
  const [trickplayEnabled, setTrickplayEnabled] = useState(true)
  const [hwDecode, setHwDecode] = useState<HwDecodeSettingsDto | null>(null)

  // Keep refs so auto-save callbacks always see latest values
  const seekRef = useRef(seekSeconds)
  const speedRef = useRef(speedRate)
  const trickRef = useRef(trickplayEnabled)
  useEffect(() => { seekRef.current  = seekSeconds },      [seekSeconds])
  useEffect(() => { speedRef.current = speedRate },        [speedRate])
  useEffect(() => { trickRef.current = trickplayEnabled }, [trickplayEnabled])

  useEffect(() => {
    getEnhancerStatus()
      .then((s) => setEnabled(s.autoInjectEnabled))
      .catch(() => setEnabled(false))
    getGestureConfig()
      .then((cfg) => {
        setTrickplayEnabled(cfg.trickplayEnabled ?? true)
        setSeekSeconds(cfg.seekSeconds)
        setSpeedRate(cfg.speedRate ?? 2.0)
      })
      .catch(() => {})
    getHwDecodeSettings()
      .then(setHwDecode)
      .catch(() => {})
  }, [])

  function updateHwDecode(patch: Partial<{ enabled: boolean; deviceStrategy: string }>) {
    if (!hwDecode) return
    const next = { ...hwDecode, ...patch }
    setHwDecode(next)
    setHwDecodeSettings({ enabled: next.enabled, deviceStrategy: next.deviceStrategy })
      .then(setHwDecode)
      .catch(() => getHwDecodeSettings().then(setHwDecode).catch(() => {}))
  }

  async function saveConfig(patch: Partial<{ trickplayEnabled: boolean; seekSeconds: number; speedRate: number }>) {
    const cfg = {
      trickplayEnabled: trickRef.current,
      seekSeconds: seekRef.current,
      speedRate: speedRef.current,
      ...patch,
    }
    try {
      await setGestureConfig(cfg)
      window.dispatchEvent(new CustomEvent('jfs:seekSecondsChanged', { detail: { seconds: cfg.seekSeconds } }))
      window.dispatchEvent(new CustomEvent('jfs:speedRateChanged', { detail: { rate: cfg.speedRate } }))
      window.dispatchEvent(new CustomEvent('jfs:trickplayEnabledChanged', { detail: { enabled: cfg.trickplayEnabled } }))
    } catch {
      // best-effort
    }
  }

  async function handleInject() {
    setBusy(true)
    setHint(null)
    try {
      await injectEnhancer()
      setEnabled(true)
      setHint('reload')
    } catch {
      setHint('error')
    } finally {
      setBusy(false)
    }
  }

  async function handleRemove() {
    setBusy(true)
    setHint(null)
    try {
      await removeEnhancer()
      setEnabled(false)
      setHint('reload')
    } catch {
      setHint('error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="jfs-poster-settings-modal jfs-enhancer-panel">
      <div className="jfs-poster-settings-modal__header">
        <span>{t.enhancerTitle}</span>
        <button className="jfs-poster-settings-modal__close" onClick={onClose}>✕</button>
      </div>
      <div className="jfs-poster-settings-modal__body jfs-enhancer-panel__body">
        <p className="jfs-enhancer-panel__index-note">{t.enhancerIndexHtmlNote}</p>
        <p className="jfs-enhancer-panel__browser-note">{t.enhancerBrowserNote}</p>
        <p className={`jfs-enhancer-panel__status${enabled ? ' jfs-enhancer-panel__status--on' : ''}`}>
          {enabled === null ? '…' : enabled ? t.enhancerStatusEnabled : t.enhancerStatusDisabled}
        </p>
        <div className="jfs-enhancer-panel__actions">
          <button className="jfs-btn" disabled={busy} onClick={handleInject}>
            {t.enhancerInject}
          </button>
          <button className="jfs-btn jfs-btn--danger" disabled={busy} onClick={handleRemove}>
            {t.enhancerRemove}
          </button>
        </div>
        {hint === 'reload' && <p className="jfs-enhancer-panel__hint jfs-enhancer-panel__hint--ok">{t.enhancerReloadHint}</p>}
        {hint === 'error' && <p className="jfs-enhancer-panel__hint jfs-enhancer-panel__hint--err">{t.enhancerErrorHint}</p>}

        <div className="jfs-enhancer-panel__seek-row">
          <label className="jfs-enhancer-panel__seek-label">{t.enhancerTrickplayLabel}</label>
          <div className="jfs-enhancer-panel__seek-input-wrap">
            <input
              type="checkbox"
              className="jfs-enhancer-panel__checkbox"
              checked={trickplayEnabled}
              onChange={(e) => {
                const val = (e.target as HTMLInputElement).checked
                setTrickplayEnabled(val)
                saveConfig({ trickplayEnabled: val })
              }}
            />
          </div>
        </div>
        <p className="jfs-enhancer-panel__hwdecode-note">{t.enhancerHwDecodeHint}</p>
        <div className="jfs-enhancer-panel__seek-row">
          <label className="jfs-enhancer-panel__seek-label">{t.enhancerHwDecodeLabel}</label>
          <div className="jfs-enhancer-panel__seek-input-wrap">
            <input
              type="checkbox"
              className="jfs-enhancer-panel__checkbox"
              checked={hwDecode?.enabled ?? true}
              disabled={!hwDecode || hwDecode.supported === false}
              onChange={(e) => updateHwDecode({ enabled: (e.target as HTMLInputElement).checked })}
            />
            {hwDecode?.multiDeviceAvailable && hwDecode.enabled && (
              <select
                className="jfs-enhancer-panel__select"
                value={hwDecode.deviceStrategy}
                onChange={(e) => updateHwDecode({ deviceStrategy: (e.target as HTMLSelectElement).value })}
              >
                <option value="performance" title={t.enhancerHwDecodeStrategyPerformanceHint}>{t.enhancerHwDecodeStrategyPerformance}</option>
                <option value="idle-resource" title={t.enhancerHwDecodeStrategyIdleHint}>{t.enhancerHwDecodeStrategyIdle}</option>
              </select>
            )}
          </div>
        </div>
        {hwDecode?.multiDeviceAvailable && hwDecode.enabled && (
          <p className="jfs-enhancer-panel__hwdecode-note">
            {hwDecode.deviceStrategy === 'idle-resource' ? t.enhancerHwDecodeStrategyIdleHint : t.enhancerHwDecodeStrategyPerformanceHint}
          </p>
        )}
        {hwDecode?.supported === false && (
          <p className="jfs-enhancer-panel__hint">
            {t.enhancerHwDecodeUnsupported.replace('{reason}', hwDecode.unsupportedReason ?? '')}
          </p>
        )}
        <div className="jfs-enhancer-panel__seek-row">
          <label className="jfs-enhancer-panel__seek-label">{t.enhancerSeekLabel}</label>
          <div className="jfs-enhancer-panel__seek-input-wrap">
            <input
              type="number"
              className="jfs-enhancer-panel__seek-input"
              min={0.5}
              max={30}
              step={0.5}
              value={seekSeconds}
              onClick={(e) => (e.target as HTMLInputElement).select()}
              onInput={(e) => {
                const v = parseFloat((e.target as HTMLInputElement).value)
                setSeekSeconds(isNaN(v) ? 10 : Math.min(30, Math.max(0.5, v)))
              }}
              onBlur={() => saveConfig({ seekSeconds })}
            />
            <span className="jfs-enhancer-panel__seek-unit">{t.enhancerSeekUnit}</span>
          </div>
        </div>
        <div className="jfs-enhancer-panel__seek-row">
          <label className="jfs-enhancer-panel__seek-label">{t.enhancerSpeedLabel}</label>
          <div className="jfs-enhancer-panel__seek-input-wrap">
            <input
              type="number"
              className="jfs-enhancer-panel__seek-input"
              min={1.25}
              max={4}
              step={0.25}
              value={speedRate}
              onClick={(e) => (e.target as HTMLInputElement).select()}
              onInput={(e) => {
                const v = parseFloat((e.target as HTMLInputElement).value)
                setSpeedRate(isNaN(v) ? 2.0 : Math.min(4, Math.max(1.25, v)))
              }}
              onBlur={() => saveConfig({ speedRate })}
            />
            <span className="jfs-enhancer-panel__seek-unit">{t.enhancerSpeedUnit}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
