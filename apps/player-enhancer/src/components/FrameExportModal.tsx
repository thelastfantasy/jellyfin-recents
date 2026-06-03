import { useRef, useEffect, useCallback, useState } from 'react'
import { createPortal } from 'react-dom'
import { getDefaultStore, useAtomValue, useSetAtom } from 'jotai'
import { useQuery, useMutation } from '@tanstack/react-query'
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
import { frameUrl, generateExportMutation } from '../api/frameExportApi'
import { frameInfoStreamer, prefetchStreamer } from '../api/streamers'
import { itemNameQuery } from '../api/jellyfinApi'
import { t } from '../lib/i18n'
import { GridPage }     from './GridPage'
import { ProgressPage } from './ProgressPage'
import { ResultPage }   from './ResultPage'
import { Lightbox }     from './Lightbox'
import { CropPopover }  from './CropPopover'

const jstore = getDefaultStore()

// ── Helpers ───────────────────────────────────────────────────────────────────

const MODAL_BODY_CLASS = 'jfs-fe-open'

function setBodyModalOpen(open: boolean) {
  if (open) document.body.classList.add(MODAL_BODY_CLASS)
  else document.body.classList.remove(MODAL_BODY_CLASS)
}

type FrameInfoEntry = { ms: number; isKey: boolean; frameIndex: number }
type StreamItem = FrameInfoEntry | { fps: { num: number; den: number } }

function findCenterFrameIndex(frames: FrameInfoEntry[], currentMs: number): number {
  for (let i = frames.length - 1; i >= 0; i--) if (frames[i].ms <= currentMs) return i
  return 0
}

function findRangeFromCenter(frames: FrameInfoEntry[], centerIndex: number): [number, number] {
  const startMs = frames[centerIndex].ms - 1000; const endMs = frames[centerIndex].ms + 1000
  let rangeStart = 0
  for (let i = 0; i < frames.length; i++) if (frames[i].ms >= startMs) { rangeStart = i; break }
  let rangeEnd = frames.length - 1
  for (let i = frames.length - 1; i >= 0; i--) if (frames[i].ms <= endMs) { rangeEnd = i; break }
  return [rangeStart, rangeEnd]
}

function framesPerSecond(): number {
  return Math.round(_fpsFrac.num / _fpsFrac.den)
}

// ── Inner modal ───────────────────────────────────────────────────────────────

function FrameExportModalInner({ videoEl, itemId, minimized }: {
  videoEl: HTMLVideoElement; itemId: string; minimized: boolean
}) {
  const closeModal = useSetAtom(_feOpen)
  const rootRef = useRef<HTMLDivElement>(null)
  const page = useAtomValue(pageAtom)
  const playbackMs = Math.round(videoEl.currentTime * 1000)

  // ── FrameInfo stream ────────────────────────────────────────────────────────

  const frameInfoQuery = useQuery({
    queryKey: ['frameInfo', itemId, playbackMs] as const,
    queryFn: streamedQuery<StreamItem>({
      streamFn: () => frameInfoStreamer(itemId, playbackMs),
      refetchMode: 'append',
    }),
    staleTime: Infinity,
  })

  const streamItems = frameInfoQuery.data as StreamItem[] | undefined
  const frameEntries = (streamItems?.filter((d): d is FrameInfoEntry => 'ms' in d) ?? []) as FrameInfoEntry[]
  const fpsInfo = streamItems?.find((d): d is { fps: { num: number; den: number } } => 'fps' in d) as { fps: { num: number; den: number } } | undefined

  useEffect(() => {
    if (fpsInfo) { setFpsFrac(fpsInfo.fps); setFrameIndex(frameEntries) }
  }, [fpsInfo])

  useEffect(() => {
    if (frameEntries.length > 0 && !_frames.length) {
      const centerIndex = findCenterFrameIndex(frameEntries, playbackMs)
      const [rangeStart, rangeEnd] = findRangeFromCenter(frameEntries, centerIndex)
      applyFrameRange(frameEntries, playbackMs, rangeStart, rangeEnd)
      triggerPrefetch()
    }
  }, [frameEntries.length])

  // ── Prefetch ────────────────────────────────────────────────────────────────

  const [prefetchTrigger, setPrefetchTrigger] = useState<string | null>(null)

  const prefetchQuery = useQuery({
    queryKey: ['prefetch', itemId, prefetchTrigger ?? ''] as const,
    queryFn: streamedQuery<number>({
      streamFn: () => prefetchStreamer(itemId, 320, _frames.map(f => f.fiIdx).filter(i => i >= 0)),
      refetchMode: 'append',
    }),
    staleTime: Infinity,
    enabled: prefetchTrigger !== null,
  })

  const prefetchResults = prefetchQuery.data as number[] | undefined
  useEffect(() => {
    if (!prefetchResults) return
    prefetchResults.forEach(fi => {
      const idx = _frames.findIndex(f => f.fiIdx === fi)
      if (idx >= 0) markFrameReady(idx)
    })
  }, [prefetchResults])

  function triggerPrefetch() { setPrefetchTrigger(String(Date.now())) }

  // ── Frame helpers ───────────────────────────────────────────────────────────

  function makeEntry(f: FrameInfoEntry): FrameEntry {
    return { posMs: f.ms, fiIdx: f.frameIndex, selected: true, jpegUrl: '', isJunk: false, junkReason: null }
  }

  function applyFrameRange(frames: FrameInfoEntry[], center: number, start: number, end: number) {
    setFiMinIdx(start); setFiMaxIdx(end)
    const slice = frames.slice(start, end + 1)
    setMinPosMs(slice[0]?.ms ?? center); setMaxPosMs(slice[slice.length - 1]?.ms ?? center)
    setFrames(slice.map(makeEntry))
  }

  function markFrameReady(idx: number) {
    setFrames(_frames.map((f, i) => i === idx
      ? { ...f, jpegUrl: frameUrl(_itemId, f.fiIdx, f.posMs, 320), loadError: false }
      : f))
  }

  // ── Expand ──────────────────────────────────────────────────────────────────

  const expandBack = useCallback(() => {
    if (!_frameIndex) return
    const step = framesPerSecond(), start = _fiMinIdx - step
    if (start < 0) return
    const entries = _frameIndex.slice(start, _fiMinIdx).map(makeEntry)
    setFrames([...entries, ..._frames])
    setFiMinIdx(start); setMinPosMs(_frameIndex[start].ms)
    triggerPrefetch()
  }, [])

  const expandForward = useCallback(() => {
    if (!_frameIndex) return
    const step = framesPerSecond(), end = _fiMaxIdx + step
    if (end >= _frameIndex.length) return
    const entries = _frameIndex.slice(_fiMaxIdx + 1, end + 1).map(makeEntry)
    setFrames([..._frames, ...entries])
    setFiMaxIdx(end); setMaxPosMs(_frameIndex[end].ms)
    triggerPrefetch()
  }, [])

  // ── Submit ──────────────────────────────────────────────────────────────────

  const generateMutation = useMutation(generateExportMutation())

  const submitGenerate = useCallback(() => {
    const exportType = sExportType.value; const settings = sSettings.value
    const selected = _frames.filter(f => f.selected && !f.removed && !f.skeleton)
    if (selected.length > 240 && !confirm(t('export.largeWarning').replace('{n}', String(selected.length)))) return
    const format = exportType === 'animate' ? settings.animateFormat : settings.stitchFormat
    const body = {
      itemId: _itemId, itemTitle: '', type: exportType,
      frames: selected.map(f => f.fiIdx >= 0 ? { frameIdx: f.fiIdx } : { positionMs: Math.round(f.posMs) }),
      params: {
        format, resizeMode: settings.width.mode === 'userInput' ? 'width' : 'height',
        customWidth: settings.width.value || null, customHeight: settings.height.value || null,
        resolutionPreset: settings.resolutionPreset, speed: settings.speed, loopCount: settings.loopCount,
        cropX: settings.cropRect?.x ?? 0, cropY: settings.cropRect?.y ?? 0,
        cropW: settings.cropRect?.w ?? 0, cropH: settings.cropRect?.h ?? 0,
        quality: exportType === 'animate' ? settings.animateQuality : settings.stitchQuality,
      },
    }
    generateMutation.mutate(body, {
      onSuccess: (taskId) => { sProgressTaskId.value = taskId; sPage.value = 'progress' },
      onError: (e) => { alert(t('export.failed').replace('{msg}', e instanceof Error ? e.message : String(e))) },
    })
  }, [generateMutation])

  // ── Close / minimize ────────────────────────────────────────────────────────

  const handleClose = useCallback(() => {
    setGesturesSuspended(false); setBodyModalOpen(false)
    sLightboxIdx.value = null; sModalPhase.value = 'skeleton'
    setLastClickedIdx(-1); setDragMode(false); setSuppressNextMousedown(false)
    if (_itemId && _frames.length > 0) saveState()
    closeModal(null)
  }, [])

  const handleMinimize = useCallback(() => {
    setGesturesSuspended(false); setBodyModalOpen(false)
    jstore.set(modalMinimizedAtom, true)
    if (_itemId && _frames.length > 0) saveState()
  }, [])

  function saveState() {
    setSavedState({
      itemId: _itemId, frames: _frames.map(f => ({ ...f })), exportType: sExportType.value,
      minPosMs: _minPosMs, maxPosMs: _maxPosMs, fpsFrac: { ..._fpsFrac },
      lastClickedIdx: -1, fiMinIdx: _fiMinIdx, fiMaxIdx: _fiMaxIdx,
    })
  }

  // ── Keyboard ────────────────────────────────────────────────────────────────

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'Escape') return; e.stopPropagation()
    if (sLightboxIdx.value !== null) sLightboxIdx.value = null
    else handleClose()
  }, [])

  // ── Item name ───────────────────────────────────────────────────────────────

  const { data: fetchedName } = useQuery(itemNameQuery(itemId))
  useEffect(() => { if (fetchedName) setItemTitle(fetchedName) }, [fetchedName])

  // ── Lifecycle: side effects ──────────────────────────────────────────────────

  useEffect(() => {
    setVideoEl(videoEl); setItemId(itemId); setActiveTaskId('')
    if (itemId !== _itemId) { setFrameIndex(null); setFpsFrac({ num: 24, den: 1 }) }
    videoEl.pause()
    setBodyModalOpen(true)
    setGesturesSuspended(true)
  }, [videoEl, itemId])

  // ── Lifecycle: frame initialization ─────────────────────────────────────────

  useEffect(() => {
    if (_savedState && _savedState.itemId === itemId && playbackMs >= _savedState.minPosMs && playbackMs <= _savedState.maxPosMs) {
      setFrames(_savedState.frames.map(f => ({ ...f })))
      sExportType.value = _savedState.exportType
      setMinPosMs(_savedState.minPosMs); setMaxPosMs(_savedState.maxPosMs)
      setFpsFrac(_savedState.fpsFrac); setLastClickedIdx(_savedState.lastClickedIdx)
      setFiMinIdx(_savedState.fiMinIdx); setFiMaxIdx(_savedState.fiMaxIdx)
      sPrefetchTotal.value = 0; sPrefetchDone.value = 0
      sPage.value = 'grid'; sLightboxIdx.value = null
      return
    }

    if (_frameIndex && _frameIndex.length > 0) {
      const centerIndex = findCenterFrameIndex(_frameIndex, playbackMs)
      const [rangeStart, rangeEnd] = findRangeFromCenter(_frameIndex, centerIndex)
      sPage.value = 'grid'; sLightboxIdx.value = null
      applyFrameRange(_frameIndex, playbackMs, rangeStart, rangeEnd)
      triggerPrefetch()
      return
    }

    setFrames([]); sPage.value = 'grid'; sLightboxIdx.value = null
    const skeletonCount = Math.round(2000 / 1000 * (_fpsFrac.num || 24) / (_fpsFrac.den || 1))
    setFrames(Array.from({ length: skeletonCount }, (_, i) => ({
      posMs: Math.round(playbackMs - 1000 + i * (_fpsFrac.den || 1) * 1000 / (_fpsFrac.num || 24)),
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
  const modalInfo = useAtomValue(_feOpen)
  const minimized = useAtomValue(modalMinimizedAtom)
  if (!modalInfo) return null
  return <FrameExportModalInner videoEl={modalInfo.videoEl} itemId={modalInfo.itemId} minimized={minimized} />
}

export { FrameExportModalApp }
