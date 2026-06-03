import { useRef, useEffect, useCallback, useState } from 'react'
import { createPortal } from 'react-dom'
import { getDefaultStore, useAtomValue, useSetAtom } from 'jotai'
import { useQuery } from '@tanstack/react-query'
import { experimental_streamedQuery as streamedQuery } from '@tanstack/react-query'
import { setGesturesSuspended } from '../hooks/useGestures'
import {
  sPage, sResultUrl, sFileSize, sLightboxIdx, sModalPhase,
  sPrefetchTotal, sPrefetchDone, sExportType, sSettings, sProgressTaskId,
  pageAtom, modalMinimizedAtom, _feOpen,
  _frames, _itemId, _videoEl, _fpsFrac, _frameIndex,
  _fiMinIdx, _fiMaxIdx, _minPosMs, _maxPosMs, _savedState,
  setFrames, setItemId, setVideoEl, setFpsFrac, setFrameIndex, setItemTitle,
  setFiMinIdx, setFiMaxIdx, setMinPosMs, setMaxPosMs,
  setSavedState, setLastClickedIdx, setDragMode, setActiveTaskId,
  setSuppressNextMousedown, FrameEntry,
} from '../core/state'
import { frameUrl, generateExport } from '../api/frameExportApi'
import { frameInfoStreamer, prefetchStreamer } from '../api/streamers'
import { fetchItemName } from '../api/jellyfinApi'
import type { components } from '@jfs/api-types'
import { t } from '../lib/i18n'
import { GridPage }     from './GridPage'
import { ProgressPage } from './ProgressPage'
import { ResultPage }   from './ResultPage'
import { Lightbox }     from './Lightbox'
import { CropPopover }  from './CropPopover'

const jstore = getDefaultStore()

type FiEntry = { ms: number; isKey: boolean; frameIndex: number }
type FiStreamItem = FiEntry | { fps: { num: number; den: number } }

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

// ── Inner modal ───────────────────────────────────────────────────────────────

function FrameExportModalInner({ videoEl, itemId, minimized }: {
  videoEl: HTMLVideoElement; itemId: string; minimized: boolean
}) {
  const setFE = useSetAtom(_feOpen)
  const rootRef = useRef<HTMLDivElement>(null)
  const page = useAtomValue(pageAtom)
  const centerMs = Math.round(videoEl.currentTime * 1000)

  // ── FrameInfo stream (SSE → tanstack-query) ────────────────────────────────

  const fiQuery = useQuery({
    queryKey: ['frameInfo', itemId, centerMs] as const,
    queryFn: streamedQuery<FiStreamItem>({
      streamFn: () => frameInfoStreamer(itemId, centerMs),
      refetchMode: 'append',
    }),
    staleTime: Infinity,
  })

  const fiData = fiQuery.data as FiStreamItem[] | undefined
  const fiEntries = (fiData?.filter((d): d is FiEntry => 'ms' in d) ?? []) as FiEntry[]
  const fpsMeta = fiData?.find((d): d is { fps: { num: number; den: number } } => 'fps' in d) as { fps: { num: number; den: number } } | undefined

  useEffect(() => {
    if (fpsMeta) {
      setFpsFrac(fpsMeta.fps)
      setFrameIndex(fiEntries)
    }
  }, [fpsMeta])

  useEffect(() => {
    if (fiEntries.length > 0 && !_frames.length) {
      const c = lastFiIdx(fiEntries, centerMs)
      const [a, b] = sliceRange(fiEntries, c)
      setRangeAndFrames(fiEntries, centerMs, a, b)
      triggerPrefetch()
    }
  }, [fiEntries.length])

  // ── Prefetch ────────────────────────────────────────────────────────────────

  const [prefetchKey, setPrefetchKey] = useState<string | null>(null)

  const pfQuery = useQuery({
    queryKey: ['prefetch', itemId, prefetchKey ?? ''] as const,
    queryFn: streamedQuery<number>({
      streamFn: () => prefetchStreamer(itemId, 320, _frames.map(f => f.fiIdx).filter(i => i >= 0)),
      refetchMode: 'append',
    }),
    staleTime: Infinity,
    enabled: prefetchKey !== null,
  })

  const pfData = pfQuery.data as number[] | undefined
  useEffect(() => {
    if (!pfData) return
    pfData.forEach(fi => {
      const i = _frames.findIndex(f => f.fiIdx === fi)
      if (i >= 0) markReady(i)
    })
  }, [pfData])

  function triggerPrefetch() {
    setPrefetchKey(String(Date.now()))
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function setRangeAndFrames(fi: FiEntry[], center: number, start: number, end: number) {
    setFiMinIdx(start); setFiMaxIdx(end)
    const slice = fi.slice(start, end + 1)
    setMinPosMs(slice[0]?.ms ?? center); setMaxPosMs(slice[slice.length - 1]?.ms ?? center)
    setFrames(slice.map(f => ({ posMs: f.ms, fiIdx: f.frameIndex, selected: true, jpegUrl: '', isJunk: false, junkReason: null } as FrameEntry)))
  }

  function markReady(idx: number) {
    setFrames(_frames.map((f, i) => i === idx
      ? { ...f, jpegUrl: frameUrl(_itemId, f.fiIdx, f.posMs, 320), loadError: false }
      : f))
  }

  // ── Expand ──────────────────────────────────────────────────────────────────

  const expandBack = useCallback(() => {
    if (!_frameIndex) return
    const n = Math.round(_fpsFrac.num / _fpsFrac.den); const a = _fiMinIdx - n
    if (a < 0) return
    const slice = _frameIndex.slice(a, _fiMinIdx)
    const ents = slice.map(f => ({ posMs: f.ms, fiIdx: f.frameIndex, selected: true, jpegUrl: '', isJunk: false, junkReason: null } as FrameEntry))
    setFrames([...ents, ..._frames]); setFiMinIdx(a); setMinPosMs(_frameIndex[a].ms)
    setFrames([..._frames])
    triggerPrefetch()
  }, [])

  const expandForward = useCallback(() => {
    if (!_frameIndex) return
    const n = Math.round(_fpsFrac.num / _fpsFrac.den); const b = _fiMaxIdx + n
    if (b >= _frameIndex.length) return
    const slice = _frameIndex.slice(_fiMaxIdx + 1, b + 1)
    const ents = slice.map(f => ({ posMs: f.ms, fiIdx: f.frameIndex, selected: true, jpegUrl: '', isJunk: false, junkReason: null } as FrameEntry))
    setFrames([..._frames, ...ents]); setFiMaxIdx(b); setMaxPosMs(_frameIndex[b].ms)
    setFrames([..._frames])
    triggerPrefetch()
  }, [])

  // ── Submit ──────────────────────────────────────────────────────────────────

  const submitGenerate = useCallback(async () => {
    const ex = sExportType.value; const st = sSettings.value
    const sel = _frames.filter(f => f.selected && !f.removed && !f.skeleton)
    const uniq = sel.filter((f, i) => sel.findIndex(x => x.fiIdx === f.fiIdx) === i)
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
    try { const tid = await generateExport(body); sProgressTaskId.value = tid; sPage.value = 'progress' }
    catch (e) { alert(t('export.failed').replace('{msg}', e instanceof Error ? e.message : String(e))) }
  }, [])

  // ── Close / minimize ────────────────────────────────────────────────────────

  const handleClose = useCallback(() => {
    setGesturesSuspended(false); document.body.classList.remove('jfs-fe-open')
    sLightboxIdx.value = null; sModalPhase.value = 'skeleton'
    setLastClickedIdx(-1); setDragMode(false); setSuppressNextMousedown(false)
    if (_itemId && _frames.length > 0) setSavedState({
      itemId: _itemId, frames: _frames.map(f => ({ ...f })), exportType: sExportType.value,
      minPosMs: _minPosMs, maxPosMs: _maxPosMs, fpsFrac: { ..._fpsFrac },
      lastClickedIdx: -1, fiMinIdx: _fiMinIdx, fiMaxIdx: _fiMaxIdx,
    })
    setFE(null)
  }, [])

  const handleMinimize = useCallback(() => {
    setGesturesSuspended(false); document.body.classList.remove('jfs-fe-open')
    jstore.set(modalMinimizedAtom, true)
    if (_itemId && _frames.length > 0) setSavedState({
      itemId: _itemId, frames: _frames.map(f => ({ ...f })), exportType: sExportType.value,
      minPosMs: _minPosMs, maxPosMs: _maxPosMs, fpsFrac: { ..._fpsFrac },
      lastClickedIdx: -1, fiMinIdx: _fiMinIdx, fiMaxIdx: _fiMaxIdx,
    })
  }, [])

  // ── Keyboard ────────────────────────────────────────────────────────────────

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'Escape') return; e.stopPropagation()
    if (sLightboxIdx.value !== null) sLightboxIdx.value = null
    else handleClose()
  }, [])

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  useEffect(() => {
    setVideoEl(videoEl)
    if (itemId !== _itemId) { setFrameIndex(null); setFpsFrac({ num: 24, den: 1 }) }
    setItemId(itemId); setActiveTaskId('')
    fetchItemName(itemId).then((n: string | null) => { if (n) setItemTitle(n) })
    videoEl.pause()
    document.body.classList.add('jfs-fe-open')
    setGesturesSuspended(true)

    // saved state
    if (_savedState && _savedState.itemId === itemId && centerMs >= _savedState.minPosMs && centerMs <= _savedState.maxPosMs) {
      setFrames(_savedState.frames.map(f => ({ ...f })))
      sExportType.value = _savedState.exportType
      setMinPosMs(_savedState.minPosMs); setMaxPosMs(_savedState.maxPosMs)
      setFpsFrac(_savedState.fpsFrac); setLastClickedIdx(_savedState.lastClickedIdx)
      setFiMinIdx(_savedState.fiMinIdx); setFiMaxIdx(_savedState.fiMaxIdx)
      sPrefetchTotal.value = 0; sPrefetchDone.value = 0
      sPage.value = 'grid'; sLightboxIdx.value = null
      return
    }

    // preloaded
    if (_frameIndex && _frameIndex.length > 0) {
      const c = lastFiIdx(_frameIndex, centerMs)
      const [a, b] = sliceRange(_frameIndex, c)
      sPage.value = 'grid'; sLightboxIdx.value = null
      setRangeAndFrames(_frameIndex, centerMs, a, b)
      triggerPrefetch()
      return
    }

    // skeleton fallback
    setFrames([]); sPage.value = 'grid'; sLightboxIdx.value = null
    const n = Math.round(2000 / 1000 * (_fpsFrac.num || 24) / (_fpsFrac.den || 1))
    setFrames(Array.from({ length: n }, (_, i) => ({
      posMs: Math.round(centerMs - 1000 + i * (_fpsFrac.den || 1) * 1000 / (_fpsFrac.num || 24)),
      fiIdx: -1, selected: true, jpegUrl: '', isJunk: false, junkReason: null, skeleton: true,
    } as FrameEntry)))
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

function FrameExportModalApp() {
  const feInfo = useAtomValue(_feOpen)
  const minimized = useAtomValue(modalMinimizedAtom)
  if (!feInfo) return null
  return <FrameExportModalInner videoEl={feInfo.videoEl} itemId={feInfo.itemId} minimized={minimized} />
}

export { FrameExportModalApp }
