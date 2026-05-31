import { signal } from '@preact/signals'
import { useEffect } from 'preact/hooks'
import { t } from '../lib/i18n'

// ── Ripple ────────────────────────────────────────────────────────────────────

interface RippleEntry { side: 'left' | 'right'; label: string; key: number }
let _rippleKey = 0
export const sRipple = signal<RippleEntry | null>(null)

export function showRipple(side: 'left' | 'right', label: string): void {
  sRipple.value = { side, label, key: ++_rippleKey }
}

function RippleEl() {
  const entry = sRipple.value
  useEffect(() => {
    if (!entry) return
    const k = entry.key
    const id = setTimeout(() => { if (sRipple.peek()?.key === k) sRipple.value = null }, 1000)
    return () => clearTimeout(id)
  }, [entry])
  if (!entry) return null
  return (
    <div class={`jfs-enhancer-ripple jfs-enhancer-ripple-${entry.side}`}>
      <div class="jfs-enhancer-ripple-bg">
        <div class="jfs-enhancer-ripple-arrows">
          {[0, 1, 2].map(i => (
            <span key={i} class="jfs-enhancer-ripple-arrow">
              {entry.side === 'right' ? '›' : '‹'}
            </span>
          ))}
        </div>
        <div class="jfs-enhancer-ripple-label">{entry.label}</div>
      </div>
    </div>
  )
}

// ── Seek OSD ──────────────────────────────────────────────────────────────────

interface SeekOsdState { line1: string; visible: boolean }
export const sSeekOsd = signal<SeekOsdState>({ line1: '', visible: false })
let _seekHideTimer: ReturnType<typeof setTimeout> | null = null

export function showSeekOsd(offsetSec: number, currentSec: number): void {
  if (_seekHideTimer) { clearTimeout(_seekHideTimer); _seekHideTimer = null }
  const sign = offsetSec >= 0 ? '+' : '−'
  const abs = Math.abs(offsetSec)
  const offsetStr = abs >= 60
    ? `${Math.floor(abs / 60)}m ${(abs % 60).toFixed(1)}s`
    : `${abs.toFixed(1)}s`
  const h = Math.floor(currentSec / 3600)
  const m = Math.floor((currentSec % 3600) / 60)
  const s = Math.floor(currentSec % 60)
  const ts = h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
  sSeekOsd.value = { line1: `${sign}${offsetStr}  →  ${ts}`, visible: true }
}

export function hideSeekOsd(delayMs = 0, onHide?: () => void): void {
  if (_seekHideTimer) clearTimeout(_seekHideTimer)
  const doHide = () => {
    sSeekOsd.value = { ...sSeekOsd.peek(), visible: false }
    onHide?.()
  }
  if (delayMs <= 0) {
    doHide()
  } else {
    _seekHideTimer = setTimeout(() => { _seekHideTimer = null; doHide() }, delayMs)
  }
}

// ── Speed OSD (long-press fast-forward) ───────────────────────────────────────

interface SpeedOsdState { rateText: string; visible: boolean }
export const sSpeedOsd = signal<SpeedOsdState>({ rateText: '', visible: false })

export function showSpeedOsd(rateText: string): void {
  const cur = sSpeedOsd.peek()
  if (cur.rateText === rateText && cur.visible) return
  sSpeedOsd.value = { rateText, visible: true }
}

export function hideSpeedOsd(): void {
  if (!sSpeedOsd.peek().visible) return
  sSpeedOsd.value = { ...sSpeedOsd.peek(), visible: false }
}

// ── Brightness / Volume OSD ───────────────────────────────────────────────────

interface ValueOsdState { pct: number; visible: boolean }
export const sBrightnessOsd = signal<ValueOsdState>({ pct: 0, visible: false })
export const sVolumeOsd = signal<ValueOsdState>({ pct: 0, visible: false })
let _bTimer: ReturnType<typeof setTimeout> | null = null
let _vTimer: ReturnType<typeof setTimeout> | null = null

export function showValueOsd(type: 'brightness' | 'volume', value: number): void {
  const pct = Math.round(value)
  if (type === 'brightness') {
    sBrightnessOsd.value = { pct, visible: true }
    if (_bTimer) clearTimeout(_bTimer)
    _bTimer = setTimeout(() => {
      sBrightnessOsd.value = { pct: sBrightnessOsd.peek().pct, visible: false }
      _bTimer = null
    }, 1500)
  } else {
    sVolumeOsd.value = { pct, visible: true }
    if (_vTimer) clearTimeout(_vTimer)
    _vTimer = setTimeout(() => {
      sVolumeOsd.value = { pct: sVolumeOsd.peek().pct, visible: false }
      _vTimer = null
    }, 1500)
  }
}

function ValueBar({ side, icon, label, state }: {
  side: 'left' | 'right'; icon: string; label: string; state: ValueOsdState
}) {
  return (
    <div class={`jfs-enhancer-osd jfs-enhancer-osd--${side}`} style={{ opacity: state.visible ? '1' : '0' }}>
      <div class="jfs-enhancer-osd__icon">{icon}</div>
      <div class="jfs-enhancer-osd__bar-track">
        <div class="jfs-enhancer-osd__bar-fill" style={{ height: `${Math.min(100, Math.max(0, state.pct))}%` }} />
      </div>
      <div class="jfs-enhancer-osd__pct">{state.pct}%</div>
      <div class="jfs-enhancer-osd__label">{label}</div>
    </div>
  )
}

// ── Root component ─────────────────────────────────────────────────────────────

export function OsdOverlay() {
  const seekOsd   = sSeekOsd.value
  const speedOsd  = sSpeedOsd.value
  const brightOsd = sBrightnessOsd.value
  const volOsd    = sVolumeOsd.value

  return (
    <>
      <RippleEl />
      {/* Always rendered so trickplay.ts can querySelector('.jfs-seek-osd') for positioning */}
      <div class="jfs-seek-osd" style={{ opacity: seekOsd.visible ? '1' : '0' }}>
        <div class="jfs-seek-osd__line1">{seekOsd.line1}</div>
      </div>
      <div class="jfs-speed-osd" style={{ opacity: speedOsd.visible ? '1' : '0' }}>
        {speedOsd.visible && (
          <div class="jfs-speed-osd__line1">
            ▶▶ {t('longpress.speeding').replace('{rate}', speedOsd.rateText)}
          </div>
        )}
      </div>
      <ValueBar side="left"  icon="☀"  label={t('osd.brightness')} state={brightOsd} />
      <ValueBar side="right" icon="🔊" label={t('osd.volume')}     state={volOsd} />
    </>
  )
}
