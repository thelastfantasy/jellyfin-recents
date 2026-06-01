import { useEffect, useCallback, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { atom, getDefaultStore, useAtomValue, useSetAtom } from 'jotai'
import { setGesturesSuspended } from '../hooks/useGestures'
import {
  sPage, sExportType, sPrefetchTotal, sPrefetchDone,
  sProgressTaskId, sResultUrl, sFileSize, sLightboxIdx,
  _frames, _itemId, _videoEl, _fpsFrac, _frameIndex,
  _fiMinIdx, _fiMaxIdx, _minPosMs, _maxPosMs,
  _dragController, _domObserver, _modalRoot, _savedState,
  set_frames, set_itemId, set_videoEl, set_fpsFrac, set_frameIndex,
  set_fiMinIdx, set_fiMaxIdx, set_minPosMs, set_maxPosMs,
  set_dragController, set_domObserver, set_savedState,
  set_lastClickedIdx, set_dragMode, set_activeTaskId,
  set_suppressNextMousedown, renderGrid, samplePositionsInRange,
  sSettings, pageAtom, sModalPhase, modalPhaseAtom,
} from './state'
import { fetchVideoFps, fetchFrameIndex, prefetch, openPrefetchStream,
  fetchFrameBlob, frameUrl, generateExport,
} from '../api/frameExportApi'
import { t } from '../lib/i18n'
import { GridPage }     from '../components/GridPage'
import { ProgressPage } from '../components/ProgressPage'
import { ResultPage }   from '../components/ResultPage'
import { Lightbox }     from '../components/Lightbox'
import { CropPopover }  from '../components/CropPopover'

const jstore = getDefaultStore()

// ── FrameExport modal state ─────────────────────────────────────────────────

export const _feOpen = atom<{ videoEl: HTMLVideoElement; itemId: string } | null>(null)

export function openFrameExportModal(videoEl: HTMLVideoElement, itemId: string): void {
  sPage.value = 'grid'
  jstore.set(_feOpen, { videoEl, itemId })
}

// ── Modal container ─────────────────────────────────────────────────────────

function FrameExportModalApp() {
  const feInfo = useAtomValue(_feOpen)
  if (!feInfo) return null
  return <FrameExportModalInner videoEl={feInfo.videoEl} itemId={feInfo.itemId} />
}

function FrameExportModalInner({ videoEl, itemId }: { videoEl: HTMLVideoElement; itemId: string }) {
  const setFE = useSetAtom(_feOpen)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const dragRef = useRef<{ ox: number; oy: number; startX: number; startY: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  // Initialize frame-export state (same as old openFrameExportModal)
  useEffect(() => {
    set_videoEl(videoEl)
    if (itemId !== _itemId) set_frameIndex(null)
    set_itemId(itemId)
    set_activeTaskId('')
    videoEl.pause()
    document.body.classList.add('jfs-fe-open')
    setGesturesSuspended(true)

    // Restore saved state
    const currentMs = Math.round(videoEl.currentTime * 1000)
    if (_savedState && _savedState.itemId === itemId && currentMs >= _savedState.minPosMs && currentMs <= _savedState.maxPosMs) {
      set_frames(_savedState.frames.map(f => ({ ...f })))
      sExportType.value = _savedState.exportType
      set_minPosMs(_savedState.minPosMs); set_maxPosMs(_savedState.maxPosMs)
      set_fpsFrac(_savedState.fpsFrac); set_lastClickedIdx(_savedState.lastClickedIdx)
      set_fiMinIdx(_savedState.fiMinIdx); set_fiMaxIdx(_savedState.fiMaxIdx)
      sPrefetchTotal.value = 0; sPrefetchDone.value = 0
      sPage.value = 'grid'; sLightboxIdx.value = null
      renderGrid()
      for (let i = 0; i < _frames.length; i++) {
        if (_frames[i].jpegUrl && !_frames[i].blobUrl) {
          _frames[i].loadError = false
          updateFrameImage(i)
        }
      }
      return
    }

    set_frames([]); sPage.value = 'grid'; sLightboxIdx.value = null
    const fpsNum = _fpsFrac.num > 0 ? _fpsFrac.num : 24
    const fpsDen = _fpsFrac.den > 0 ? _fpsFrac.den : 1
    const centerMs = Math.round(videoEl.currentTime * 1000)
    const count = Math.round(2000 / 1000 * fpsNum / fpsDen)
    set_frames(Array.from({ length: count }, (_, i) => ({
      posMs: Math.round(centerMs - 1000 + i * fpsDen * 1000 / fpsNum),
      fiIdx: -1, selected: true, jpegUrl: '', isJunk: false, junkReason: null, skeleton: true,
    })))
    renderGrid(); loadInitialFrames()

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Drag
  const onDragStart = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button,select,input,label,a,.jfs-fe-pbar,[id$="tbar"]')) return
    const rect = rootRef.current?.getBoundingClientRect()
    if (!rect) return
    dragRef.current = { ox: e.clientX - rect.left, oy: e.clientY - rect.top, startX: rect.left, startY: rect.top }
    setPos({ x: rect.left, y: rect.top })
    document.body.style.userSelect = 'none'
    e.preventDefault()
  }, [])

  useEffect(() => {
    if (!pos) return
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) return
      const el = rootRef.current
      if (!el) return
      setPos({ x: Math.max(0, Math.min(window.innerWidth - el.offsetWidth, e.clientX - dragRef.current.ox)), y: Math.max(0, Math.min(window.innerHeight - 40, e.clientY - dragRef.current.oy)) })
    }
    const onUp = () => { dragRef.current = null; document.body.style.userSelect = '' }
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [pos])

  // ESC
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'Escape') return; e.stopPropagation()
    if (sLightboxIdx.value !== null) sLightboxIdx.value = null
    else handleClose()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Close & cleanup
  function handleClose() {
    _frames.forEach(f => { if (f.blobUrl) { URL.revokeObjectURL(f.blobUrl); f.blobUrl = undefined } })
    if (_itemId && _frames.length > 0) {
      set_savedState({
        itemId: _itemId, frames: _frames.map(({ blobUrl: _b, ...rest }) => rest),
        exportType: sExportType.value, minPosMs: _minPosMs, maxPosMs: _maxPosMs,
        fpsFrac: { ..._fpsFrac }, lastClickedIdx: -1, fiMinIdx: _fiMinIdx, fiMaxIdx: _fiMaxIdx,
      })
    }
    _dragController?.abort(); set_dragController(null)
    _domObserver?.disconnect(); set_domObserver(null)
    document.body.classList.remove('jfs-fe-open'); setGesturesSuspended(false)
    set_lastClickedIdx(-1); set_dragMode(false); set_suppressNextMousedown(false)
    sLightboxIdx.value = null
    sModalPhase.value = 'skeleton'
    setFE(null)
  }

  // Video disconnect guard
  useEffect(() => {
    const obs = new MutationObserver(() => { if (!videoEl?.isConnected) handleClose() })
    obs.observe(document.body, { childList: true, subtree: true })
    set_domObserver(obs)
    return () => { obs.disconnect(); set_domObserver(null) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const page = useAtomValue(pageAtom)
  const ps = pos

  return createPortal(
    <div ref={rootRef} tabIndex={-1} onKeyDown={onKeyDown} onMouseDown={onDragStart}
      style={{
        position: 'fixed', zIndex: 99999, display: 'flex', flexDirection: 'column',
        width: 'min(92vw, 960px)', fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
        pointerEvents: 'auto',
        ...(ps ? { left: ps.x, top: ps.y, bottom: 'auto', marginLeft: 0 } : { bottom: 12, left: '50%', marginLeft: 'calc(-1 * min(46vw, 480px))' }),
      }}>
      {page === 'grid' && <GridPage onClose={handleClose} onExpand={dir => expandFrames(dir)} onGenerate={() => submitGenerate()} />}
      {page === 'progress' && <ProgressPage onClose={handleClose} onResult={(url, size) => { sResultUrl.value = url; sFileSize.value = size; sPage.value = 'result' }} />}
      {page === 'result' && <ResultPage onClose={handleClose} onBack={() => { sPage.value = 'grid' }} />}
      <Lightbox />
      <CropPopover />
    </div>,
    document.body,
  )
}

export { FrameExportModalApp }

// ── Frame export utilities (unchanged from original) ────────────────────────

export function updateFrameImage(idx: number): void {
  const f = _frames[idx]
  if (!f?.jpegUrl) return
  fetchFrameBlob(f.jpegUrl).then(({ blob, ptsMs }) => {
    const f2 = _frames[idx]; if (!f2) return
    if (ptsMs !== null) f2.actualPtsMs = ptsMs
    if (f2.blobUrl) URL.revokeObjectURL(f2.blobUrl)
    f2.loadError = false
    f2.blobUrl = URL.createObjectURL(blob)
    jstore.set(modalPhaseAtom, 'loading')
    renderGrid()
  }).catch(() => { _frames[idx].loadError = true; renderGrid() })
}

async function prefetchAndStream(items: Array<{ fiIdx: number; posMs: number }>, width: number): Promise<void> {
  await prefetch(_itemId, items, width)
  return new Promise(resolve => {
    const evSrc = openPrefetchStream(_itemId, width)
    const pending = new Set(items.map(f => f.posMs))
    sPrefetchTotal.value = pending.size; sPrefetchDone.value = 0
    evSrc.onmessage = (e) => {
      const posMs = parseInt(e.data); if (isNaN(posMs) || !pending.delete(posMs)) return
      sPrefetchDone.value = sPrefetchTotal.value - pending.size
      for (let i = 0; i < _frames.length; i++) {
        if (_frames[i].posMs === posMs) { _frames[i].jpegUrl = frameUrl(_itemId, _frames[i].fiIdx, _frames[i].posMs, width); _frames[i].loadError = false; updateFrameImage(i) }
      }
      if (pending.size === 0) { evSrc.close(); resolve(undefined) }
    }
    evSrc.onerror = () => { evSrc.close(); resolve(undefined) }
  }).then(() => {
    sPrefetchTotal.value = 0; sPrefetchDone.value = 0
    for (let i = 0; i < _frames.length; i++) {
      const f = _frames[i]; if (!f || f.removed || f.loadError || f.blobUrl) continue
      if (!f.jpegUrl) f.jpegUrl = frameUrl(_itemId, f.fiIdx, f.posMs, width)
      if (!f.blobUrl) updateFrameImage(i)
    }
  })
}

async function loadInitialFrames(): Promise<void> {
  if (!_videoEl) return
  const dur = _videoEl.duration; const durationMs = (isFinite(dur) && dur > 0) ? dur * 1000 : Number.MAX_SAFE_INTEGER
  const centerMs = Math.round(_videoEl.currentTime * 1000)
  const result = await fetchFrameIndex(_itemId)
  if (result) {
    if (result.fps.num > 0 && result.fps.den > 0) set_fpsFrac(result.fps); set_frameIndex(result.frames)
    const startMs = Math.max(0, centerMs - 1000); const endMs = centerMs + 1000
    let startFi = result.frames.findIndex(f => f.ms >= startMs); if (startFi < 0) startFi = 0
    const _centerFi = result.frames.findIndex(f => f.ms >= centerMs)
    let endFi = result.frames.findIndex(f => f.ms > endMs); if (endFi < 0) endFi = result.frames.length; endFi = Math.max(startFi, endFi - 1)
    set_fiMinIdx(startFi); set_fiMaxIdx(endFi)
    const slice = result.frames.slice(startFi, endFi + 1)
    set_minPosMs(slice[0]?.ms ?? centerMs); set_maxPosMs(slice[slice.length - 1]?.ms ?? centerMs)
    set_frames(slice.map((f, i) => ({ posMs: f.ms, fiIdx: startFi + i, actualPtsMs: f.ms, selected: true, jpegUrl: '', isJunk: false, junkReason: null })))
    renderGrid()
    await prefetchAndStream(slice.map((f, i) => ({ fiIdx: startFi + i, posMs: f.ms })), 320)
  } else {
    const fps = await fetchVideoFps(_itemId); set_fpsFrac(fps); set_frameIndex(null)
    const startMs = Math.max(0, centerMs - 1000); const endMs = Math.min(durationMs, centerMs + 1000)
    const positions = samplePositionsInRange(startMs, endMs)
    set_minPosMs(positions[0] ?? centerMs); set_maxPosMs(positions[positions.length - 1] ?? centerMs)
    set_frames(positions.map(posMs => ({ posMs, fiIdx: -1, selected: true, jpegUrl: '', isJunk: false, junkReason: null })))
    renderGrid()
    await prefetchAndStream(positions.map(posMs => ({ fiIdx: -1, posMs })), 320)
  }
}

export async function expandFrames(direction: number): Promise<void> {
  if (!_videoEl) return
  const dur = _videoEl.duration; const durationMs = (isFinite(dur) && dur > 0) ? dur * 1000 : Number.MAX_SAFE_INTEGER; const rangeMs = 1000
  const prevBtnId = direction < 0 ? 'jfs-fe-prev' : 'jfs-fe-next'
  const btn = document.getElementById(prevBtnId); if (btn) btn.setAttribute('disabled', '')
  try {
    if (_frameIndex && _frameIndex.length > 0) {
      let sliceStart: number, sliceEnd: number
      if (direction < 0) {
        if (_fiMinIdx <= 0) return;
        const targetMs = _frameIndex[_fiMinIdx].ms - rangeMs; sliceStart = 0
        for (let i = _fiMinIdx - 1; i >= 0; i--) { if (_frameIndex[i].ms < Math.max(0, targetMs)) { sliceStart = i + 1; break } }
        sliceEnd = _fiMinIdx - 1; set_fiMinIdx(sliceStart); set_minPosMs(_frameIndex[sliceStart].ms)
      } else {
        if (_fiMaxIdx >= _frameIndex.length - 1) return; sliceStart = _fiMaxIdx + 1
        const targetMs = _frameIndex[_fiMaxIdx].ms + rangeMs; sliceEnd = _frameIndex.length - 1
        for (let i = sliceStart; i < _frameIndex.length; i++) { if (_frameIndex[i].ms > targetMs) { sliceEnd = i - 1; break } }
        set_fiMaxIdx(sliceEnd); set_maxPosMs(_frameIndex[sliceEnd].ms)
      }
      const slice = _frameIndex.slice(sliceStart, sliceEnd + 1); if (slice.length === 0) return
      const placeholders = slice.map((f, i) => ({ posMs: f.ms, fiIdx: sliceStart + i, actualPtsMs: f.ms, selected: true, jpegUrl: '', isJunk: false, junkReason: null }))
      set_frames(direction < 0 ? [...placeholders, ..._frames] : [..._frames, ...placeholders]); renderGrid()
      await prefetchAndStream(slice.map((f, i) => ({ fiIdx: sliceStart + i, posMs: f.ms })), 320)
    } else {
      let queryStart: number, queryEnd: number
      if (direction < 0) { queryEnd = _minPosMs; queryStart = Math.max(0, _minPosMs - rangeMs) }
      else { queryStart = _maxPosMs; queryEnd = Math.min(durationMs, _maxPosMs + rangeMs) }
      const newPositions = samplePositionsInRange(queryStart, queryEnd)
      if (newPositions.length > 0) {
        if (direction < 0) set_minPosMs(newPositions[0]); else set_maxPosMs(newPositions[newPositions.length - 1])
        const placeholders = newPositions.map(posMs => ({ posMs, fiIdx: -1, selected: true, jpegUrl: '', isJunk: false, junkReason: null }))
        set_frames(direction < 0 ? [...placeholders, ..._frames] : [..._frames, ...placeholders]); renderGrid()
        await prefetchAndStream(newPositions.map(posMs => ({ fiIdx: -1, posMs })), 320)
      }
    }
  } finally { if (btn) btn.removeAttribute('disabled'); renderGrid() }
}

async function submitGenerate(): Promise<void> {
  const exportType = sExportType.value; const st = sSettings.value
  const allSelected = _frames.filter(f => f.selected && !f.removed && !f.skeleton)
  const seenKey = new Set<number>()
  const selected = allSelected.filter(f => { const key = f.fiIdx; if (seenKey.has(key)) return false; seenKey.add(key); return true })
  if (selected.length < 2) { alert(t('export.minFrames')); return }
  if (selected.length > 240 && !confirm(t('export.largeWarning').replace('{n}', String(selected.length)))) return
  const format = exportType === 'animate' ? st.animateFormat : st.stitchFormat
  const body: any = {
    itemId: _itemId, itemTitle: document.title.replace(/\s*[-|]\s*Jellyfin\s*$/i, '').trim() || 'export', type: exportType,
    frames: selected.map(f => f.fiIdx >= 0 ? { frameIdx: f.fiIdx } : { positionMs: Math.round(f.posMs) }),
    params: { format, resizeMode: st.width.mode === 'userInput' ? 'width' : 'height',
      customWidth: st.width.value || null, customHeight: st.height.value || null,
      resolutionPreset: st.resolutionPreset, speed: st.speed, loopCount: st.loopCount, cropX: st.cropRect?.x ?? 0,
      cropY: st.cropRect?.y ?? 0, cropW: st.cropRect?.w ?? 0, cropH: st.cropRect?.h ?? 0,
      quality: exportType === 'animate' ? st.animateQuality : st.stitchQuality },
  }
  try {
    const taskId = await generateExport(body); sProgressTaskId.value = taskId; sPage.value = 'progress'
  } catch (e) { alert(t('export.failed').replace('{msg}', e instanceof Error ? e.message : String(e))) }
}
