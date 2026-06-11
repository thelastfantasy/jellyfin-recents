import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

const SVG_ZOOM_IN   = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>`
const SVG_ZOOM_OUT  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>`
const SVG_FIT       = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>`
const SVG_CLOSE     = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`
const SVG_PREV      = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`
const SVG_NEXT      = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`
const SVG_DOWNLOAD  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`
const SVG_DELETE    = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`

export interface LightboxI18n {
  zoomIn?:   string
  zoomOut?:  string
  fit?:      string
  close?:    string
  download?: string
  delete?:   string
}

const DEFAULT_I18N: Required<LightboxI18n> = {
  zoomIn:   'Zoom in',
  zoomOut:  'Zoom out',
  fit:      'Fit to screen',
  close:    'Close',
  download: 'Download',
  delete:   'Delete',
}

export interface LightboxProps {
  src:          string
  alt?:         string
  onClose:      () => void
  onDownload?:  () => void
  onDelete?:    () => void
  onPrev?:      () => void
  onNext?:      () => void
  i18n?:        LightboxI18n
}

export function Lightbox({ src, alt = '', onClose, onDownload, onDelete, onPrev, onNext, i18n }: LightboxProps) {
  const labels = { ...DEFAULT_I18N, ...i18n }

  const viewRef   = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const imgRef    = useRef<HTMLImageElement>(null)

  const scaleRef    = useRef(1)
  const panRef      = useRef({ x: 0, y: 0 })
  const fitScaleRef = useRef(1)
  const natRef      = useRef({ w: 0, h: 0 })
  const dragRef     = useRef<{ sx: number; sy: number; px: number; py: number } | null>(null)
  const pinchRef    = useRef<{ dist: number; mx: number; my: number } | null>(null)

  const [dragging, setDragging] = useState(false)

  const applyTransform = useCallback(() => {
    if (!canvasRef.current) return
    const { x, y } = panRef.current
    const s = scaleRef.current
    canvasRef.current.style.transform = `translate(${x}px,${y}px) scale(${s})`
  }, [])

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return }
      if (e.key === 'ArrowLeft'  && onPrev) { onPrev(); return }
      if (e.key === 'ArrowRight' && onNext) { onNext(); return }
    }
    document.addEventListener('keydown', onKey, { capture: true })
    document.body.style.overflow = 'hidden'

    const win = (() => { try { return (window.top && window.top !== window) ? window.top : window } catch { return window } })()
    win.history.pushState({ jfsLightbox: true }, '')
    let closedByBack = false
    const onPop = () => { closedByBack = true; onClose() }
    win.addEventListener('popstate', onPop)

    return () => {
      document.removeEventListener('keydown', onKey, { capture: true })
      document.body.style.overflow = ''
      win.removeEventListener('popstate', onPop)
      if (!closedByBack && win.history.state?.jfsLightbox) win.history.back()
    }
  }, [onClose, onPrev, onNext])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const handler = (e: WheelEvent) => {
      e.preventDefault()
      const oldS  = scaleRef.current
      const newS  = Math.max(0.05, Math.min(20, oldS * (1 - e.deltaY * 0.001)))
      const ratio = newS / oldS
      const rect  = view.getBoundingClientRect()
      const cx    = e.clientX - rect.left
      const cy    = e.clientY - rect.top
      panRef.current = {
        x: cx - (cx - panRef.current.x) * ratio,
        y: cy - (cy - panRef.current.y) * ratio,
      }
      scaleRef.current = newS
      applyTransform()
    }
    view.addEventListener('wheel', handler, { passive: false })
    return () => view.removeEventListener('wheel', handler)
  }, [applyTransform])

  const onMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
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

  const hasFooter = onDownload || onDelete

  return createPortal(
    <div
      className="jfs-lightbox"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={alt}
    >
      <div className="jfs-lightbox__zoombar" onClick={e => e.stopPropagation()}>
        <button className="jfs-lightbox__zoom-btn" onClick={() => zoomBy(1.3)} title={labels.zoomIn}
          dangerouslySetInnerHTML={{ __html: SVG_ZOOM_IN }} />
        <button className="jfs-lightbox__zoom-btn" onClick={() => zoomBy(1 / 1.3)} title={labels.zoomOut}
          dangerouslySetInnerHTML={{ __html: SVG_ZOOM_OUT }} />
        <button className="jfs-lightbox__zoom-btn" onClick={handleFit} title={labels.fit}
          dangerouslySetInnerHTML={{ __html: SVG_FIT }} />
      </div>

      {onPrev && (
        <button className="jfs-lightbox__nav jfs-lightbox__nav--prev" onClick={e => { e.stopPropagation(); onPrev() }} title="Previous"
          dangerouslySetInnerHTML={{ __html: SVG_PREV }} />
      )}
      {onNext && (
        <button className="jfs-lightbox__nav jfs-lightbox__nav--next" onClick={e => { e.stopPropagation(); onNext() }} title="Next"
          dangerouslySetInnerHTML={{ __html: SVG_NEXT }} />
      )}

      <button
        className="jfs-lightbox__close"
        onClick={e => { e.stopPropagation(); onClose() }}
        aria-label={labels.close}
        dangerouslySetInnerHTML={{ __html: SVG_CLOSE }}
      />

      <div
        ref={viewRef}
        className="jfs-lightbox__view"
        onMouseDown={onMouseDown}
        onClick={e => e.stopPropagation()}
        style={{ cursor: dragging ? 'grabbing' : 'grab' }}
      >
        <div ref={canvasRef} className="jfs-lightbox__canvas">
          <img
            ref={imgRef}
            className="jfs-lightbox__img"
            src={src}
            alt={alt}
            onLoad={onImgLoad}
            draggable={false}
          />
        </div>
      </div>

      {hasFooter && (
        <div className="jfs-lightbox__footer" onClick={e => e.stopPropagation()}>
          {onDownload && (
            <button className="jfs-lightbox__footer-btn" onClick={onDownload} title={labels.download}
              dangerouslySetInnerHTML={{ __html: SVG_DOWNLOAD }} />
          )}
          {onDelete && (
            <button
              className="jfs-lightbox__footer-btn jfs-lightbox__footer-btn--delete"
              onClick={onDelete}
              title={labels.delete}
              dangerouslySetInnerHTML={{ __html: SVG_DELETE }}
            />
          )}
        </div>
      )}
    </div>,
    document.body
  )
}
