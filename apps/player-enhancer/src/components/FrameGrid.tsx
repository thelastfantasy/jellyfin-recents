import { useAtomValue } from 'jotai'
import { useCallback, useEffect, useRef, useState } from 'react'

import { frameUrl } from '../api/frameExportApi'
import {
  _dragMode, _dragSelectValue, _frames,   _itemId, _lastClickedIdx, _suppressNextMousedown,
framesAtom, modalPhaseAtom,
setDragMode, setDragSelectValue, setFrames, setLastClickedIdx, setSuppressNextMousedown,
  sLightboxIdx, } from '../core/state'
import { cleanItemTitle, formatTime, triggerDownload } from '../lib/utils'
import { FrameCard } from './FrameCard'

let _itemTitle = ''

function cardIdxAt(x: number, y: number): number {
  const element = document.elementFromPoint(x, y) as HTMLElement | null
  const card = element?.closest<HTMLElement>('.jfs-fe-card')
  if (!card) return -1
  const index = parseInt(card.dataset.idx ?? '')
  return (isNaN(index) || !_frames[index]) ? -1 : index
}

export function FrameGrid() {
  const frames  = useAtomValue(framesAtom)
  const phase   = useAtomValue(modalPhaseAtom)
  const gridRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pressingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const autoScrollRaf = useRef<number | null>(null)
  const lastTouchXY    = useRef({ x: 0, y: 0 })

  const [pressingIdx, setPressingIdx] = useState<number | null>(null)

  function dragSelectAt(x: number, y: number): void {
    const idx = cardIdxAt(x, y)
    if (idx < 0 || _frames[idx].selected === _dragSelectValue) return
    _frames[idx].selected = _dragSelectValue
    setFrames([..._frames])
  }

  // ── 1. Effects ──────────────────────────────────────────────────────────────

  useEffect(() => {
    const grid   = gridRef.current
    const scroll = scrollRef.current
    if (!grid) return

    const EDGE_ZONE        = 64
    const MAX_SCROLL_SPEED = 8

    function runAutoScroll(speed: number): void {
      if (!scroll) return
      scroll.scrollTop += speed
      dragSelectAt(lastTouchXY.current.x, lastTouchXY.current.y)
      autoScrollRaf.current = requestAnimationFrame(() => runAutoScroll(speed))
    }

    function cancelAutoScroll(): void {
      if (autoScrollRaf.current !== null) {
        cancelAnimationFrame(autoScrollRaf.current)
        autoScrollRaf.current = null
      }
    }

    const onMouseOver = (e: MouseEvent) => {
      if (!_dragMode) return
      dragSelectAt(e.clientX, e.clientY)
    }

    const onMouseUp = () => {
      if (_dragMode) setFrames([..._frames])
      setDragMode(false)
    }

    const onTouchStart = (e: TouchEvent) => {
      const touch = e.touches[0]
      const idx = cardIdxAt(touch.clientX, touch.clientY)
      if (idx < 0) return
      setPressingIdx(idx)
      pressingTimer.current = setTimeout(() => {
        pressingTimer.current = null; setPressingIdx(null); setDragMode(true)
        _frames[idx].selected = !_frames[idx].selected
        setDragSelectValue(_frames[idx].selected)
        setLastClickedIdx(idx)
        setFrames([..._frames])
        if ('vibrate' in navigator) navigator.vibrate(25)
      }, 400)
    }

    const onTouchMove = (e: TouchEvent) => {
      if (pressingTimer.current !== null) {
        clearTimeout(pressingTimer.current); pressingTimer.current = null; setPressingIdx(null)
      }
      if (!_dragMode) return
      e.preventDefault()
      const touch = e.touches[0]
      lastTouchXY.current = { x: touch.clientX, y: touch.clientY }
      dragSelectAt(touch.clientX, touch.clientY)
      if (scroll) {
        const rect = scroll.getBoundingClientRect()
        if (touch.clientY < rect.top + EDGE_ZONE) {
          const speed = -1 - (rect.top + EDGE_ZONE - touch.clientY) / EDGE_ZONE * MAX_SCROLL_SPEED
          if (autoScrollRaf.current === null) runAutoScroll(speed)
        } else if (touch.clientY > rect.bottom - EDGE_ZONE) {
          const speed = 1 + (touch.clientY - rect.bottom + EDGE_ZONE) / EDGE_ZONE * MAX_SCROLL_SPEED
          if (autoScrollRaf.current === null) runAutoScroll(speed)
        } else {
          cancelAutoScroll()
        }
      }
    }

    const endTouch = (): void => {
      if (pressingTimer.current !== null) { clearTimeout(pressingTimer.current); pressingTimer.current = null }
      setPressingIdx(null); cancelAutoScroll()
      if (_dragMode) {
        setFrames([..._frames])
        setSuppressNextMousedown(true)
        setTimeout(() => setSuppressNextMousedown(false), 500)
      }
      setDragMode(false)
    }

    grid.addEventListener('mouseover', onMouseOver)
    document.addEventListener('mouseup', onMouseUp)
    grid.addEventListener('touchstart', onTouchStart, { passive: true })
    grid.addEventListener('touchmove', onTouchMove, { passive: false })
    grid.addEventListener('touchend', endTouch, { passive: true })
    grid.addEventListener('touchcancel', endTouch, { passive: true })

    return () => {
      grid.removeEventListener('mouseover', onMouseOver)
      document.removeEventListener('mouseup', onMouseUp)
      grid.removeEventListener('touchstart', onTouchStart)
      grid.removeEventListener('touchmove', onTouchMove)
      grid.removeEventListener('touchend', endTouch)
      grid.removeEventListener('touchcancel', endTouch)
      cancelAutoScroll()
    }
  }, [phase])

  // ── 2. Callbacks ────────────────────────────────────────────────────────────

  const handleCardMouseDown = useCallback((idx: number, e: MouseEvent) => {
    if (_suppressNextMousedown) { setSuppressNextMousedown(false); return }
    if (!_frames[idx]) return
    if (e.shiftKey && _lastClickedIdx >= 0 && _lastClickedIdx !== idx) {
      const lo = Math.min(_lastClickedIdx, idx); const hi = Math.max(_lastClickedIdx, idx)
      const target = !_frames[idx].selected
      for (let i = lo; i <= hi; i++) _frames[i].selected = target
      setLastClickedIdx(idx); setFrames([..._frames])
      e.preventDefault(); return
    }
    _frames[idx].selected = !_frames[idx].selected
    setDragSelectValue(_frames[idx].selected); setDragMode(true); setLastClickedIdx(idx)
    setFrames([..._frames])
    e.preventDefault()
  }, [])

  const handleView     = useCallback((idx: number) => { sLightboxIdx.value = idx }, [])
  const handleDownload = useCallback((idx: number) => {
    const f = _frames[idx]; if (!f) return
    const title = _itemTitle || cleanItemTitle() || 'frame'
    const stamp = formatTime(f.posMs).replace(/[:.]/g, '-')
    triggerDownload(frameUrl(_itemId, f.fiIdx, f.posMs, 0), `jellyfin-frame-${title}-${stamp}.jpg`)
  }, [])
  const handleRemove    = useCallback((idx: number) => { if (_frames[idx]) { _frames[idx].removed = true; _frames[idx].selected = false; setFrames([..._frames]) } }, [])
  const handleRetry     = useCallback((idx: number) => { if (_frames[idx]) { _frames[idx].loadError = false; setFrames([..._frames]) } }, [])
  const handleToggle    = useCallback((idx: number, v: boolean) => { if (_frames[idx]) { _frames[idx].selected = v; setFrames([..._frames]) } }, [])
  const handleLoadError = useCallback((idx: number) => { if (_frames[idx]) { _frames[idx].loadError = true; setFrames([..._frames]) } }, [])

  // ── 3. Render ───────────────────────────────────────────────────────────────

  return (
    <div className="jfs-fe-scroll" ref={scrollRef}>
      <div id="jfs-fe-grid" className="jfs-fe-grid" ref={gridRef}>
        {frames.map((f, i) => f.removed ? null : (
          <FrameCard
            key={`${f.fiIdx}-${f.posMs}`}
            frame={f}
            idx={i}
            pressing={i === pressingIdx}
            onMouseDown={handleCardMouseDown}
            onView={handleView}
            onDownload={handleDownload}
            onRemove={handleRemove}
            onRetry={handleRetry}
            onToggle={handleToggle}
            onLoadError={handleLoadError}
          />
        ))}
      </div>
    </div>
  )
}
