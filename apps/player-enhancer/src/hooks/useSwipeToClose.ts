import { useRef } from 'react'

// Minimum horizontal travel before a swipe counts as "close", and the angle budget that keeps
// a mostly-vertical drag (scrolling the grid, FrameGrid's long-press multi-select) from being
// misread as a dismiss gesture. Mirrors the seek/swipe disambiguation in useGestures.ts.
const MIN_DELTA_PX = 70
const MAX_ANGLE_DEG = 35

interface SwipeState {
  active: boolean
  fired: boolean
  startX: number
  startY: number
}

/**
 * Returns touch handlers that call `onClose` once a single-finger swipe travels right by at
 * least `MIN_DELTA_PX` within `MAX_ANGLE_DEG` of horizontal. Spread onto the modal's outermost
 * element — FrameGrid's own drag-select only engages after a 400ms long-press, so a quick swipe
 * completes (and is recognized here) well before that timer could claim the gesture too.
 */
export function useSwipeToClose(onClose: () => void, enabled: boolean) {
  const sRef = useRef<SwipeState>({ active: false, fired: false, startX: 0, startY: 0 })

  return {
    onTouchStart: (e: React.TouchEvent) => {
      if (!enabled || e.touches.length !== 1) { sRef.current.active = false; return }
      const t = e.touches[0]
      sRef.current = { active: true, fired: false, startX: t.clientX, startY: t.clientY }
    },
    onTouchMove: (e: React.TouchEvent) => {
      const s = sRef.current
      if (!s.active || s.fired || e.touches.length !== 1) return
      const t = e.touches[0]
      const dx = t.clientX - s.startX
      const dy = t.clientY - s.startY
      if (dx < MIN_DELTA_PX) return
      const angle = Math.atan2(Math.abs(dy), Math.abs(dx)) * 180 / Math.PI
      if (angle > MAX_ANGLE_DEG) return
      s.fired = true
      onClose()
    },
    onTouchEnd: () => { sRef.current.active = false },
    onTouchCancel: () => { sRef.current.active = false },
  }
}
