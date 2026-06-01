import { useState, useEffect, useRef } from 'react'
import { useLocale } from '../i18n/context'
import {
  getEnhancerStatus,
  injectEnhancer,
  removeEnhancer,
  getGestureConfig,
  setGestureConfig,
} from '../api/playerEnhancerApi'

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
  }, [])

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
