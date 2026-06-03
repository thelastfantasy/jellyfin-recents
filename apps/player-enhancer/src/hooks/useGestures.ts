import { useEffect } from 'react'
import { showRipple, showValueOsd, showSeekOsd, hideSeekOsd } from '../components/OsdOverlay'
import { cancelPendingLongPress, isLongPressActive } from './useLongPress'
import { showTrickplayThumb, hideTrickplayThumb, prefetchFrame } from '../services/trickplay'
import { clamp } from '../lib/utils'

// Suppress Jellyfin's dblclick handler (fullscreen toggle) on touch devices — runs once on import.
if (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0) {
  document.addEventListener('dblclick', (e: Event) => {
    e.stopImmediatePropagation()
    e.preventDefault()
  }, { capture: true })
}

// Module-level settings, updated by injector via setters below.
let _seekSeconds = 10
let _suspended   = false

export function setSeekSeconds(s: number): void  { _seekSeconds = s }
export function setGesturesSuspended(v: boolean): void { _suspended = v }

type Zone = 'left' | 'center' | 'right'
type GestureMode = 'idle' | 'pending' | 'seek' | 'swipe'

interface GestureState {
  mode: GestureMode
  startX: number; startY: number; lastX: number; lastMoveTime: number
  seekAnchorSec: number; seekOffsetSec: number
  lastThumbX: number; lastThumbAlignedMs: number; lastThumbMoveTime: number
  swipeSide: 'left' | 'right'; swipeStartValue: number
}

function thumbDeadZonePx(): number {
  return Math.max(2, Math.min(8, Math.round(window.innerWidth * 0.004)))
}

function computeAlignMs(velPxPerMs: number, dur: number): number {
  const sPerVw = Math.min(6, Math.max(1.2, dur * 0.002))
  const videoVelSecPerSec = velPxPerMs * 1000 * sPerVw * 100 / window.innerWidth
  if (videoVelSecPerSec > 30) return 5000
  if (videoVelSecPerSec > 10) return 2000
  if (videoVelSecPerSec >  3) return 1000
  if (videoVelSecPerSec >  1) return 500
  return 100
}

function isOsdControl(target: EventTarget | null): boolean {
  let el = target as Element | null
  while (el && el !== document.body) {
    const tag = el.tagName
    if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'LABEL') return true
    if (el.classList.contains('osdControls'))                    return true
    if (el.classList.contains('sliderContainer'))                return true
    if (el.classList.contains('jfs-enhancer-screenshot-wrap'))   return true
    if (el.classList.contains('jfs-enhancer-framestep-wrap'))    return true
    el = el.parentElement
  }
  return false
}

export function useGestures(videoEl: HTMLVideoElement | null, getItemId: () => string): void {
  useEffect(() => {
    if (!videoEl || navigator.maxTouchPoints <= 0) return

    const abort = new AbortController()
    const sig = abort.signal

    let lastTap: { time: number; zone: Zone } = { time: 0, zone: 'center' }
    const gs: GestureState = {
      mode: 'idle',
      startX: 0, startY: 0, lastX: 0, lastMoveTime: 0,
      seekAnchorSec: 0, seekOffsetSec: 0,
      lastThumbX: 0, lastThumbAlignedMs: -1, lastThumbMoveTime: 0,
      swipeSide: 'left', swipeStartValue: 1,
    }

    // ── Double-tap seek ───────────────────────────────────────────────────────
    document.body.addEventListener('touchend', (e: TouchEvent) => {
      if (!videoEl.isConnected) return
      if (isOsdControl(e.target)) return
      const touch = e.changedTouches[0]
      if (!touch) return
      const now = Date.now()
      const x = touch.clientX
      const W = window.innerWidth
      const zone: Zone = x < W / 3 ? 'left' : x < (W * 2) / 3 ? 'center' : 'right'

      if (now - lastTap.time < 300 && zone === lastTap.zone) {
        e.stopImmediatePropagation()
        e.preventDefault()
        cancelPendingLongPress()
        if (zone === 'left') {
          videoEl.currentTime = Math.max(0, videoEl.currentTime - _seekSeconds)
          showRipple('left', `-${_seekSeconds}s`)
        } else if (zone === 'right') {
          videoEl.currentTime = Math.min(videoEl.duration || 0, videoEl.currentTime + _seekSeconds)
          showRipple('right', `+${_seekSeconds}s`)
        } else {
          if (videoEl.paused) videoEl.play().catch(() => {})
          else videoEl.pause()
        }
        lastTap = { time: 0, zone: 'center' }
      } else {
        lastTap = { time: now, zone }
      }
    }, { capture: true, passive: false, signal: sig })

    // ── Touch state machine ───────────────────────────────────────────────────
    document.body.addEventListener('touchstart', (e: TouchEvent) => {
      if (!videoEl.isConnected) return
      if (_suspended) { gs.mode = 'idle'; return }
      if (e.touches.length !== 1) { gs.mode = 'idle'; return }
      if (isOsdControl(e.target)) { gs.mode = 'idle'; return }
      const touch = e.touches[0]
      if (touch.clientY < window.innerHeight * 0.10) { gs.mode = 'idle'; return }

      gs.mode = 'pending'
      gs.startX = gs.lastX = touch.clientX
      gs.startY = touch.clientY
      gs.lastMoveTime = Date.now()
      gs.seekAnchorSec = videoEl.currentTime
      gs.seekOffsetSec = 0
      gs.lastThumbX = touch.clientX
      gs.lastThumbAlignedMs = -1
      gs.swipeSide = touch.clientX < window.innerWidth / 2 ? 'left' : 'right'
      gs.swipeStartValue = gs.swipeSide === 'left'
        ? parseFloat(videoEl.style.filter.replace('brightness(', '').replace(')', '') || '1')
        : videoEl.volume
    }, { passive: true, signal: sig })

    document.body.addEventListener('touchmove', (e: TouchEvent) => {
      if (!videoEl.isConnected || gs.mode === 'idle') return
      if (e.touches.length !== 1) { gs.mode = 'idle'; return }
      const touch = e.touches[0]

      if (gs.mode === 'pending') {
        const dx = touch.clientX - gs.startX
        const dy = touch.clientY - gs.startY
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return
        const deg = Math.atan2(Math.abs(dy), Math.abs(dx)) * 180 / Math.PI
        if (deg < 30) {
          if (isLongPressActive()) { gs.mode = 'idle'; return }
          gs.mode = 'seek'
          cancelPendingLongPress()
          document.body.classList.add('jfs-seeking')
        } else {
          gs.mode = 'swipe'
        }
      }

      if (gs.mode === 'seek') {
        const deltaX = touch.clientX - gs.lastX
        gs.lastX = touch.clientX
        const now = Date.now()
        const dt = (now - gs.lastMoveTime) || 1
        gs.lastMoveTime = now

        const dur = isFinite(videoEl.duration) ? videoEl.duration : 0
        const sPerVw = Math.min(6, Math.max(1.2, dur * 0.002))
        gs.seekOffsetSec += (deltaX / window.innerWidth * 100) * sPerVw
        const targetSec = Math.max(0, Math.min(dur, gs.seekAnchorSec + gs.seekOffsetSec))

        showSeekOsd(gs.seekOffsetSec, targetSec)

        const velPxPerMs = Math.abs(deltaX) / dt
        const targetMs = targetSec * 1000
        const itemId = getItemId()
        const exactAlignedMs = Math.round(targetMs / 100) * 100

        if (Math.abs(touch.clientX - gs.lastThumbX) >= thumbDeadZonePx()) {
          gs.lastThumbX = touch.clientX
          gs.lastThumbMoveTime = now
          const alignMs = computeAlignMs(velPxPerMs, dur)
          const shownMs = Math.floor(targetMs / alignMs) * alignMs
          if (velPxPerMs < 8) {
            prefetchFrame(targetMs - alignMs, itemId)
            prefetchFrame(targetMs,           itemId)
            prefetchFrame(targetMs + alignMs, itemId)
          }
          const dir = deltaX > 0 ? 1 : -1
          showTrickplayThumb(shownMs, itemId, videoEl, alignMs, dir)
          gs.lastThumbAlignedMs = shownMs
        } else if (now - gs.lastThumbMoveTime >= 150 && exactAlignedMs !== gs.lastThumbAlignedMs) {
          showTrickplayThumb(exactAlignedMs, itemId, videoEl, 100)
          gs.lastThumbAlignedMs = exactAlignedMs
        }
        return
      }

      if (gs.mode === 'swipe') {
        const deltaY = gs.startY - touch.clientY
        const delta = deltaY / (window.innerHeight * 0.5)
        if (gs.swipeSide === 'left') {
          const brightness = clamp(gs.swipeStartValue + delta, 0, 2.0)
          videoEl.style.filter = `brightness(${brightness})`
          showValueOsd('brightness', brightness * 100)
        } else {
          const volume = clamp(gs.swipeStartValue + delta, 0, 1)
          videoEl.volume = volume
          showValueOsd('volume', Math.pow(volume, 1 / 3) * 100)
        }
        e.preventDefault()
      }
    }, { passive: false, signal: sig })

    const onEnd = (): void => {
      if (gs.mode === 'seek') {
        const dur = isFinite(videoEl.duration) ? videoEl.duration : 0
        const snappedSec = Math.round((gs.seekAnchorSec + gs.seekOffsetSec) * 10) / 10
        videoEl.currentTime = Math.max(0, Math.min(dur, snappedSec))
        hideSeekOsd(800, () => hideTrickplayThumb())
        document.body.classList.remove('jfs-seeking')
      }
      gs.mode = 'idle'
    }
    document.body.addEventListener('touchend',    onEnd, { passive: true, signal: sig })
    document.body.addEventListener('touchcancel', onEnd, { passive: true, signal: sig })

    return () => abort.abort()
  }, [videoEl, getItemId])
}
