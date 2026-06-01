import { useEffect, useCallback, useRef } from 'react'
import { useAtomValue } from 'jotai'
import {
  _frames, _dragMode, _dragSelectValue, _lastClickedIdx, _suppressNextMousedown,
  _longPressCard, _longPressTimer, _autoScrollRaf, _lastTouchX, _lastTouchY,
  set_dragMode, set_dragSelectValue, set_lastClickedIdx, set_suppressNextMousedown,
  set_longPressCard, set_longPressTimer, set_autoScrollRaf, set_lastTouchXY,
  renderGrid, framesAtom,
} from '../core/state'
import { frameUrl } from '../api/frameExportApi'
import { _itemId } from '../core/state'
import { FrameCard } from './FrameCard'
import { sLightboxIdx } from '../core/state'
import { FrameGridPhaseGate } from './FrameGridSkeleton'

// ── applyDragToPoint: direct DOM updates for drag perf, no renderGrid ─────────
function applyDragToPoint(x: number, y: number): void {
  const el = document.elementFromPoint(x, y) as HTMLElement | null
  const card = el?.closest<HTMLElement>('.jfs-fe-card')
  if (!card) return
  const idx = parseInt(card.dataset.idx ?? '')
  if (isNaN(idx) || !_frames[idx] || _frames[idx].selected === _dragSelectValue) return
  _frames[idx].selected = _dragSelectValue
  card.classList.toggle('sel', _dragSelectValue)
  const cb = card.querySelector<HTMLInputElement>('.jfs-fe-cb')
  if (cb) cb.checked = _dragSelectValue
}

function stopAutoScroll(): void {
  if (_autoScrollRaf !== null) { cancelAnimationFrame(_autoScrollRaf); set_autoScrollRaf(null) }
}

export function FrameGrid() {
  const frames   = useAtomValue(framesAtom)
  const gridRef  = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const handleCardMouseDown = useCallback((idx: number, e: MouseEvent) => {
    if (_suppressNextMousedown) { set_suppressNextMousedown(false); return }
    if ((e.target as HTMLElement).closest('.jfs-fe-card-acts,.jfs-fe-cb')) return
    if (!_frames[idx]) return

    if (e.shiftKey && _lastClickedIdx >= 0 && _lastClickedIdx !== idx) {
      const lo = Math.min(_lastClickedIdx, idx)
      const hi = Math.max(_lastClickedIdx, idx)
      const target = !_frames[idx].selected
      for (let i = lo; i <= hi; i++) { _frames[i].selected = target }
      set_lastClickedIdx(idx)
      renderGrid()
      e.preventDefault()
      return
    }

    _frames[idx].selected = !_frames[idx].selected
    set_dragSelectValue(_frames[idx].selected)
    set_dragMode(true)
    set_lastClickedIdx(idx)
    const card = (e.currentTarget as HTMLElement)
    card.classList.toggle('sel', _frames[idx].selected)
    const cb = card.querySelector<HTMLInputElement>('.jfs-fe-cb')
    if (cb) cb.checked = _frames[idx].selected
    renderGrid()
    e.preventDefault()
  }, [])

  const handleView     = useCallback((idx: number) => { sLightboxIdx.value = idx }, [])
  const handleDownload = useCallback((idx: number) => {
    const f = _frames[idx]
    if (!f) return
    const url = frameUrl(_itemId, f.fiIdx, f.posMs, 0)
    const title = document.title.replace(/\s*[-|]\s*Jellyfin\s*$/i, '').trim() || 'frame'
    const ts = import('../lib/utils').then(({ formatTime }) => {
      const stamp = formatTime(f.posMs).replace(/[:.]/g, '-')
      const a = document.createElement('a')
      a.href = url
      a.download = `jellyfin-frame-${title}-${stamp}.jpg`
      document.body.appendChild(a); a.click(); document.body.removeChild(a)
    })
    void ts
  }, [])

  const handleRemove = useCallback((idx: number) => {
    if (!_frames[idx]) return
    _frames[idx].removed  = true
    _frames[idx].selected = false
    renderGrid()
  }, [])

  const handleRetry = useCallback((idx: number) => {
    if (!_frames[idx]) return
    _frames[idx].loadError = false
    if (_frames[idx].blobUrl) { URL.revokeObjectURL(_frames[idx].blobUrl!); _frames[idx].blobUrl = undefined }
    renderGrid()
    import('../core/frame-export').then(m => m.updateFrameImage(idx))
  }, [])

  const handleToggle = useCallback((idx: number, checked: boolean) => {
    if (!_frames[idx]) return
    _frames[idx].selected = checked
    renderGrid()
  }, [])

  const handleLoadError = useCallback((idx: number) => {
    if (!_frames[idx]) return
    _frames[idx].loadError = true
    renderGrid()
  }, [])

  useEffect(() => {
    const grid   = gridRef.current
    const scroll = scrollRef.current
    if (!grid) return

    const EDGE_ZONE       = 64
    const MAX_SCROLL_SPEED = 8

    function runAutoScroll(speed: number): void {
      if (!scroll) return
      scroll.scrollTop += speed
      applyDragToPoint(_lastTouchX, _lastTouchY)
      set_autoScrollRaf(requestAnimationFrame(() => runAutoScroll(speed)))
    }

    const onMouseOver = (e: MouseEvent) => {
      if (!_dragMode) return
      applyDragToPoint(e.clientX, e.clientY)
    }

    const onMouseUp = () => {
      if (_dragMode) renderGrid()
      set_dragMode(false)
    }

    const onTouchStart = (e: TouchEvent) => {
      const touch = e.touches[0]
      const el = document.elementFromPoint(touch.clientX, touch.clientY) as HTMLElement | null
      const card = el?.closest<HTMLElement>('.jfs-fe-card')
      if (!card || el?.closest('.jfs-fe-card-acts,.jfs-fe-cb')) return
      const idx = parseInt(card.dataset.idx ?? '')
      if (isNaN(idx) || !_frames[idx]) return
      set_longPressCard(card)
      card.classList.add('jfs-pressing')
      set_longPressTimer(setTimeout(() => {
        set_longPressTimer(null)
        set_dragMode(true)
        _frames[idx].selected = !_frames[idx].selected
        set_dragSelectValue(_frames[idx].selected)
        set_lastClickedIdx(idx)
        card.classList.remove('jfs-pressing')
        card.classList.toggle('sel', _frames[idx].selected)
        const cb = card.querySelector<HTMLInputElement>('.jfs-fe-cb')
        if (cb) cb.checked = _frames[idx].selected
        renderGrid()
        if ('vibrate' in navigator) navigator.vibrate(25)
      }, 400))
    }

    const onTouchMove = (e: TouchEvent) => {
      if (_longPressTimer !== null) {
        clearTimeout(_longPressTimer)
        set_longPressTimer(null)
        _longPressCard?.classList.remove('jfs-pressing')
        set_longPressCard(null)
      }
      if (!_dragMode) return
      e.preventDefault()
      const touch = e.touches[0]
      set_lastTouchXY(touch.clientX, touch.clientY)
      applyDragToPoint(touch.clientX, touch.clientY)
      if (scroll) {
        const rect = scroll.getBoundingClientRect()
        if (touch.clientY < rect.top + EDGE_ZONE) {
          const speed = -1 - (rect.top + EDGE_ZONE - touch.clientY) / EDGE_ZONE * MAX_SCROLL_SPEED
          if (_autoScrollRaf === null) runAutoScroll(speed)
        } else if (touch.clientY > rect.bottom - EDGE_ZONE) {
          const speed = 1 + (touch.clientY - rect.bottom + EDGE_ZONE) / EDGE_ZONE * MAX_SCROLL_SPEED
          if (_autoScrollRaf === null) runAutoScroll(speed)
        } else {
          stopAutoScroll()
        }
      }
    }

    const endTouch = (): void => {
      if (_longPressTimer !== null) { clearTimeout(_longPressTimer); set_longPressTimer(null) }
      _longPressCard?.classList.remove('jfs-pressing')
      set_longPressCard(null)
      stopAutoScroll()
      if (_dragMode) {
        renderGrid()
        set_suppressNextMousedown(true)
        setTimeout(() => set_suppressNextMousedown(false), 500)
      }
      set_dragMode(false)
    }

    grid.addEventListener('mouseover',    onMouseOver)
    document.addEventListener('mouseup',  onMouseUp)
    grid.addEventListener('touchstart',   onTouchStart,  { passive: true })
    grid.addEventListener('touchmove',    onTouchMove,   { passive: false })
    grid.addEventListener('touchend',     endTouch,      { passive: true })
    grid.addEventListener('touchcancel',  endTouch,      { passive: true })

    return () => {
      grid.removeEventListener('mouseover',   onMouseOver)
      document.removeEventListener('mouseup', onMouseUp)
      grid.removeEventListener('touchstart',  onTouchStart)
      grid.removeEventListener('touchmove',   onTouchMove)
      grid.removeEventListener('touchend',    endTouch)
      grid.removeEventListener('touchcancel', endTouch)
    }
  }, [])

  return (
    <FrameGridPhaseGate>
      <div className="jfs-fe-scroll" ref={scrollRef}>
        <div id="jfs-fe-grid" className="jfs-fe-grid" ref={gridRef}>
          {frames.map((f, i) => f.removed ? null : (
            <FrameCard
              key={f.posMs}
              frame={f}
              idx={i}
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
    </FrameGridPhaseGate>
  )
}
