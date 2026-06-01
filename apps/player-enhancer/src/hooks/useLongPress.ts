import { useEffect } from 'react'
import { showSpeedOsd, hideSpeedOsd } from '../components/OsdOverlay'

const LONG_PRESS_MS   = 500
const DIR_SAMPLE_PX   = 12
const BOTTOM_FRACTION = 1 / 3

let _active = false
let _suppressContextMenuUntil = 0
let _cancelPending: (() => void) | null = null

export function cancelPendingLongPress(): void {
  _cancelPending?.()
}

export function isLongPressActive(): boolean {
  return _active
}

export function isInLongPressZone(touch: Touch, video: HTMLVideoElement): boolean {
  const r = video.getBoundingClientRect()
  return touch.clientY >= r.top + r.height * (1 - BOTTOM_FRACTION)
}

export function useLongPress(video: HTMLVideoElement | null, getRate: () => number): void {
  useEffect(() => {
    if (!video || navigator.maxTouchPoints <= 0) return
    const vid = video  // narrow to non-null for closures

    const abort = new AbortController()
    const sig = abort.signal

    let timer: ReturnType<typeof setTimeout> | null = null
    let startX = 0, startY = 0
    let wasPaused = false

    function enter(): void {
      _active = true
      wasPaused = vid.paused
      if (vid.paused) vid.play().catch(() => {})
      vid.playbackRate = getRate()
      try { navigator.vibrate(30) } catch { /* vibration API absent */ }
      updateOsd()
    }

    function exit(): void {
      _active = false
      _suppressContextMenuUntil = Date.now() + 800
      vid.playbackRate = 1
      if (wasPaused) vid.pause()
      hideSpeedOsd()
    }

    function updateOsd(): void {
      const rate = getRate()
      showSpeedOsd(rate % 1 === 0 ? `${rate}` : rate.toFixed(2))
    }

    document.body.addEventListener('touchstart', (e: TouchEvent) => {
      if (!vid.isConnected || e.touches.length !== 1) return
      if (vid.paused) return
      const t0 = e.touches[0]
      if (!isInLongPressZone(t0, vid)) return
      startX = t0.clientX; startY = t0.clientY
      timer = setTimeout(enter, LONG_PRESS_MS)
      _cancelPending = () => { if (timer) { clearTimeout(timer); timer = null } }
    }, { passive: true, signal: sig })

    document.addEventListener('contextmenu', (e: Event) => {
      if (!video.paused || Date.now() < _suppressContextMenuUntil) e.preventDefault()
    }, { capture: true, signal: sig })

    document.body.addEventListener('touchstart', (e: TouchEvent) => {
      if (e.touches.length > 1 && (_active || timer !== null)) {
        if (timer) { clearTimeout(timer); timer = null }
        if (_active) exit()
      }
    }, { passive: true, signal: sig })

    document.body.addEventListener('touchmove', (e: TouchEvent) => {
      if (!vid.isConnected) return
      const touch = e.touches[0]
      if (!touch) return

      if (!_active) {
        if (!timer) return
        const dx = touch.clientX - startX
        const dy = touch.clientY - startY
        if (Math.sqrt(dx * dx + dy * dy) < DIR_SAMPLE_PX) return
        clearTimeout(timer); timer = null
        return
      }

      updateOsd()
    }, { passive: true, signal: sig })

    const onEnd = (): void => {
      if (timer) { clearTimeout(timer); timer = null }
      if (_active) exit()
    }
    document.body.addEventListener('touchend',    onEnd, { passive: true, signal: sig })
    document.body.addEventListener('touchcancel', onEnd, { passive: true, signal: sig })

    return () => abort.abort()
  }, [video, getRate])
}
