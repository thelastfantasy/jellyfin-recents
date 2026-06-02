import { useEffect } from 'react'
import { getDefaultStore } from 'jotai'
import { setGesturesSuspended } from './useGestures'
import {
  sPage, sExportType, sPrefetchTotal, sPrefetchDone, sProgressTaskId,
  sLightboxIdx, sSettings, modalPhaseAtom,
  _frames, _itemId, _videoEl, _fpsFrac, _frameIndex,
  _fiMinIdx, _fiMaxIdx, _minPosMs, _maxPosMs,
  _dragController, _domObserver, _modalRoot, _savedState,
  set_frames, set_itemId, set_videoEl, set_fpsFrac, set_frameIndex, set_itemTitle,
  set_fiMinIdx, set_fiMaxIdx, set_minPosMs, set_maxPosMs,
  set_dragController, set_domObserver, set_savedState,
  set_lastClickedIdx, set_dragMode, set_activeTaskId,
  set_suppressNextMousedown, samplePositionsInRange,
} from '../core/state'
import { fetchVideoFps, openFrameInfoStream, openPrefetchStream,
  frameUrl, generateExport,
} from '../api/frameExportApi'
import { fetchItemName } from '../services/screenshot'
import type { components } from '@jfs/api-types'
import { t } from '../lib/i18n'

const jstore = getDefaultStore()

// ── Frame index streaming cleanup ───────────────────────────────────────────

let _abortControllers: AbortController[] = []

function abortAll() {
  for (const c of _abortControllers) c.abort()
  _abortControllers = []
}

function markFrameReady(idx: number): void {
  set_frames(_frames.map((f, i) => i === idx
    ? { ...f, jpegUrl: frameUrl(_itemId, f.fiIdx, f.posMs, 320), loadError: false }
    : f))
}

function fillRemaining(width: number): void {
  set_frames(_frames.map(f => {
    if (f.removed || f.loadError || f.jpegUrl) return f
    return { ...f, jpegUrl: frameUrl(_itemId, f.fiIdx, f.posMs, width) }
  }))
  sPrefetchTotal.value = 0; sPrefetchDone.value = 0
}

type FrameInfoEntry = { ms: number; isKey: boolean; frameIndex: number }

function findCurrentFiIdx(fi: FrameInfoEntry[], currentTimeMs: number): number {
  for (let i = fi.length - 1; i >= 0; i--) {
    if (fi[i].ms <= currentTimeMs) return i
  }
  return 0
}

function findRange(fi: FrameInfoEntry[], centerFiIdx: number): { startFi: number; endFi: number } {
  const centerMs = fi[centerFiIdx].ms
  const startMs = centerMs - 1000
  const endMs = centerMs + 1000
  let startFi = 0
  for (let i = 0; i < fi.length; i++) { if (fi[i].ms >= startMs) { startFi = i; break } }
  let endFi = fi.length - 1
  for (let i = fi.length - 1; i >= 0; i--) { if (fi[i].ms <= endMs) { endFi = i; break } }
  return { startFi, endFi }
}

// ── Range-based prefetch + SSE stream ──────────────────────────────────────

async function prefetchRangeAndStream(
  width: number,
  pendingFiIdx: Set<number>,
): Promise<void> {
  const ac = new AbortController()
  _abortControllers.push(ac)
  return new Promise(resolve => {
    if (pendingFiIdx.size === 0) { resolve(undefined); return }
    const fiIdxArray = Array.from(pendingFiIdx)
    const evSrc = openPrefetchStream(_itemId, width, fiIdxArray)
    sPrefetchTotal.value = pendingFiIdx.size; sPrefetchDone.value = 0
    evSrc.onmessage = (e) => {
      if (ac.signal.aborted) return
      try {
        const data = JSON.parse(e.data)
        if (data.done) { evSrc.close(); fillRemaining(width); resolve(undefined); return }
        const val: number = data.frameReady
        if (typeof val !== 'number') return
        if (!pendingFiIdx.has(val)) return
        pendingFiIdx.delete(val)
        sPrefetchDone.value = sPrefetchTotal.value - pendingFiIdx.size
        const matched = _frames.findIndex(f => f.fiIdx >= 0 && f.fiIdx === val)
        if (matched < 0) { if (pendingFiIdx.size === 0) { evSrc.close(); resolve(undefined) } return }
        const wasSkeleton = jstore.get(modalPhaseAtom) === 'skeleton'
        jstore.set(modalPhaseAtom, 'loading')
        if (wasSkeleton) {
          console.log(
            `%c[frameExport] skeleton dismissed — first cached frame: fiIdx=${val} posMs=${_frames[matched].posMs}ms (${new Date(_frames[matched].posMs).toISOString().substring(11, 23)})`,
            'color: #4ade80; font-weight: bold'
          )
        }
        markFrameReady(matched)
        if (pendingFiIdx.size === 0) { evSrc.close(); resolve(undefined) }
      } catch { /* ignore malformed JSON */ }
    }
    evSrc.onerror = () => { evSrc.close(); fillRemaining(width); resolve(undefined) }
  })
}

// ── Fallback prefetch for when frameIndex is unavailable ───────────────────

async function prefetchFallback(items: Array<{ fiIdx: number; posMs: number }>, width: number): Promise<void> {
  const ac = new AbortController()
  _abortControllers.push(ac)
  const fiIdxArray = items.map(f => f.fiIdx).filter(i => i >= 0)
  return new Promise(resolve => {
    if (fiIdxArray.length === 0) { resolve(undefined); return }
    const evSrc = openPrefetchStream(_itemId, width, fiIdxArray)
    const pending = new Set(items.map(f => f.posMs))
    sPrefetchTotal.value = pending.size; sPrefetchDone.value = 0
    evSrc.onmessage = (e) => {
      if (ac.signal.aborted) return
      let val: number | null = null
      try { const d = JSON.parse(e.data); if (d.done) { evSrc.close(); fillRemaining(width); resolve(undefined); return } val = d.frameReady } catch { return }
      if (val === null) return
      const matched = _frames.findIndex(f => f.fiIdx >= 0 && f.fiIdx === val)
      if (matched < 0) return
      const posMs = _frames[matched].posMs
      if (!pending.delete(posMs)) return
      sPrefetchDone.value = sPrefetchTotal.value - pending.size
      const wasSkeleton = jstore.get(modalPhaseAtom) === 'skeleton'
      jstore.set(modalPhaseAtom, 'loading')
      if (wasSkeleton) {
        console.log(
          `%c[frameExport] skeleton dismissed — first cached frame: fiIdx=${val} posMs=${posMs}ms`,
          'color: #4ade80; font-weight: bold'
        )
      }
      markFrameReady(matched)
      if (pending.size === 0) { evSrc.close(); resolve(undefined) }
    }
    evSrc.onerror = () => { evSrc.close(); fillRemaining(width); resolve(undefined) }
  })
}

// ── Initial frame loading ──────────────────────────────────────────────────

async function loadInitialFrames(): Promise<void> {
  if (!_videoEl) return
  const dur = _videoEl.duration; const durationMs = (isFinite(dur) && dur > 0) ? dur * 1000 : Number.MAX_SAFE_INTEGER
  const centerMs = Math.round(_videoEl.currentTime * 1000)

  abortAll()
  const ac = new AbortController()
  _abortControllers.push(ac)

  const accumulated = new Array<FrameInfoEntry>()
  let startedInitialLoad = false

  return new Promise<void>(resolve => {
    const evSrc = openFrameInfoStream(_itemId, centerMs,
      batch => {
        if (ac.signal.aborted) return
        accumulated.push(...batch)
        if (!startedInitialLoad) {
          startedInitialLoad = true
          startInitialLoad(accumulated, centerMs)
          resolve()
        }
      },
      fps => {
        if (ac.signal.aborted) return
        set_fpsFrac(fps)
        set_frameIndex(accumulated)
        const currentFiIdx = findCurrentFiIdx(accumulated, centerMs)
        const { startFi, endFi } = findRange(accumulated, currentFiIdx)
        set_fiMinIdx(startFi); set_fiMaxIdx(endFi)
        set_minPosMs(accumulated[startFi]?.ms ?? centerMs)
        set_maxPosMs(accumulated[endFi]?.ms ?? centerMs)
      },
      () => {
        if (ac.signal.aborted) return
        if (!startedInitialLoad) {
          fallbackToSampled(centerMs, durationMs)
          resolve()
        }
      }
    )
    void evSrc
  })
}

async function startInitialLoad(
  accumulated: FrameInfoEntry[],
  centerMs: number,
): Promise<void> {
  const currentFiIdx = findCurrentFiIdx(accumulated, centerMs)
  const { startFi, endFi } = findRange(accumulated, currentFiIdx)
  set_fiMinIdx(startFi); set_fiMaxIdx(endFi)
  const slice = accumulated.slice(startFi, endFi + 1)
  set_minPosMs(slice[0]?.ms ?? centerMs); set_maxPosMs(slice[slice.length - 1]?.ms ?? centerMs)
  set_frames(slice.map(f => ({ posMs: f.ms, fiIdx: f.frameIndex, actualPtsMs: f.ms, selected: true, jpegUrl: '', isJunk: false, junkReason: null })))
  set_frames([..._frames])
  const pending = new Set(slice.map(f => f.frameIndex))
  prefetchRangeAndStream(320, pending)
}

function startInitialLoadFromPreloaded(centerMs: number): void {
  const fi = _frameIndex; if (!fi) return
  const currentFiIdx = findCurrentFiIdx(fi, centerMs)
  const { startFi, endFi } = findRange(fi, currentFiIdx)
  set_fiMinIdx(startFi); set_fiMaxIdx(endFi)
  const slice = fi.slice(startFi, endFi + 1)
  set_minPosMs(slice[0]?.ms ?? centerMs); set_maxPosMs(slice[slice.length - 1]?.ms ?? centerMs)
  set_frames(slice.map(f => ({ posMs: f.ms, fiIdx: f.frameIndex, actualPtsMs: f.ms, selected: true, jpegUrl: '', isJunk: false, junkReason: null })))
  set_frames([..._frames])
  const pending = new Set(slice.map(f => f.frameIndex))
  prefetchRangeAndStream(320, pending)
}

async function fallbackToSampled(centerMs: number, durationMs: number): Promise<void> {
  const fps = await fetchVideoFps(_itemId); set_fpsFrac(fps); set_frameIndex(null)
  const startMs = Math.max(0, centerMs - 1000); const endMs = Math.min(durationMs, centerMs + 1000)
  const positions = samplePositionsInRange(startMs, endMs)
  set_minPosMs(positions[0] ?? centerMs); set_maxPosMs(positions[positions.length - 1] ?? centerMs)
  set_frames(positions.map(posMs => ({ posMs, fiIdx: -1, selected: true, jpegUrl: '', isJunk: false, junkReason: null })))
  set_frames([..._frames])
  await prefetchFallback(positions.map(posMs => ({ fiIdx: -1, posMs })), 320)
}

// ── Expand frame range ──────────────────────────────────────────────────────

function expandBack(): void {
  if (!_frameIndex) return
  const n = Math.round(_fpsFrac.num / _fpsFrac.den)
  const start = _fiMinIdx - n; if (start < 0) return
  const slice = _frameIndex.slice(start, _fiMinIdx)
  insertFrames(slice, true, start)
}

function expandForward(): void {
  if (!_frameIndex) return
  const n = Math.round(_fpsFrac.num / _fpsFrac.den)
  const end = _fiMaxIdx + n; if (end >= _frameIndex.length) return
  const slice = _frameIndex.slice(_fiMaxIdx + 1, end + 1)
  insertFrames(slice, false, _fiMaxIdx + 1)
}

function insertFrames(
  slice: FrameInfoEntry[],
  prepend: boolean,
  firstIdx: number,
): void {
  const fi = _frameIndex!
  const entries = slice.map(f => ({ posMs: f.ms, fiIdx: f.frameIndex, selected: true, jpegUrl: '', isJunk: false, junkReason: null }))
  set_frames(prepend ? [...entries, ..._frames] : [..._frames, ...entries])
  if (prepend) { set_fiMinIdx(firstIdx); set_minPosMs(fi[firstIdx].ms) }
  else { set_fiMaxIdx(firstIdx + slice.length - 1); set_maxPosMs(fi[firstIdx + slice.length - 1].ms) }
  set_frames([..._frames])
  openPrefetchStream(_itemId, 320, slice.map(f => f.frameIndex))
}

// ── Submit generate request ─────────────────────────────────────────────────

async function submitGenerate(): Promise<void> {
  const exportType = sExportType.value; const st = sSettings.value
  const allSelected = _frames.filter(f => f.selected && !f.removed && !f.skeleton)
  const seenKey = new Set<number>()
  const selected = allSelected.filter(f => { const key = f.fiIdx; if (seenKey.has(key)) return false; seenKey.add(key); return true })
  if (selected.length < 2) { alert(t('export.minFrames')); return }
  if (selected.length > 240 && !confirm(t('export.largeWarning').replace('{n}', String(selected.length)))) return
  const format = exportType === 'animate' ? st.animateFormat : st.stitchFormat
  const itemName = await fetchItemName(_itemId)
  const title = (itemName ?? document.title.replace(/\s*[-|]\s*Jellyfin\s*$/i, '').trim()) || 'export'
  const body: components['schemas']['GenerateRequest'] = {
    itemId: _itemId, itemTitle: title, type: exportType,
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

// ── Hook: modal lifecycle ──────────────────────────────────────────────────

export function useFrameExport(videoEl: HTMLVideoElement, itemId: string) {
  useEffect(() => {
    set_videoEl(videoEl)
    if (itemId !== _itemId) { set_frameIndex(null); set_fpsFrac({ num: 24, den: 1 }); abortAll() }
    set_itemId(itemId)
    set_activeTaskId('')
    fetchItemName(itemId).then(name => { if (name) set_itemTitle(name) })
    videoEl.pause()
    document.body.classList.add('jfs-fe-open')
    setGesturesSuspended(true)

    const currentMs = Math.round(videoEl.currentTime * 1000)
    if (_savedState && _savedState.itemId === itemId && currentMs >= _savedState.minPosMs && currentMs <= _savedState.maxPosMs) {
      abortAll()
      set_frames(_savedState.frames.map(f => ({ ...f })))
      sExportType.value = _savedState.exportType
      set_minPosMs(_savedState.minPosMs); set_maxPosMs(_savedState.maxPosMs)
      set_fpsFrac(_savedState.fpsFrac); set_lastClickedIdx(_savedState.lastClickedIdx)
      set_fiMinIdx(_savedState.fiMinIdx); set_fiMaxIdx(_savedState.fiMaxIdx)
      sPrefetchTotal.value = 0; sPrefetchDone.value = 0
      sPage.value = 'grid'; sLightboxIdx.value = null
      set_frames([..._frames])
      for (let i = 0; i < _frames.length; i++) {
        if (_frames[i].jpegUrl) { _frames[i].loadError = false }
      }
      set_frames([..._frames])
      return
    }

    // ── Preloaded frameIndex → skip skeleton, show frames instantly ──────────
    if (_frameIndex && _frameIndex.length > 0) {
      sPage.value = 'grid'; sLightboxIdx.value = null
      startInitialLoadFromPreloaded(currentMs)
      return () => {
        if (_itemId && _frames.length > 0) {
          set_savedState({
            itemId: _itemId, frames: _frames.map(f => ({ ...f })),
            exportType: sExportType.value, minPosMs: _minPosMs, maxPosMs: _maxPosMs,
            fpsFrac: { ..._fpsFrac }, lastClickedIdx: -1, fiMinIdx: _fiMinIdx, fiMaxIdx: _fiMaxIdx,
          })
        }
        _dragController?.abort(); set_dragController(null)
        _domObserver?.disconnect(); set_domObserver(null)
        abortAll()
        set_lastClickedIdx(-1); set_dragMode(false); set_suppressNextMousedown(false)
      }
    }

    // ── No preload → skeleton + async loading ────────────────────────────────
    set_frames([]); sPage.value = 'grid'; sLightboxIdx.value = null
    const fpsNum = _fpsFrac.num > 0 ? _fpsFrac.num : 24
    const fpsDen = _fpsFrac.den > 0 ? _fpsFrac.den : 1
    const count = Math.round(2000 / 1000 * fpsNum / fpsDen)
    set_frames(Array.from({ length: count }, (_, i) => ({
      posMs: Math.round(currentMs - 1000 + i * fpsDen * 1000 / fpsNum),
      fiIdx: -1, selected: true, jpegUrl: '', isJunk: false, junkReason: null, skeleton: true,
    })))
    set_frames([..._frames]); loadInitialFrames()

    return () => {
      if (_itemId && _frames.length > 0) {
        set_savedState({
          itemId: _itemId, frames: _frames.map(f => ({ ...f })),
          exportType: sExportType.value, minPosMs: _minPosMs, maxPosMs: _maxPosMs,
          fpsFrac: { ..._fpsFrac }, lastClickedIdx: -1, fiMinIdx: _fiMinIdx, fiMaxIdx: _fiMaxIdx,
        })
      }
      _dragController?.abort(); set_dragController(null)
      _domObserver?.disconnect(); set_domObserver(null)
      abortAll()
      set_lastClickedIdx(-1); set_dragMode(false); set_suppressNextMousedown(false)
    }
  }, [videoEl, itemId])

  return { loadInitialFrames, expandBack, expandForward, submitGenerate }
}
