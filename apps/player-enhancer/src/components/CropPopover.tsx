import { useAtomValue } from 'jotai'
import { useCallback, useEffect, useMemo,useRef, useState } from 'react'

import type { ExportSettings } from '../core/state'
import { _frames, _videoEl, cropOpenAtom, sCropOpen, settingsAtom,sSettings, updateSettings } from '../core/state'
import { t } from '../lib/i18n'
import { formatTime } from '../lib/utils'
import { showToast } from './Toast'

// ── Types ─────────────────────────────────────────────────────────────────────

interface CropRect { x: number; y: number; w: number; h: number }

type HandleId = 'nw'|'n'|'ne'|'e'|'se'|'s'|'sw'|'w'|'move'|'draw'

const HANDLE_CURSOR: Record<HandleId, string> = {
  nw: 'nw-resize', n: 'n-resize', ne: 'ne-resize', e: 'e-resize',
  se: 'se-resize', s: 's-resize', sw: 'sw-resize', w: 'w-resize',
  move: 'move', draw: 'crosshair',
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

function getHandles(d: CropRect, cw: number, ch: number): Array<{ id: HandleId; x: number; y: number }> {
  const [px, py, pw, ph] = [d.x * cw, d.y * ch, d.w * cw, d.h * ch]
  return [
    { id: 'nw', x: px,       y: py       },
    { id: 'n',  x: px+pw/2,  y: py       },
    { id: 'ne', x: px+pw,    y: py       },
    { id: 'e',  x: px+pw,    y: py+ph/2  },
    { id: 'se', x: px+pw,    y: py+ph    },
    { id: 's',  x: px+pw/2,  y: py+ph    },
    { id: 'sw', x: px,       y: py+ph    },
    { id: 'w',  x: px,       y: py+ph/2  },
  ]
}

function hitTest(mx: number, my: number, d: CropRect, cw: number, ch: number): HandleId {
  const THRESH = 14
  for (const h of getHandles(d, cw, ch)) {
    if (Math.abs(mx - h.x) <= THRESH && Math.abs(my - h.y) <= THRESH) return h.id
  }
  const isFullFrame = d.w >= 0.99 && d.h >= 0.99
  const [px, py, pw, ph] = [d.x * cw, d.y * ch, d.w * cw, d.h * ch]
  if (!isFullFrame && mx >= px && mx <= px + pw && my >= py && my <= py + ph) return 'move'
  return 'draw'
}

function applyHandleResize(handle: HandleId, orig: CropRect, dx: number, dy: number): CropRect {
  const MIN = 0.02
  let { x, y, w, h } = orig
  switch (handle) {
    case 'nw': x = Math.min(orig.x+dx, orig.x+orig.w-MIN); y = Math.min(orig.y+dy, orig.y+orig.h-MIN); w = orig.x+orig.w-x; h = orig.y+orig.h-y; break
    case 'n':  y = Math.min(orig.y+dy, orig.y+orig.h-MIN); h = orig.y+orig.h-y; break
    case 'ne': w = Math.max(MIN, orig.w+dx); y = Math.min(orig.y+dy, orig.y+orig.h-MIN); h = orig.y+orig.h-y; break
    case 'e':  w = Math.max(MIN, orig.w+dx); break
    case 'se': w = Math.max(MIN, orig.w+dx); h = Math.max(MIN, orig.h+dy); break
    case 's':  h = Math.max(MIN, orig.h+dy); break
    case 'sw': x = Math.min(orig.x+dx, orig.x+orig.w-MIN); w = orig.x+orig.w-x; h = Math.max(MIN, orig.h+dy); break
    case 'w':  x = Math.min(orig.x+dx, orig.x+orig.w-MIN); w = orig.x+orig.w-x; break
    default: break
  }
  x = Math.max(0, x); y = Math.max(0, y)
  w = Math.min(w, 1-x); h = Math.min(h, 1-y)
  return { x, y, w: Math.max(MIN, w), h: Math.max(MIN, h) }
}

// ── Component ─────────────────────────────────────────────────────────────────

export function CropPopover() {
  const open = useAtomValue(cropOpenAtom)
  const loadedFrames = useMemo(
    () => _frames.filter(f => !f.removed && f.jpegUrl),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open],
  )

  useEffect(() => {
    if (open && loadedFrames.length === 0) {
      sCropOpen.value = false
      showToast(t('crop.noFrames'))
    }
  }, [open, loadedFrames.length])

  if (!open || loadedFrames.length === 0) return null
  return <CropPopoverInner loadedFrames={loadedFrames} />
}

function CropPopoverInner({ loadedFrames }: { loadedFrames: typeof _frames }) {
  const st = useAtomValue(settingsAtom)
  const currentMs = (_videoEl?.currentTime ?? 0) * 1000

  const initialIdx = (() => {
    let best = 0; let minDiff = Infinity
    loadedFrames.forEach((f, i) => { const d = Math.abs(f.posMs - currentMs); if (d < minDiff) { minDiff = d; best = i } })
    return best
  })()

  const [curIdx, setCurIdx]   = useState(initialIdx)
  const [infoText, setInfoText] = useState(() => t('crop.hint'))

  const imgRef    = useRef<HTMLImageElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef  = useRef<HTMLDivElement>(null)

  // Drag state in refs — no re-render needed during pointer move
  const draftRef        = useRef<CropRect>(st.cropRect ? { ...st.cropRect } : { x: 0, y: 0, w: 1, h: 1 })
  const activeHandleRef = useRef<HandleId | null>(null)
  const handleStartRef  = useRef<{ mx: number; my: number; draft0: CropRect } | null>(null)

  // ── canvas helpers ────────────────────────────────────────────────────────

  const positionCanvas = useCallback(() => {
    const img    = imgRef.current
    const canvas = canvasRef.current
    const stage  = stageRef.current
    if (!img || !canvas || !stage) return
    const iRect = img.getBoundingClientRect()
    const sRect = stage.getBoundingClientRect()
    canvas.style.left   = `${iRect.left - sRect.left}px`
    canvas.style.top    = `${iRect.top  - sRect.top}px`
    canvas.style.width  = `${iRect.width}px`
    canvas.style.height = `${iRect.height}px`
    canvas.width  = Math.round(iRect.width)  || img.naturalWidth
    canvas.height = Math.round(iRect.height) || img.naturalHeight
  }, [])

  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const cw = canvas.width, ch = canvas.height
    ctx.clearRect(0, 0, cw, ch)
    const { x, y, w, h } = draftRef.current
    const isFullFrame = w >= 0.99 && h >= 0.99
    const [px, py, pw, ph] = [x*cw, y*ch, w*cw, h*ch]
    if (!isFullFrame) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)'
      ctx.fillRect(0, 0, cw, ch)
      ctx.clearRect(px, py, pw, ph)
    }
    ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3])
    ctx.strokeRect(px+0.5, py+0.5, pw-1, ph-1); ctx.restore()
    ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,0.2)'; ctx.lineWidth = 0.5
    for (let i = 1; i < 3; i++) {
      ctx.beginPath(); ctx.moveTo(px+pw*i/3, py); ctx.lineTo(px+pw*i/3, py+ph); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(px, py+ph*i/3); ctx.lineTo(px+pw, py+ph*i/3); ctx.stroke()
    }
    ctx.restore()
    const CORNERS: HandleId[] = ['nw', 'ne', 'sw', 'se']
    ctx.save(); ctx.fillStyle = '#fff'; ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 1
    for (const hdl of getHandles(draftRef.current, cw, ch)) {
      const sz = CORNERS.includes(hdl.id) ? 6 : 4
      ctx.beginPath(); ctx.rect(hdl.x-sz, hdl.y-sz, sz*2, sz*2); ctx.fill(); ctx.stroke()
    }
    ctx.restore()
  }, [])

  const updateInfo = useCallback(() => {
    const canvas = canvasRef.current
    const img    = imgRef.current
    if (!canvas || !img) return
    const { x: _x, y: _y, w, h } = draftRef.current
    const cropW = Math.round(w * img.naturalWidth)
    const cropH = Math.round(h * img.naturalHeight)
    const currentSt = sSettings.value
    const dimW = currentSt.width
    const dimH = currentSt.height
    let targetPx = 0, resizeMode: 'width' | 'height' = 'width'
    if (dimH.mode === 'userInput' && dimH.value > 0) {
      targetPx = dimH.value; resizeMode = 'height'
    } else if (dimW.value > 0) {
      targetPx = dimW.value
    } else if (currentSt.resolutionPreset !== 'original') {
      const pm: Record<string, number> = { '1080p': 1080, '720p': 720, '480p': 480, '360p': 360 }
      targetPx = pm[currentSt.resolutionPreset] ?? 0
    }
    let outW = cropW, outH = cropH
    if (targetPx > 0) {
      if (resizeMode === 'width') { outW = targetPx; outH = Math.round(cropH * targetPx / cropW) }
      else { outH = targetPx; outW = Math.round(cropW * targetPx / cropH) }
    }
    setInfoText((outW === cropW && outH === cropH)
      ? t('crop.infoSize').replace('{w}', String(cropW)).replace('{h}', String(cropH))
      : t('crop.infoResized').replace('{w}', String(cropW)).replace('{h}', String(cropH))
          .replace('{ow}', String(outW)).replace('{oh}', String(outH))
    )
  }, [])

  const applyDragCrop = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current
    if (!canvas || !activeHandleRef.current || !handleStartRef.current) return
    const r = canvas.getBoundingClientRect()
    const pos = {
      x: Math.max(0, Math.min(canvas.width,  (clientX - r.left) * canvas.width  / r.width)),
      y: Math.max(0, Math.min(canvas.height, (clientY - r.top)  * canvas.height / r.height)),
    }
    const dx = (pos.x - handleStartRef.current.mx) / canvas.width
    const dy = (pos.y - handleStartRef.current.my) / canvas.height
    const orig = handleStartRef.current.draft0
    if (activeHandleRef.current === 'draw') {
      const sx = handleStartRef.current.mx / canvas.width
      const sy = handleStartRef.current.my / canvas.height
      const cx = Math.max(0, Math.min(1, pos.x / canvas.width))
      const cy = Math.max(0, Math.min(1, pos.y / canvas.height))
      draftRef.current = { x: Math.min(sx, cx), y: Math.min(sy, cy), w: Math.max(0.01, Math.abs(cx-sx)), h: Math.max(0.01, Math.abs(cy-sy)) }
    } else if (activeHandleRef.current === 'move') {
      draftRef.current = { x: Math.max(0, Math.min(1-orig.w, orig.x+dx)), y: Math.max(0, Math.min(1-orig.h, orig.y+dy)), w: orig.w, h: orig.h }
    } else {
      draftRef.current = applyHandleResize(activeHandleRef.current, orig, dx, dy)
    }
    drawCanvas(); updateInfo()
  }, [drawCanvas, updateInfo])

  // ── canvas pointer/touch events (need passive: false) ──────────────────────

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const onPointerDown = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect()
      const pos = {
        x: Math.max(0, Math.min(canvas.width,  (e.clientX - r.left) * canvas.width  / r.width)),
        y: Math.max(0, Math.min(canvas.height, (e.clientY - r.top)  * canvas.height / r.height)),
      }
      const type = hitTest(pos.x, pos.y, draftRef.current, canvas.width, canvas.height)
      activeHandleRef.current = type
      handleStartRef.current  = { mx: pos.x, my: pos.y, draft0: { ...draftRef.current } }
      if (type === 'draw') {
        const nx = pos.x / canvas.width, ny = pos.y / canvas.height
        draftRef.current = { x: nx, y: ny, w: 0.01, h: 0.01 }
      }
      canvas.setPointerCapture(e.pointerId); e.preventDefault()
    }

    const onPointerMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect()
      const pos = {
        x: Math.max(0, Math.min(canvas.width,  (e.clientX - r.left) * canvas.width  / r.width)),
        y: Math.max(0, Math.min(canvas.height, (e.clientY - r.top)  * canvas.height / r.height)),
      }
      if (!activeHandleRef.current || !handleStartRef.current) {
        canvas.style.cursor = HANDLE_CURSOR[hitTest(pos.x, pos.y, draftRef.current, canvas.width, canvas.height)]
        return
      }
      applyDragCrop(e.clientX, e.clientY); e.preventDefault()
    }

    const onPointerUp = () => { activeHandleRef.current = null; handleStartRef.current = null }

    const onTouchStart = (e: TouchEvent) => {
      e.preventDefault()
      const touch = e.touches[0]
      const r = canvas.getBoundingClientRect()
      const pos = {
        x: Math.max(0, Math.min(canvas.width,  (touch.clientX - r.left) * canvas.width  / r.width)),
        y: Math.max(0, Math.min(canvas.height, (touch.clientY - r.top)  * canvas.height / r.height)),
      }
      const type = hitTest(pos.x, pos.y, draftRef.current, canvas.width, canvas.height)
      activeHandleRef.current = type
      handleStartRef.current  = { mx: pos.x, my: pos.y, draft0: { ...draftRef.current } }
      if (type === 'draw') draftRef.current = { x: pos.x/canvas.width, y: pos.y/canvas.height, w: 0.01, h: 0.01 }
    }

    const onTouchMove = (e: TouchEvent) => {
      e.preventDefault()
      applyDragCrop(e.touches[0].clientX, e.touches[0].clientY)
    }

    const onTouchEnd = () => { activeHandleRef.current = null; handleStartRef.current = null }

    canvas.addEventListener('pointerdown',  onPointerDown,  { passive: false })
    canvas.addEventListener('pointermove',  onPointerMove,  { passive: false })
    canvas.addEventListener('pointerup',    onPointerUp)
    canvas.addEventListener('touchstart',   onTouchStart,   { passive: false })
    canvas.addEventListener('touchmove',    onTouchMove,    { passive: false })
    canvas.addEventListener('touchend',     onTouchEnd)

    return () => {
      canvas.removeEventListener('pointerdown',  onPointerDown)
      canvas.removeEventListener('pointermove',  onPointerMove)
      canvas.removeEventListener('pointerup',    onPointerUp)
      canvas.removeEventListener('touchstart',   onTouchStart)
      canvas.removeEventListener('touchmove',    onTouchMove)
      canvas.removeEventListener('touchend',     onTouchEnd)
    }
  }, [applyDragCrop])

  // ── frame loading ─────────────────────────────────────────────────────────

  const loadFrame = useCallback((idx: number) => {
    setCurIdx(idx)
    const img = imgRef.current
    if (!img) return
    img.onload = () => requestAnimationFrame(() => {
      positionCanvas(); drawCanvas(); updateInfo()
    })
    img.src = loadedFrames[idx].jpegUrl
  }, [loadedFrames, positionCanvas, drawCanvas, updateInfo])

  // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect
  useEffect(() => { loadFrame(initialIdx) }, [])

  // ── keyboard ──────────────────────────────────────────────────────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation()
      if (e.key === 'Escape')      sCropOpen.value = false
      else if (e.key === 'ArrowLeft'  && curIdx > 0)                       loadFrame(curIdx - 1)
      else if (e.key === 'ArrowRight' && curIdx < loadedFrames.length - 1) loadFrame(curIdx + 1)
    }
    document.addEventListener('keydown', onKey, { capture: true })
    return () => document.removeEventListener('keydown', onKey, { capture: true })
  }, [curIdx, loadedFrames.length, loadFrame])

  // ── handlers ─────────────────────────────────────────────────────────────

  const handleReset = useCallback(() => {
    draftRef.current = { x: 0, y: 0, w: 1, h: 1 }
    drawCanvas(); updateInfo()
  }, [drawCanvas, updateInfo])

  const handleApply = useCallback(() => {
    const isFullFrame = draftRef.current.w >= 0.99 && draftRef.current.h >= 0.99
    const newCrop = isFullFrame ? null : { ...draftRef.current }
    const currentSt = sSettings.value
    const changed = JSON.stringify(newCrop) !== JSON.stringify(currentSt.cropRect)
    const w = currentSt.width
    const h = currentSt.height
    const patch: Partial<ExportSettings> = { cropRect: newCrop }
    if (changed && (w.value > 0 || h.value > 0)) {
      const vw = _videoEl?.videoWidth  || 1
      const vh = _videoEl?.videoHeight || 1
      if (w.mode === 'userInput' && w.value > 0) {
        const hRatio = newCrop ? (newCrop.h * vh) / (newCrop.w * vw) : vh / vw
        patch.height = { value: Math.round(w.value * hRatio), mode: 'autoAdjust' }
        showToast(t('crop.autoAdjH'))
      } else if (h.mode === 'userInput' && h.value > 0) {
        const wRatio = newCrop ? (newCrop.w * vw) / (newCrop.h * vh) : vw / vh
        patch.width = { value: Math.round(h.value * wRatio), mode: 'autoAdjust' }
        showToast(t('crop.autoAdjW'))
      }
    }
    updateSettings(patch)
    sCropOpen.value = false
  }, [])

  const hasPrev = curIdx > 0
  const hasNext = curIdx < loadedFrames.length - 1
  const f = loadedFrames[curIdx]

  return (
    <div
      className="jfs-fe-crop-overlay"
      onClick={e => { if (e.target === e.currentTarget) sCropOpen.value = false }}
    >
      <div className="jfs-fe-crop-dialog">
        <div ref={stageRef} className="jfs-fe-crop-stage" id="jfs-cp-stage">
          <img ref={imgRef} id="jfs-cp-img" alt="" />
          <canvas ref={canvasRef} className="jfs-fe-crop-canvas" />
          <button
            className="jfs-fe-cp-nav jfs-fe-cp-nav-l"
            disabled={!hasPrev}
            onClick={() => hasPrev && loadFrame(curIdx - 1)}
          >‹</button>
          <button
            className="jfs-fe-cp-nav jfs-fe-cp-nav-r"
            disabled={!hasNext}
            onClick={() => hasNext && loadFrame(curIdx + 1)}
          >›</button>
          <div className="jfs-fe-cp-label">
            {curIdx + 1} / {loadedFrames.length} · {formatTime(f.posMs)}
          </div>
        </div>
        <div className="jfs-fe-row sep-t" style={{ gap: '6px' }}>
          <span className="jfs-fe-muted" style={{ flex: '1', fontSize: '11px' }}>{infoText}</span>
          <button className="jfs-fe-btn g" style={{ padding: '3px 10px', fontSize: '12px' }} onClick={handleReset}>{t('crop.reset')}</button>
          <button className="jfs-fe-btn"   style={{ padding: '3px 10px', fontSize: '12px' }} onClick={() => { sCropOpen.value = false }}>{t('crop.cancel')}</button>
          <button className="jfs-fe-btn p" style={{ padding: '3px 10px', fontSize: '12px' }} onClick={handleApply}>{t('crop.apply')}</button>
        </div>
      </div>
    </div>
  )
}
