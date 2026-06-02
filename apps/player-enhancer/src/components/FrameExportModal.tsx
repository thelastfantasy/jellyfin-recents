import { useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { getDefaultStore, useAtomValue, useSetAtom } from 'jotai'
import { setGesturesSuspended } from '../hooks/useGestures'
import {
  sPage, sResultUrl, sFileSize, sLightboxIdx, sModalPhase,
  sPrefetchTotal, sPrefetchDone, sExportType, sSettings, modalPhaseAtom,
  pageAtom, modalMinimizedAtom, _feOpen,
  _frames, _itemId, _videoEl, _fpsFrac, _frameIndex,
  _fiMinIdx, _fiMaxIdx, _minPosMs, _maxPosMs, _savedState,
  setFrames, setItemId, setVideoEl, setFpsFrac, setFrameIndex, setItemTitle,
  setFiMinIdx, setFiMaxIdx, setMinPosMs, setMaxPosMs,
  setSavedState, setLastClickedIdx, setDragMode, setActiveTaskId,
  setSuppressNextMousedown, samplePositionsInRange, sProgressTaskId,
  FrameEntry,
} from '../core/state'
import { fetchVideoFps, openFrameInfoStream, openPrefetchStream,
  frameUrl, generateExport,
} from '../api/frameExportApi'
import { fetchItemName } from '../services/screenshot'
import type { components } from '@jfs/api-types'
import { t } from '../lib/i18n'
import { GridPage }     from './GridPage'
import { ProgressPage } from './ProgressPage'
import { ResultPage }   from './ResultPage'
import { Lightbox }     from './Lightbox'
import { CropPopover }  from './CropPopover'

const jstore = getDefaultStore()

// ── Module-level helpers ─────────────────────────────────────────────────────

type FiEntry = { ms: number; isKey: boolean; frameIndex: number }

function lastFiIdx(fi: FiEntry[], ms: number): number {
  for (let i = fi.length - 1; i >= 0; i--) if (fi[i].ms <= ms) return i
  return 0
}

function sliceRange(fi: FiEntry[], center: number): [number, number] {
  const t0 = fi[center].ms - 1000; const t1 = fi[center].ms + 1000
  let a = 0; for (let i = 0; i < fi.length; i++) if (fi[i].ms >= t0) { a = i; break }
  let b = fi.length - 1; for (let i = fi.length - 1; i >= 0; i--) if (fi[i].ms <= t1) { b = i; break }
  return [a, b]
}

// ── Inner modal component ────────────────────────────────────────────────────

function FrameExportModalInner({ videoEl, itemId, minimized }: {
  videoEl: HTMLVideoElement; itemId: string; minimized: boolean
}) {
  const setFE = useSetAtom(_feOpen)
  const rootRef = useRef<HTMLDivElement>(null)
  const page = useAtomValue(pageAtom)
  const abortRef = useRef<AbortController[]>([])
  const accumRef = useRef<FiEntry[]>([])
  const sawBatchRef = useRef(false)

  // ── helpers ────────────────────────────────────────────────────────────────

  function flush() { setFrames([..._frames]) }

  function markReady(idx: number) {
    setFrames(_frames.map((f, i) => i === idx
      ? { ...f, jpegUrl: frameUrl(_itemId, f.fiIdx, f.posMs, 320), loadError: false }
      : f))
  }

  function fillRemaining(w: number) {
    setFrames(_frames.map(f => (f.removed || f.loadError || f.jpegUrl) ? f
      : { ...f, jpegUrl: frameUrl(_itemId, f.fiIdx, f.posMs, w) }))
    sPrefetchTotal.value = 0; sPrefetchDone.value = 0
  }

  function setRangeAndFrames(fi: FiEntry[], center: number, start: number, end: number) {
    setFiMinIdx(start); setFiMaxIdx(end)
    const slice = fi.slice(start, end + 1)
    setMinPosMs(slice[0]?.ms ?? center); setMaxPosMs(slice[slice.length - 1]?.ms ?? center)
    setFrames(slice.map(f => ({ posMs: f.ms, fiIdx: f.frameIndex, selected: true, jpegUrl: '', isJunk: false, junkReason: null } as FrameEntry)))
  }

  function startPrefetch() {
    const idxs = _frames.map(f => f.fiIdx).filter(i => i >= 0)
    if (idxs.length === 0) return
    const ac = new AbortController(); abortRef.current.push(ac)
    const ev = openPrefetchStream(_itemId, 320, idxs)
    const pend = new Set(idxs); sPrefetchTotal.value = pend.size; sPrefetchDone.value = 0

    ev.onmessage = (e) => {
      if (ac.signal.aborted) return
      try {
        const d = JSON.parse(e.data)
        if (d.done) { ev.close(); fillRemaining(320); return }
        const v: number = d.frameReady; if (typeof v !== 'number' || !pend.has(v)) return
        pend.delete(v); sPrefetchDone.value = sPrefetchTotal.value - pend.size
        const i = _frames.findIndex(f => f.fiIdx === v); if (i < 0) return
        if (jstore.get(modalPhaseAtom) === 'skeleton') jstore.set(modalPhaseAtom, 'loading')
        markReady(i); if (pend.size === 0) { ev.close() }
      } catch { /* ignore */ }
    }
    ev.onerror = () => { ev.close(); fillRemaining(320) }
  }

  // ── expand ─────────────────────────────────────────────────────────────────

  const expandBack = useCallback(() => {
    if (!_frameIndex) return
    const n = Math.round(_fpsFrac.num / _fpsFrac.den); const a = _fiMinIdx - n
    if (a < 0) return
    const slice = _frameIndex.slice(a, _fiMinIdx)
    const ents = slice.map(f => ({ posMs: f.ms, fiIdx: f.frameIndex, selected: true, jpegUrl: '', isJunk: false, junkReason: null } as FrameEntry))
    setFrames([...ents, ..._frames])
    setFiMinIdx(a); setMinPosMs(_frameIndex[a].ms)
    flush()
    startPrefetch()
  }, [])

  const expandForward = useCallback(() => {
    if (!_frameIndex) return
    const n = Math.round(_fpsFrac.num / _fpsFrac.den); const b = _fiMaxIdx + n
    if (b >= _frameIndex.length) return
    const slice = _frameIndex.slice(_fiMaxIdx + 1, b + 1)
    const ents = slice.map(f => ({ posMs: f.ms, fiIdx: f.frameIndex, selected: true, jpegUrl: '', isJunk: false, junkReason: null } as FrameEntry))
    setFrames([..._frames, ...ents])
    setFiMaxIdx(b); setMaxPosMs(_frameIndex[b].ms)
    flush()
    startPrefetch()
  }, [])

  // ── submit ─────────────────────────────────────────────────────────────────

  const submitGenerate = useCallback(async () => {
    const ex = sExportType.value; const st = sSettings.value
    const sel = _frames.filter(f => f.selected && !f.removed && !f.skeleton)
    const seen = new Set<number>(); const uniq = sel.filter(f => { const k = f.fiIdx; if (seen.has(k)) return false; seen.add(k); return true })
    if (uniq.length < 2) { alert(t('export.minFrames')); return }
    if (uniq.length > 240 && !confirm(t('export.largeWarning').replace('{n}', String(uniq.length)))) return
    const fmt = ex === 'animate' ? st.animateFormat : st.stitchFormat
    const name = await fetchItemName(_itemId)
    const title = (name ?? document.title.replace(/\s*[-|]\s*Jellyfin\s*$/i, '').trim()) || 'export'
    const body: components['schemas']['GenerateRequest'] = {
      itemId: _itemId, itemTitle: title, type: ex,
      frames: uniq.map(f => f.fiIdx >= 0 ? { frameIdx: f.fiIdx } : { positionMs: Math.round(f.posMs) }),
      params: {
        format: fmt, resizeMode: st.width.mode === 'userInput' ? 'width' : 'height',
        customWidth: st.width.value || null, customHeight: st.height.value || null,
        resolutionPreset: st.resolutionPreset, speed: st.speed, loopCount: st.loopCount,
        cropX: st.cropRect?.x ?? 0, cropY: st.cropRect?.y ?? 0, cropW: st.cropRect?.w ?? 0, cropH: st.cropRect?.h ?? 0,
        quality: ex === 'animate' ? st.animateQuality : st.stitchQuality,
      },
    }
    try {
      const taskId = await generateExport(body); sProgressTaskId.value = taskId; sPage.value = 'progress'
    } catch (e) { alert(t('export.failed').replace('{msg}', e instanceof Error ? e.message : String(e))) }
  }, [])

  // ── close / minimize ───────────────────────────────────────────────────────

  const handleClose = useCallback(() => {
    setGesturesSuspended(false)
    document.body.classList.remove('jfs-fe-open')
    sLightboxIdx.value = null; sModalPhase.value = 'skeleton'
    abortRef.current.forEach(c => c.abort()); abortRef.current = []
    setLastClickedIdx(-1); setDragMode(false); setSuppressNextMousedown(false)
    if (_itemId && _frames.length > 0) setSavedState({
      itemId: _itemId, frames: _frames.map(f => ({ ...f })), exportType: sExportType.value,
      minPosMs: _minPosMs, maxPosMs: _maxPosMs, fpsFrac: { ..._fpsFrac },
      lastClickedIdx: -1, fiMinIdx: _fiMinIdx, fiMaxIdx: _fiMaxIdx,
    })
    setFE(null)
  }, [])

  const handleMinimize = useCallback(() => {
    setGesturesSuspended(false)
    document.body.classList.remove('jfs-fe-open')
    jstore.set(modalMinimizedAtom, true)
    if (_itemId && _frames.length > 0) setSavedState({
      itemId: _itemId, frames: _frames.map(f => ({ ...f })), exportType: sExportType.value,
      minPosMs: _minPosMs, maxPosMs: _maxPosMs, fpsFrac: { ..._fpsFrac },
      lastClickedIdx: -1, fiMinIdx: _fiMinIdx, fiMaxIdx: _fiMaxIdx,
    })
  }, [])

  // ── keyboard ───────────────────────────────────────────────────────────────

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'Escape') return; e.stopPropagation()
    if (sLightboxIdx.value !== null) sLightboxIdx.value = null
    else handleClose()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── lifecycle ──────────────────────────────────────────────────────────────

  useEffect(() => {
    setVideoEl(videoEl)
    if (itemId !== _itemId) { setFrameIndex(null); setFpsFrac({ num: 24, den: 1 }); abortRef.current.forEach(c => c.abort()); abortRef.current = [] }
    setItemId(itemId); setActiveTaskId('')
    fetchItemName(itemId).then((n: string | null) => { if (n) setItemTitle(n) })
    videoEl.pause()
    document.body.classList.add('jfs-fe-open')
    setGesturesSuspended(true)

    const centerMs = Math.round(videoEl.currentTime * 1000)

    // saved state
    if (_savedState && _savedState.itemId === itemId && centerMs >= _savedState.minPosMs && centerMs <= _savedState.maxPosMs) {
      abortRef.current.forEach(c => c.abort()); abortRef.current = []
      setFrames(_savedState.frames.map(f => ({ ...f })))
      sExportType.value = _savedState.exportType
      setMinPosMs(_savedState.minPosMs); setMaxPosMs(_savedState.maxPosMs)
      setFpsFrac(_savedState.fpsFrac); setLastClickedIdx(_savedState.lastClickedIdx)
      setFiMinIdx(_savedState.fiMinIdx); setFiMaxIdx(_savedState.fiMaxIdx)
      sPrefetchTotal.value = 0; sPrefetchDone.value = 0
      sPage.value = 'grid'; sLightboxIdx.value = null
      flush()
      setFrames(_frames.map(f => f.jpegUrl ? { ...f, loadError: false } : f))
      flush()
      return
    }

    // preloaded
    if (_frameIndex && _frameIndex.length > 0) {
      const c = lastFiIdx(_frameIndex, centerMs)
      const [a, b] = sliceRange(_frameIndex, c)
      sPage.value = 'grid'; sLightboxIdx.value = null
      setRangeAndFrames(_frameIndex, centerMs, a, b)
      flush(); startPrefetch()
      return
    }

    // skeleton + load
    setFrames([]); sPage.value = 'grid'; sLightboxIdx.value = null
    const fpsN = _fpsFrac.num > 0 ? _fpsFrac.num : 24; const fpsD = _fpsFrac.den > 0 ? _fpsFrac.den : 1
    const n = Math.round(2000 / 1000 * fpsN / fpsD)
    setFrames(Array.from({ length: n }, (_, i) => ({
      posMs: Math.round(centerMs - 1000 + i * fpsD * 1000 / fpsN),
      fiIdx: -1, selected: true, jpegUrl: '', isJunk: false, junkReason: null, skeleton: true,
    } as FrameEntry)))
    flush()

    const ac = new AbortController(); abortRef.current.push(ac)
    accumRef.current = []; sawBatchRef.current = false
    void openFrameInfoStream(itemId, centerMs,
      batch => {
        if (ac.signal.aborted) return
        accumRef.current.push(...batch)
        if (!sawBatchRef.current) {
          sawBatchRef.current = true
          const fi = accumRef.current; const c = lastFiIdx(fi, centerMs)
          const [a, b] = sliceRange(fi, c)
          setRangeAndFrames(fi, centerMs, a, b)
          flush(); startPrefetch()
        }
      },
      fps => {
        if (ac.signal.aborted) return
        setFpsFrac(fps); setFrameIndex(accumRef.current)
        const [a, b] = sliceRange(accumRef.current, lastFiIdx(accumRef.current, centerMs))
        setFiMinIdx(a); setFiMaxIdx(b)
        setMinPosMs(accumRef.current[a]?.ms ?? centerMs)
        setMaxPosMs(accumRef.current[b]?.ms ?? centerMs)
      },
      async () => {
        if (ac.signal.aborted || sawBatchRef.current) return
        const fps = await fetchVideoFps(itemId); setFpsFrac(fps); setFrameIndex(null)
        const s = Math.max(0, centerMs - 1000); const e = Math.min(Number.MAX_SAFE_INTEGER, centerMs + 1000)
        const pos = samplePositionsInRange(s, e)
        setMinPosMs(pos[0] ?? centerMs); setMaxPosMs(pos[pos.length - 1] ?? centerMs)
        setFrames(pos.map(p => ({ posMs: p, fiIdx: -1, selected: true, jpegUrl: '', isJunk: false, junkReason: null } as FrameEntry)))
      },
    )

    return () => {
      ac.abort()
      abortRef.current = abortRef.current.filter(c => c !== ac)
    }
  }, [videoEl, itemId])

  return createPortal(
    <div ref={rootRef} tabIndex={-1} onKeyDown={onKeyDown}
      style={{
        position: 'fixed', bottom: 12, left: '50%', zIndex: 99999,
        display: minimized ? 'none' : 'flex', flexDirection: 'column',
        width: 'min(92vw, 960px)', marginLeft: 'calc(-1 * min(46vw, 480px))',
        fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
        pointerEvents: 'auto',
      }}>
      {page === 'grid' && <GridPage onClose={handleClose} onExpandBack={expandBack} onExpandForward={expandForward} onGenerate={submitGenerate} />}
      {page === 'progress' && <ProgressPage onClose={handleClose} onMinimize={handleMinimize} onResult={(url, size) => { sResultUrl.value = url; sFileSize.value = size; sPage.value = 'result' }} />}
      {page === 'result' && <ResultPage onClose={handleClose} onBack={() => { sPage.value = 'grid' }} />}
      <Lightbox />
      <CropPopover />
    </div>,
    document.body,
  )
}

// ── App entry ────────────────────────────────────────────────────────────────

function FrameExportModalApp() {
  const feInfo = useAtomValue(_feOpen)
  const minimized = useAtomValue(modalMinimizedAtom)
  if (!feInfo) return null
  return <FrameExportModalInner videoEl={feInfo.videoEl} itemId={feInfo.itemId} minimized={minimized} />
}

export { FrameExportModalApp }
