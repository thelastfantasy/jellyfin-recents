import { render } from 'preact'
import { setGesturesSuspended } from '../hooks/useGestures'
import { t } from '../lib/i18n'
import type { components } from '../types/jellyfin-suite-api'

import {
  sPage, sFrames, sExportType, sPrefetchTotal, sPrefetchDone,
  sProgressTaskId, sResultUrl, sFileSize, sLightboxIdx,
  _frames, _itemId, _videoEl, _fpsFrac, _frameIndex,
  _fiMinIdx, _fiMaxIdx, _minPosMs, _maxPosMs,
  _dragController, _domObserver, _modalRoot, _savedState,
  set_frames, set_itemId, set_videoEl, set_fpsFrac, set_frameIndex,
  set_fiMinIdx, set_fiMaxIdx, set_minPosMs, set_maxPosMs,
  set_dragController, set_domObserver, set_modalRoot, set_savedState,
  set_lastClickedIdx, set_dragMode, set_activeTaskId, _activeTaskId,
  set_suppressNextMousedown,
  renderGrid, samplePositionsInRange,
} from './state'

import {
  fetchVideoFps, fetchFrameIndex, prefetch, openPrefetchStream,
  fetchFrameBlob, frameUrl, generateExport, buildResultUrl,
} from '../api/frameExportApi'

import { GridPage }     from '../components/GridPage'
import { ProgressPage } from '../components/ProgressPage'
import { ResultPage }   from '../components/ResultPage'
import { Lightbox }     from '../components/Lightbox'
import { CropPopover }  from '../components/CropPopover'

void t  // i18n is imported by child components; keep the import for side effects

type GenerateRequest = components['schemas']['GenerateRequest']

// ── updateFrameImage ──────────────────────────────────────────────────────────
export function updateFrameImage(idx: number): void {
  const f = _frames[idx]
  if (!f?.jpegUrl) return

  fetchFrameBlob(f.jpegUrl).then(({ blob, ptsMs }) => {
    const f2 = _frames[idx]
    if (!f2) return
    if (ptsMs !== null) f2.actualPtsMs = ptsMs
    if (f2.blobUrl) URL.revokeObjectURL(f2.blobUrl)
    f2.blobUrl = URL.createObjectURL(blob)
    renderGrid()
  }).catch(() => {
    _frames[idx].loadError = true
    renderGrid()
  })
}

// ── prefetchAndStream ─────────────────────────────────────────────────────────
async function prefetchAndStream(
  items: Array<{ fiIdx: number; posMs: number }>,
  width: number,
): Promise<void> {
  if (items.length === 0) return
  await prefetch(_itemId, items, width)

  return new Promise((resolve) => {
    const evSrc  = openPrefetchStream(_itemId, width)
    const pending = new Set(items.map(it => it.posMs))
    sPrefetchTotal.value = pending.size
    sPrefetchDone.value  = 0

    evSrc.onmessage = (e) => {
      const posMs = parseInt(e.data)
      if (isNaN(posMs) || !pending.delete(posMs)) return
      sPrefetchDone.value = sPrefetchTotal.value - pending.size
      for (let i = 0; i < _frames.length; i++) {
        if (_frames[i].posMs === posMs) {
          _frames[i].jpegUrl = frameUrl(_itemId, _frames[i].fiIdx, _frames[i].posMs, width)
          updateFrameImage(i)
        }
      }
      if (pending.size === 0) { evSrc.close(); resolve(undefined) }
    }

    evSrc.onerror = () => { evSrc.close(); resolve(undefined) }
  }).then(() => {
    sPrefetchTotal.value = 0
    sPrefetchDone.value  = 0
    for (let i = 0; i < _frames.length; i++) {
      if (_frames[i].jpegUrl && !_frames[i].blobUrl && !_frames[i].loadError) {
        updateFrameImage(i)
      }
    }
  })
}

// ── loadInitialFrames ─────────────────────────────────────────────────────────
async function loadInitialFrames(): Promise<void> {
  if (!_videoEl) return
  const dur        = _videoEl.duration
  const durationMs = (isFinite(dur) && dur > 0) ? dur * 1000 : Number.MAX_SAFE_INTEGER
  const centerMs   = Math.round(_videoEl.currentTime * 1000)

  const result = await fetchFrameIndex(_itemId)

  if (result) {
    if (result.fps.num > 0 && result.fps.den > 0) set_fpsFrac(result.fps)
    set_frameIndex(result.frames)

    const startMs = Math.max(0, centerMs - 1000)
    const endMs   = centerMs + 1000

    let startFi = result.frames.findIndex(f => f.ms >= startMs)
    if (startFi < 0) startFi = 0
    let endFi = result.frames.findIndex(f => f.ms > endMs)
    if (endFi < 0) endFi = result.frames.length
    endFi = Math.max(startFi, endFi - 1)

    set_fiMinIdx(startFi)
    set_fiMaxIdx(endFi)

    const slice = result.frames.slice(startFi, endFi + 1)
    set_minPosMs(slice[0]?.ms ?? centerMs)
    set_maxPosMs(slice[slice.length - 1]?.ms ?? centerMs)
    set_frames(slice.map((f, i) => ({
      posMs: f.ms, fiIdx: startFi + i, actualPtsMs: f.ms, selected: true, jpegUrl: '', isJunk: false, junkReason: null,
    })))
    renderGrid()
    await prefetchAndStream(slice.map((f, i) => ({ fiIdx: startFi + i, posMs: f.ms })), 320)
  } else {
    const fps = await fetchVideoFps(_itemId)
    set_fpsFrac(fps)
    set_frameIndex(null)

    const startMs   = Math.max(0, centerMs - 1000)
    const endMs     = Math.min(durationMs, centerMs + 1000)
    const positions = samplePositionsInRange(startMs, endMs)
    set_minPosMs(positions[0] ?? centerMs)
    set_maxPosMs(positions[positions.length - 1] ?? centerMs)
    set_frames(positions.map(posMs => ({ posMs, fiIdx: -1, selected: true, jpegUrl: '', isJunk: false, junkReason: null })))
    renderGrid()
    await prefetchAndStream(positions.map(posMs => ({ fiIdx: -1, posMs })), 320)
  }
}

// ── expandFrames ──────────────────────────────────────────────────────────────
export async function expandFrames(direction: number): Promise<void> {
  if (!_videoEl) return
  const dur        = _videoEl.duration
  const durationMs = (isFinite(dur) && dur > 0) ? dur * 1000 : Number.MAX_SAFE_INTEGER
  const rangeMs    = 1000

  const prevBtnId = direction < 0 ? 'jfs-fe-prev' : 'jfs-fe-next'
  const btn = document.getElementById(prevBtnId)
  if (btn) btn.setAttribute('disabled', '')

  try {
    if (_frameIndex && _frameIndex.length > 0) {
      let sliceStart: number, sliceEnd: number

      if (direction < 0) {
        if (_fiMinIdx <= 0) return
        const targetMs = _frameIndex[_fiMinIdx].ms - rangeMs
        sliceStart = 0
        for (let i = _fiMinIdx - 1; i >= 0; i--) {
          if (_frameIndex[i].ms < Math.max(0, targetMs)) { sliceStart = i + 1; break }
        }
        sliceEnd = _fiMinIdx - 1
        set_fiMinIdx(sliceStart)
        set_minPosMs(_frameIndex[sliceStart].ms)
      } else {
        if (_fiMaxIdx >= _frameIndex.length - 1) return
        sliceStart = _fiMaxIdx + 1
        const targetMs = _frameIndex[_fiMaxIdx].ms + rangeMs
        sliceEnd = _frameIndex.length - 1
        for (let i = sliceStart; i < _frameIndex.length; i++) {
          if (_frameIndex[i].ms > targetMs) { sliceEnd = i - 1; break }
        }
        set_fiMaxIdx(sliceEnd)
        set_maxPosMs(_frameIndex[sliceEnd].ms)
      }

      const slice = _frameIndex.slice(sliceStart, sliceEnd + 1)
      if (slice.length === 0) return

      const placeholders = slice.map((f, i) => ({
        posMs: f.ms, fiIdx: sliceStart + i, actualPtsMs: f.ms, selected: true, jpegUrl: '', isJunk: false, junkReason: null,
      }))
      set_frames(direction < 0 ? [...placeholders, ..._frames] : [..._frames, ...placeholders])
      renderGrid()
      await prefetchAndStream(slice.map((f, i) => ({ fiIdx: sliceStart + i, posMs: f.ms })), 320)
    } else {
      let queryStart: number, queryEnd: number
      if (direction < 0) {
        queryEnd   = _minPosMs
        queryStart = Math.max(0, _minPosMs - rangeMs)
      } else {
        queryStart = _maxPosMs
        queryEnd   = Math.min(durationMs, _maxPosMs + rangeMs)
      }
      const newPositions = samplePositionsInRange(queryStart, queryEnd)
      if (newPositions.length > 0) {
        if (direction < 0) set_minPosMs(newPositions[0])
        else               set_maxPosMs(newPositions[newPositions.length - 1])
        const placeholders = newPositions.map(posMs => ({
          posMs, fiIdx: -1, selected: true, jpegUrl: '', isJunk: false, junkReason: null,
        }))
        set_frames(direction < 0 ? [...placeholders, ..._frames] : [..._frames, ...placeholders])
        renderGrid()
        await prefetchAndStream(newPositions.map(posMs => ({ fiIdx: -1, posMs })), 320)
      } else {
        if (direction < 0) set_minPosMs(queryStart)
        else               set_maxPosMs(queryEnd)
      }
    }
  } finally {
    if (btn) btn.removeAttribute('disabled')
    renderGrid()
  }
}

// ── submitGenerate ────────────────────────────────────────────────────────────
async function submitGenerate(): Promise<void> {
  const exportType = sExportType.value
  const st         = sFrames.value    // read current frames from signal
  void st
  const { sSettings } = await import('./state')
  const settings   = sSettings.value
  const allSelected = _frames.filter(f => f.selected && !f.removed)
  const seenKey     = new Set<number>()
  const selected    = allSelected.filter(f => {
    const key = f.fiIdx >= 0 ? f.fiIdx : Math.round(f.posMs)
    if (seenKey.has(key)) return false
    seenKey.add(key)
    return true
  })
  if (selected.length < 2) { alert(t('export.minFrames')); return }
  if (selected.length > 240 && !confirm(t('export.largeWarning').replace('{n}', String(selected.length)))) return

  const format = exportType === 'animate' ? settings.animateFormat : settings.stitchFormat
  const body: GenerateRequest = {
    itemId:    _itemId,
    itemTitle: document.title.replace(/\s*[-|]\s*Jellyfin\s*$/i, '').trim() || 'export',
    type:      exportType,
    frames:    selected.map(f => f.fiIdx >= 0 ? { frameIdx: f.fiIdx } : { positionMs: Math.round(f.posMs) }),
    params: {
      format,
      resizeMode:       settings.resizeMode,
      customWidth:      settings.customWidth  || null,
      customHeight:     settings.customHeight || null,
      resolutionPreset: settings.resolutionPreset,
      speed:            settings.speed,
      loopCount:        settings.loopCount,
      cropX:            settings.cropRect?.x ?? 0,
      cropY:            settings.cropRect?.y ?? 0,
      cropW:            settings.cropRect?.w ?? 0,
      cropH:            settings.cropRect?.h ?? 0,
      quality:          exportType === 'animate' ? settings.animateQuality : settings.stitchQuality,
    },
  }

  try {
    const taskId = await generateExport(body)
    showProgressPage(taskId)
  } catch (e) {
    alert(t('export.failed').replace('{msg}', e instanceof Error ? e.message : String(e)))
  }
}

// ── makeDraggable ─────────────────────────────────────────────────────────────
function makeDraggable(el: HTMLDivElement): AbortController {
  const ac = new AbortController()
  const { signal: sig } = ac
  let dragging = false, ox = 0, oy = 0

  el.addEventListener('mousedown', (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('button,select,input,label,a')) return
    const rect = el.getBoundingClientRect()
    ox = e.clientX - rect.left
    oy = e.clientY - rect.top
    el.style.bottom    = ''
    el.style.transform = 'none'
    el.style.left      = `${rect.left}px`
    el.style.top       = `${rect.top}px`
    dragging = true
    document.body.style.userSelect = 'none'
    e.preventDefault()
  }, { signal: sig })

  document.addEventListener('mousemove', (e: MouseEvent) => {
    if (!dragging) return
    el.style.left = `${Math.max(0, Math.min(window.innerWidth - el.offsetWidth, e.clientX - ox))}px`
    el.style.top  = `${Math.max(0, Math.min(window.innerHeight - 40, e.clientY - oy))}px`
  }, { signal: sig })

  document.addEventListener('mouseup', () => {
    if (dragging) { dragging = false; document.body.style.userSelect = '' }
  }, { signal: sig })

  return ac
}

// ── escHandler ────────────────────────────────────────────────────────────────
function escHandler(e: KeyboardEvent): void {
  e.stopPropagation()
  if (e.key === 'Escape') closeModal()
}

// ── Root component ────────────────────────────────────────────────────────────
function FrameExportModal() {
  const page = sPage.value
  return (
    <>
      {page === 'progress' && (
        <ProgressPage
          onClose={closeModal}
          onResult={(url, size) => showResultPage(url, size)}
        />
      )}
      {page === 'result' && (
        <ResultPage
          onBack={() => { sPage.value = 'grid' }}
          onClose={closeModal}
        />
      )}
      {page === 'grid' && (
        <GridPage
          onClose={closeModal}
          onExpand={expandFrames}
          onGenerate={submitGenerate}
        />
      )}
      <Lightbox />
      <CropPopover />
    </>
  )
}

// ── Public API ────────────────────────────────────────────────────────────────

export function openFrameExportModal(videoEl: HTMLVideoElement, itemId: string): void {
  set_videoEl(videoEl)
  if (itemId !== _itemId) set_frameIndex(null)
  set_itemId(itemId)
  set_activeTaskId('')

  videoEl.pause()
  document.body.classList.add('jfs-fe-open')
  setGesturesSuspended(true)

  const root = document.createElement('div')
  root.setAttribute('data-jfs-modal-root', '')
  Object.assign(root.style, {
    position: 'fixed', bottom: '12px', left: '50%',
    transform: 'translateX(-50%)',
    width: 'min(92vw, 960px)', zIndex: '99999',
    display: 'flex', flexDirection: 'column', boxSizing: 'border-box',
    fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
    pointerEvents: 'none',
  })
  root.addEventListener('wheel', (e) => { e.stopPropagation() }, { passive: true })
  document.addEventListener('keydown', escHandler, { capture: true })
  document.body.appendChild(root)
  set_modalRoot(root)

  const dc = makeDraggable(root)
  set_dragController(dc)
  dc.signal.addEventListener('abort', () => { set_dragMode(false) })

  const obs = new MutationObserver(() => { if (!_videoEl?.isConnected) closeModal() })
  obs.observe(document.body, { childList: true, subtree: true })
  set_domObserver(obs)

  // Restore state if same item + playback position still within range
  const currentMs = Math.round(videoEl.currentTime * 1000)
  if (
    _savedState &&
    _savedState.itemId === itemId &&
    currentMs >= _savedState.minPosMs - 2000 &&
    currentMs <= _savedState.maxPosMs + 2000
  ) {
    set_frames(_savedState.frames.map(f => ({ ...f })))
    sExportType.value = _savedState.exportType
    set_minPosMs(_savedState.minPosMs)
    set_maxPosMs(_savedState.maxPosMs)
    set_fpsFrac(_savedState.fpsFrac)
    set_lastClickedIdx(_savedState.lastClickedIdx)
    set_fiMinIdx(_savedState.fiMinIdx)
    set_fiMaxIdx(_savedState.fiMaxIdx)
    sPrefetchTotal.value = 0
    sPrefetchDone.value  = 0
    sPage.value = 'grid'
    render(<FrameExportModal />, root)
    renderGrid()
    for (let i = 0; i < _frames.length; i++) {
      if (_frames[i].jpegUrl && !_frames[i].blobUrl && !_frames[i].loadError) {
        updateFrameImage(i)
      }
    }
    return
  }

  set_frames([])
  sPage.value = 'grid'
  sLightboxIdx.value = null
  render(<FrameExportModal />, root)
  loadInitialFrames()
}

export function closeModal(): void {
  _frames.forEach(f => { if (f.blobUrl) { URL.revokeObjectURL(f.blobUrl); f.blobUrl = undefined } })

  if (_itemId && _frames.length > 0) {
    set_savedState({
      itemId:         _itemId,
      frames:         _frames.map(({ blobUrl: _b, ...rest }) => rest),
      exportType:     sExportType.value,
      minPosMs:       _minPosMs,
      maxPosMs:       _maxPosMs,
      fpsFrac:        { ..._fpsFrac },
      lastClickedIdx: -1,
      fiMinIdx:       _fiMinIdx,
      fiMaxIdx:       _fiMaxIdx,
    })
  }

  document.removeEventListener('keydown', escHandler, true)
  _dragController?.abort()
  set_dragController(null)
  _domObserver?.disconnect()
  set_domObserver(null)
  document.body.classList.remove('jfs-fe-open')
  setGesturesSuspended(false)

  if (_modalRoot) {
    render(null, _modalRoot)
    _modalRoot.remove()
    set_modalRoot(null)
  }

  set_lastClickedIdx(-1)
  set_dragMode(false)
  set_suppressNextMousedown(false)
}

export function showProgressPage(taskId: string): void {
  set_activeTaskId(taskId)
  if (!_modalRoot) return
  _modalRoot.style.display = ''
  Object.assign(_modalRoot.style, { top: '', bottom: '12px', left: '50%', transform: 'translateX(-50%)' })
  sProgressTaskId.value = taskId
  sPage.value = 'progress'
}

export function showResultPage(resultUrl: string, fileSize: number): void {
  if (!_modalRoot) return
  Object.assign(_modalRoot.style, { top: '', bottom: '12px', left: '50%', transform: 'translateX(-50%)' })
  sResultUrl.value = resultUrl
  sFileSize.value  = fileSize
  sPage.value = 'result'
  void buildResultUrl  // keep import alive
  void _activeTaskId
}
