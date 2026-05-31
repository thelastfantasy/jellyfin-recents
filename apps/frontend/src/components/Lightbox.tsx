import { useEffect, useCallback, useRef, useState } from 'preact/hooks'
import { createPortal } from 'preact/compat'
import { MdClose, MdDownload, MdDelete, MdZoomIn, MdZoomOut, MdFitScreen } from 'react-icons/md'
import { useLocale } from '../i18n/context'

interface Props {
  src: string
  alt?: string
  onClose: () => void
  onDownload?: () => void
  onDelete?: () => void
}

export function Lightbox({ src, alt = '', onClose, onDownload, onDelete }: Props) {
  const viewRef   = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const imgRef    = useRef<HTMLImageElement>(null)

  // All transform state in refs — avoids re-renders during drag/zoom
  const scaleRef    = useRef(1)
  const panRef      = useRef({ x: 0, y: 0 })
  const fitScaleRef = useRef(1)
  const natRef      = useRef({ w: 0, h: 0 })
  const dragRef     = useRef<{ sx: number; sy: number; px: number; py: number } | null>(null)
  const pinchRef    = useRef<{ dist: number; mx: number; my: number } | null>(null)

  // Only cursor needs React state (tiny)
  const [dragging, setDragging] = useState(false)

  const applyTransform = useCallback(() => {
    if (!canvasRef.current) return
    const { x, y } = panRef.current
    const s = scaleRef.current
    canvasRef.current.style.transform = `translate(${x}px,${y}px) scale(${s})`
  }, [])

  // Center the image at the given scale
  const centerAt = useCallback((s: number) => {
    const view = viewRef.current
    const { w, h } = natRef.current
    if (!view || w === 0) return
    panRef.current = {
      x: (view.clientWidth  - w * s) / 2,
      y: (view.clientHeight - h * s) / 2,
    }
  }, [])

  const computeFit = useCallback(() => {
    const view = viewRef.current
    const { w, h } = natRef.current
    if (!view || w === 0) return 1
    return Math.min(view.clientWidth / w, view.clientHeight / h, 1)
  }, [])

  // Keyboard dismiss + Android back-gesture intercept
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'

    // Push a history entry so Android's back gesture pops it (closing the lightbox)
    // instead of navigating away. Use window.top so it works inside same-origin iframes.
    const win = (() => { try { return (window.top && window.top !== window) ? window.top : window } catch { return window } })()
    win.history.pushState({ jfsLightbox: true }, '')
    let closedByBack = false
    const onPop = () => { closedByBack = true; onClose() }
    win.addEventListener('popstate', onPop)

    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
      win.removeEventListener('popstate', onPop)
      // Normal close (button): pop the state we pushed to keep history clean.
      if (!closedByBack && win.history.state?.jfsLightbox) win.history.back()
    }
  }, [onClose])

  // Wheel zoom: keeps the pixel under the cursor stationary
  const onWheel = useCallback((e: WheelEvent) => {
    e.preventDefault()
    const view = viewRef.current
    if (!view) return

    const oldS  = scaleRef.current
    const newS  = Math.max(0.05, Math.min(20, oldS * (1 - e.deltaY * 0.001)))
    const ratio = newS / oldS

    const rect = view.getBoundingClientRect()
    const cx   = e.clientX - rect.left
    const cy   = e.clientY - rect.top

    // Keep cursor point fixed: newPan = cursor - (cursor - oldPan) * ratio
    panRef.current = {
      x: cx - (cx - panRef.current.x) * ratio,
      y: cy - (cy - panRef.current.y) * ratio,
    }
    scaleRef.current = newS
    applyTransform()
  }, [applyTransform])

  // Mouse drag panning
  const onMouseDown = useCallback((e: MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    setDragging(true)
    dragRef.current = { sx: e.clientX, sy: e.clientY, px: panRef.current.x, py: panRef.current.y }
  }, [])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current
      if (!d) return
      panRef.current = { x: d.px + (e.clientX - d.sx), y: d.py + (e.clientY - d.sy) }
      applyTransform()
    }
    const onUp = () => { dragRef.current = null; setDragging(false) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',  onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [applyTransform])

  // Touch: single-finger pan + two-finger pinch-to-zoom
  useEffect(() => {
    const view = viewRef.current
    if (!view) return

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        const t = e.touches[0]
        setDragging(true)
        dragRef.current = { sx: t.clientX, sy: t.clientY, px: panRef.current.x, py: panRef.current.y }
        pinchRef.current = null
      } else if (e.touches.length === 2) {
        dragRef.current = null
        setDragging(false)
        const t0 = e.touches[0], t1 = e.touches[1]
        pinchRef.current = {
          dist: Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY),
          mx: (t0.clientX + t1.clientX) / 2,
          my: (t0.clientY + t1.clientY) / 2,
        }
      }
    }

    const onTouchMove = (e: TouchEvent) => {
      e.preventDefault()
      const view = viewRef.current
      if (!view) return
      const rect = view.getBoundingClientRect()

      if (e.touches.length === 1) {
        const d = dragRef.current
        if (!d) return
        const t = e.touches[0]
        panRef.current = { x: d.px + (t.clientX - d.sx), y: d.py + (t.clientY - d.sy) }
        applyTransform()
      } else if (e.touches.length === 2) {
        const p = pinchRef.current
        if (!p) return
        const t0 = e.touches[0], t1 = e.touches[1]
        const newMx   = (t0.clientX + t1.clientX) / 2
        const newMy   = (t0.clientY + t1.clientY) / 2
        const newDist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY)

        const oldS = scaleRef.current
        const newS = Math.max(0.05, Math.min(20, oldS * (newDist / p.dist)))
        const ratio = newS / oldS

        // Zoom around old midpoint then translate to new midpoint:
        // newPan = newMid - (oldMid - oldPan) * ratio
        panRef.current = {
          x: (newMx - rect.left) - ((p.mx - rect.left) - panRef.current.x) * ratio,
          y: (newMy - rect.top)  - ((p.my - rect.top)  - panRef.current.y) * ratio,
        }
        scaleRef.current = newS
        pinchRef.current = { dist: newDist, mx: newMx, my: newMy }
        applyTransform()
      }
    }

    const onTouchEnd = () => {
      dragRef.current  = null
      pinchRef.current = null
      setDragging(false)
    }

    view.addEventListener('touchstart',  onTouchStart, { passive: true })
    view.addEventListener('touchmove',   onTouchMove,  { passive: false })
    view.addEventListener('touchend',    onTouchEnd)
    view.addEventListener('touchcancel', onTouchEnd)
    return () => {
      view.removeEventListener('touchstart',  onTouchStart)
      view.removeEventListener('touchmove',   onTouchMove)
      view.removeEventListener('touchend',    onTouchEnd)
      view.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [applyTransform])

  // Initial fit after image loads
  const onImgLoad = useCallback(() => {
    const img = imgRef.current
    if (!img) return
    natRef.current = { w: img.naturalWidth, h: img.naturalHeight }
    const fit = computeFit()
    fitScaleRef.current = fit
    scaleRef.current   = fit
    centerAt(fit)
    applyTransform()
  }, [computeFit, centerAt, applyTransform])

  // Toolbar buttons zoom toward/away from view center
  const zoomBy = useCallback((factor: number) => {
    const view = viewRef.current
    if (!view) return
    const oldS  = scaleRef.current
    const newS  = Math.max(0.05, Math.min(20, oldS * factor))
    const ratio = newS / oldS
    const cx    = view.clientWidth  / 2
    const cy    = view.clientHeight / 2
    panRef.current = { x: cx - (cx - panRef.current.x) * ratio, y: cy - (cy - panRef.current.y) * ratio }
    scaleRef.current = newS
    applyTransform()
  }, [applyTransform])

  const handleFit = useCallback(() => {
    const fit = computeFit()
    fitScaleRef.current = fit
    scaleRef.current   = fit
    centerAt(fit)
    applyTransform()
  }, [computeFit, centerAt, applyTransform])

  const { t } = useLocale()
  const hasFooter = onDownload || onDelete

  return createPortal(
    <div
      class="jfs-lightbox"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={alt}
    >
      {/* Zoom toolbar */}
      <div class="jfs-lightbox__zoombar" onClick={e => e.stopPropagation()}>
        <button class="jfs-lightbox__zoom-btn" onClick={() => zoomBy(1.3)} title={t.lightboxZoomIn}>
          <MdZoomIn size={20} />
        </button>
        <button class="jfs-lightbox__zoom-btn" onClick={() => zoomBy(1 / 1.3)} title={t.lightboxZoomOut}>
          <MdZoomOut size={20} />
        </button>
        <button class="jfs-lightbox__zoom-btn" onClick={handleFit} title={t.lightboxFit}>
          <MdFitScreen size={18} />
        </button>
      </div>

      <button
        class="jfs-lightbox__close"
        onClick={e => { e.stopPropagation(); onClose() }}
        aria-label={t.lightboxClose}
      >
        <MdClose size={20} />
      </button>

      {/* Pan / zoom viewport */}
      <div
        ref={viewRef}
        class="jfs-lightbox__view"
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onClick={e => e.stopPropagation()}
        style={{ cursor: dragging ? 'grabbing' : 'grab' }}
      >
        <div ref={canvasRef} class="jfs-lightbox__canvas">
          <img
            ref={imgRef}
            class="jfs-lightbox__img"
            src={src}
            alt={alt}
            onLoad={onImgLoad}
            draggable={false}
          />
        </div>
      </div>

      {hasFooter && (
        <div class="jfs-lightbox__footer" onClick={e => e.stopPropagation()}>
          {onDownload && (
            <button class="jfs-lightbox__footer-btn" onClick={onDownload} title={t.lightboxDownload}>
              <MdDownload size={20} />
            </button>
          )}
          {onDelete && (
            <button
              class="jfs-lightbox__footer-btn jfs-lightbox__footer-btn--delete"
              onClick={onDelete}
              title={t.lightboxDelete}
            >
              <MdDelete size={20} />
            </button>
          )}
        </div>
      )}
    </div>,
    document.body
  )
}
