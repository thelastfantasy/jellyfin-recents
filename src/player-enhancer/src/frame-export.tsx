// ── Frame Export OSD Panel — Grid (US1-3), Progress (US7), Result (US7) ──
// Preact migration of frame-export.ts

import { render } from 'preact'
import { signal } from '@preact/signals'
import { useState, useEffect, useRef } from 'preact/hooks'
import { setGesturesSuspended } from './gestures'
import { t } from './i18n'
import type { components } from './jellyfin-api'
import type { TaskProgressEvent } from './api-types'

type GenerateResponse = components['schemas']['GenerateResponse']

// ── Signals (module-level reactive state) ────────────────────────────────────
const sPage = signal<'grid' | 'progress' | 'result'>('grid')
const sFrames = signal<FrameEntry[]>([])
const sExportType = signal<'animate' | 'stitch'>('animate')
const sParamsOpen = signal(false)
const sPrefetchTotal = signal(0)
const sPrefetchDone = signal(0)
const sSettings = signal<ExportSettings>(loadSettingsOnce())
const sProgressTaskId = signal('')
const sResultUrl = signal('')
const sFileSize = signal(0)

// ── Non-reactive module state ────────────────────────────────────────────────
let _modalRoot: HTMLDivElement | null = null
let _dragController: AbortController | null = null
let _domObserver: MutationObserver | null = null
let _videoEl: HTMLVideoElement | null = null
let _itemId = ''
let _activeTaskId = ''

// State
let _frames: FrameEntry[] = []
let _minPosMs = 0
let _maxPosMs = 0
interface FpsFrac { num: number; den: number }
let _fpsFrac: FpsFrac = { num: 24, den: 1 }
let _lastClickedIdx = -1
let _dragMode = false
let _dragSelectValue = false
let _longPressTimer: ReturnType<typeof setTimeout> | null = null
let _longPressCard: HTMLElement | null = null
let _suppressNextMousedown = false
let _autoScrollRaf: number | null = null
let _lastTouchX = 0
let _lastTouchY = 0

// Frame index from Rust daemon (exact frame timestamps, demux-only)
let _frameIndex: Array<{ms: number; isKey: boolean}> | null = null
let _fiMinIdx = 0   // first visible frame in _frameIndex
let _fiMaxIdx = -1  // last visible frame in _frameIndex

// Cached state for modal restore (survives close/reopen if same item + position)
interface SavedModalState {
  itemId: string
  frames: FrameEntry[]
  exportType: 'animate' | 'stitch'
  minPosMs: number
  maxPosMs: number
  fpsFrac: FpsFrac
  lastClickedIdx: number
  fiMinIdx: number
  fiMaxIdx: number
}
let _savedState: SavedModalState | null = null

// ── Settings (localStorage) ──────────────────────────────────────────────────
interface CropRect { x: number; y: number; w: number; h: number }

interface ExportSettings {
  animateFormat: 'gif' | 'webp'
  stitchFormat: 'png' | 'webp'
  resizeMode: 'width' | 'height'
  customWidth: number
  customHeight: number
  resolutionPreset: string
  useCustomResolution: boolean
  speed: number
  loopCount: number
  cropRect: CropRect | null
  animateQuality: number
  stitchQuality: number
}

const DEFAULT_SETTINGS: ExportSettings = {
  animateFormat: 'gif',
  stitchFormat: 'png',
  resizeMode: 'width',
  customWidth: 0,
  customHeight: 0,
  resolutionPreset: 'original',
  useCustomResolution: false,
  speed: 1.0,
  loopCount: 0,
  cropRect: null,
  animateQuality: 0.75,
  stitchQuality: 0.75,
}

interface FrameEntry {
  posMs: number
  selected: boolean
  jpegUrl: string
  isJunk: boolean
  junkReason: string | null
  loadError?: boolean
  removed?: boolean
  actualPtsMs?: number   // normalized frame start time from X-Frame-Pts-Ms header
  blobUrl?: string       // browser blob URL (not persisted in savedState)
}

function loadSettingsOnce(): ExportSettings {
  try {
    const raw = localStorage.getItem('jfs-frameexport-settings')
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch { /* ignore */ }
  return { ...DEFAULT_SETTINGS }
}

function saveSettings(s: ExportSettings): void {
  try { localStorage.setItem('jfs-frameexport-settings', JSON.stringify(s)) } catch { /* ignore */ }
}

function updateSettings(patch: Partial<ExportSettings>): void {
  const next = { ...sSettings.value, ...patch }
  saveSettings(next)
  sSettings.value = next
}

// ── Utilities ────────────────────────────────────────────────────────────────

function getBaseUrl(): string {
  const ac = (window as any).ApiClient
  return ac?.serverAddress?.() ?? ac?._serverAddress ?? ''
}

function getToken(): string {
  const ac = (window as any).ApiClient
  return (typeof ac?.accessToken === 'function' ? ac.accessToken() : ac?._accessToken) ?? ''
}

function frameUrl(posMs: number, width: number): string {
  const base = getBaseUrl()
  const token = getToken()
  return `${base}/JellyfinSuite/FrameExport/${_itemId}?positionMs=${Math.round(posMs)}&width=${width}&api_key=${encodeURIComponent(token)}`
}

function formatTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  const frac = String(Math.round(ms % 1000)).padStart(3, '0')
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${frac}`
}

function snapFpsToRational(fps: number): FpsFrac {
  const table: Array<[number, number, number]> = [
    [23.976, 24000, 1001], [24, 24, 1], [25, 25, 1],
    [29.97, 30000, 1001], [30, 30, 1],
    [47.952, 48000, 1001], [48, 48, 1],
    [50, 50, 1],
    [59.94, 60000, 1001], [60, 60, 1],
    [119.88, 120000, 1001], [120, 120, 1],
  ]
  for (const [f, n, d] of table) {
    if (Math.abs(fps - f) < 0.05) return { num: n, den: d }
  }
  return { num: Math.round(fps * 1000), den: 1000 }
}

async function fetchVideoFps(): Promise<FpsFrac> {
  try {
    const res = await fetch(
      `${getBaseUrl()}/Items/${_itemId}?Fields=MediaStreams&api_key=${encodeURIComponent(getToken())}`
    )
    if (!res.ok) return { num: 24, den: 1 }
    const data = await res.json() as {
      MediaStreams?: Array<{ Type?: string; RealFrameRate?: number; AverageFrameRate?: number }>
    }
    const vid = data.MediaStreams?.find(s => s.Type === 'Video')
    const fps = vid?.RealFrameRate ?? vid?.AverageFrameRate ?? 24
    return snapFpsToRational(fps)
  } catch {
    return { num: 24, den: 1 }
  }
}

async function fetchFrameIndex(): Promise<boolean> {
  try {
    const res = await fetch(
      `${getBaseUrl()}/JellyfinSuite/SeekPreview/${_itemId}/frame-index?api_key=${encodeURIComponent(getToken())}`
    )
    if (!res.ok) return false
    const data = await res.json() as { frames: Array<{ms: number; isKey: boolean}>; fps: {num: number; den: number} }
    if (data.fps.num > 0 && data.fps.den > 0) {
      _fpsFrac = { num: Number(data.fps.num), den: Number(data.fps.den) }
    }
    _frameIndex = data.frames
    return data.frames.length > 0
  } catch {
    return false
  }
}

function frameInterval(): number {
  return _fpsFrac.den * 1000 / _fpsFrac.num
}

function frameToMs(idx: number): number {
  // ceil ensures posMs >= actual frame timestamp so FFmpeg seek lands on the correct frame
  return Math.ceil(idx * _fpsFrac.den * 1000 / _fpsFrac.num)
}

function msToFrameIdx(ms: number): number {
  return Math.round(ms * _fpsFrac.num / (_fpsFrac.den * 1000))
}

function samplePositionsInRange(startMs: number, endMs: number): number[] {
  const startIdx = Math.ceil(startMs * _fpsFrac.num / (_fpsFrac.den * 1000))
  const endIdx   = Math.floor(endMs   * _fpsFrac.num / (_fpsFrac.den * 1000))
  const positions: number[] = []
  for (let i = startIdx; i <= endIdx; i++) {
    positions.push(frameToMs(i))
  }
  return positions
}

// ── renderGrid: update signal to trigger re-render ───────────────────────────
function renderGrid(): void {
  _frames = [..._frames]
  sFrames.value = _frames
}

// ── escHandler ───────────────────────────────────────────────────────────────
function escHandler(e: KeyboardEvent): void {
  e.stopPropagation()
  if (e.key === 'Escape') closeModal()
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
    el.style.bottom = ''
    el.style.transform = 'none'
    el.style.left = `${rect.left}px`
    el.style.top = `${rect.top}px`
    dragging = true
    document.body.style.userSelect = 'none'
    e.preventDefault()
  }, { signal: sig })

  document.addEventListener('mousemove', (e: MouseEvent) => {
    if (!dragging) return
    el.style.left = `${Math.max(0, Math.min(window.innerWidth - el.offsetWidth, e.clientX - ox))}px`
    el.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, e.clientY - oy))}px`
  }, { signal: sig })

  document.addEventListener('mouseup', () => {
    if (dragging) { dragging = false; document.body.style.userSelect = '' }
  }, { signal: sig })

  return ac
}

// ── updateFrameImage: fetch blob URL and update signal ───────────────────────
function updateFrameImage(idx: number): void {
  const f = _frames[idx]
  if (!f?.jpegUrl) return

  fetch(f.jpegUrl).then(resp => {
    if (!resp.ok) throw new Error('not ok')

    const ptsHeader = resp.headers.get('X-Frame-Pts-Ms')
    if (ptsHeader) {
      const pts = parseInt(ptsHeader)
      if (!isNaN(pts) && pts >= 0) {
        _frames[idx].actualPtsMs = pts
      }
    }

    return resp.blob()
  }).then(blob => {
    const f2 = _frames[idx]
    if (!f2) return
    if (f2.blobUrl) URL.revokeObjectURL(f2.blobUrl)
    const url = URL.createObjectURL(blob)
    f2.blobUrl = url
    renderGrid()
  }).catch(() => {
    _frames[idx].loadError = true
    renderGrid()
  })
}

// ── stopAutoScroll ────────────────────────────────────────────────────────────
function stopAutoScroll(): void {
  if (_autoScrollRaf !== null) { cancelAnimationFrame(_autoScrollRaf); _autoScrollRaf = null }
}

// ── applyDragToPoint: direct DOM updates for drag perf, NO renderGrid ─────────
function applyDragToPoint(x: number, y: number): void {
  const el = document.elementFromPoint(x, y) as HTMLElement | null
  const card = el?.closest<HTMLElement>('.jfs-fe-card')
  if (!card) return
  const idx = parseInt(card.dataset.idx ?? '')
  if (isNaN(idx) || !_frames[idx] || _frames[idx].selected === _dragSelectValue) return
  _frames[idx].selected = _dragSelectValue
  // Direct DOM updates for performance during drag — Preact sync at drag end
  card.classList.toggle('sel', _dragSelectValue)
  const cb = card.querySelector<HTMLInputElement>('.jfs-fe-cb')
  if (cb) cb.checked = _dragSelectValue
}

// ── wireGridHandlers ──────────────────────────────────────────────────────────
function wireGridHandlers(grid: HTMLElement): void {
  const scrollEl = grid.closest<HTMLElement>('.jfs-fe-scroll')
  const EDGE_ZONE = 64
  const MAX_SCROLL_SPEED = 8

  function runAutoScroll(speed: number): void {
    if (!scrollEl) return
    scrollEl.scrollTop += speed
    applyDragToPoint(_lastTouchX, _lastTouchY)
    _autoScrollRaf = requestAnimationFrame(() => runAutoScroll(speed))
  }

  // Desktop selection: mousedown is sole handler
  grid.addEventListener('mousedown', (e: MouseEvent) => {
    if (_suppressNextMousedown) { _suppressNextMousedown = false; return }
    const card = (e.target as HTMLElement).closest<HTMLElement>('.jfs-fe-card')
    if (!card || (e.target as HTMLElement).closest('.jfs-fe-card-acts,.jfs-fe-cb')) return
    const idx = parseInt(card.dataset.idx ?? '')
    if (isNaN(idx) || !_frames[idx]) return

    if (e.shiftKey && _lastClickedIdx >= 0 && _lastClickedIdx !== idx) {
      const lo = Math.min(_lastClickedIdx, idx)
      const hi = Math.max(_lastClickedIdx, idx)
      const target = !_frames[idx].selected
      for (let i = lo; i <= hi; i++) { _frames[i].selected = target }
      _lastClickedIdx = idx
      renderGrid()
      e.preventDefault()
      return
    }

    _frames[idx].selected = !_frames[idx].selected
    _dragSelectValue = _frames[idx].selected
    _dragMode = true
    _lastClickedIdx = idx
    card.classList.toggle('sel', _frames[idx].selected)
    const cb = card.querySelector<HTMLInputElement>('.jfs-fe-cb')
    if (cb) cb.checked = _frames[idx].selected
    renderGrid()
    e.preventDefault()
  }, { passive: false })

  grid.addEventListener('mouseover', (e: MouseEvent) => {
    if (!_dragMode) return
    const card = (e.target as HTMLElement).closest<HTMLElement>('.jfs-fe-card')
    if (!card) return
    applyDragToPoint(e.clientX, e.clientY)
  })

  // Touch: long-press (400ms) activates drag-select
  grid.addEventListener('touchstart', (e: TouchEvent) => {
    const touch = e.touches[0]
    const el = document.elementFromPoint(touch.clientX, touch.clientY) as HTMLElement | null
    const card = el?.closest<HTMLElement>('.jfs-fe-card')
    if (!card || el?.closest('.jfs-fe-card-acts,.jfs-fe-cb')) return
    const idx = parseInt(card.dataset.idx ?? '')
    if (isNaN(idx) || !_frames[idx]) return
    _longPressCard = card
    card.classList.add('jfs-pressing')
    _longPressTimer = setTimeout(() => {
      _longPressTimer = null
      _dragMode = true
      _frames[idx].selected = !_frames[idx].selected
      _dragSelectValue = _frames[idx].selected
      _lastClickedIdx = idx
      card.classList.remove('jfs-pressing')
      card.classList.toggle('sel', _frames[idx].selected)
      const cb = card.querySelector<HTMLInputElement>('.jfs-fe-cb')
      if (cb) cb.checked = _frames[idx].selected
      renderGrid()
      if ('vibrate' in navigator) navigator.vibrate(25)
    }, 400)
  }, { passive: true })

  grid.addEventListener('touchmove', (e: TouchEvent) => {
    if (_longPressTimer !== null) {
      clearTimeout(_longPressTimer)
      _longPressTimer = null
      _longPressCard?.classList.remove('jfs-pressing')
      _longPressCard = null
    }
    if (!_dragMode) return
    e.preventDefault()
    const touch = e.touches[0]
    _lastTouchX = touch.clientX
    _lastTouchY = touch.clientY
    applyDragToPoint(_lastTouchX, _lastTouchY)
    if (scrollEl) {
      const rect = scrollEl.getBoundingClientRect()
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
  }, { passive: false })

  const endTouch = (): void => {
    if (_longPressTimer !== null) { clearTimeout(_longPressTimer); _longPressTimer = null }
    _longPressCard?.classList.remove('jfs-pressing')
    _longPressCard = null
    stopAutoScroll()
    if (_dragMode) {
      // Sync signal after drag
      renderGrid()
      _suppressNextMousedown = true
      setTimeout(() => { _suppressNextMousedown = false }, 500)
    }
    _dragMode = false
  }
  grid.addEventListener('touchend', endTouch, { passive: true })
  grid.addEventListener('touchcancel', endTouch, { passive: true })

  // mouseup: sync signal after drag
  document.addEventListener('mouseup', () => {
    if (_dragMode) renderGrid()
    _dragMode = false
  })

  // Checkbox change (delegated)
  grid.addEventListener('change', (e) => {
    const cb = e.target as HTMLInputElement
    if (!cb.classList.contains('jfs-fe-cb')) return
    e.stopPropagation()
    const idx = parseInt(cb.dataset.idx ?? '')
    if (!isNaN(idx) && _frames[idx]) {
      _frames[idx].selected = cb.checked
      renderGrid()
    }
  })

  // View / Download / Remove buttons (delegated)
  grid.addEventListener('click', (e) => {
    const viewBtn = (e.target as HTMLElement).closest<HTMLButtonElement>('.jfs-fe-view-btn')
    if (viewBtn) {
      e.stopPropagation()
      const idx = parseInt(viewBtn.dataset.idx ?? '')
      if (!isNaN(idx) && _frames[idx]) openLightbox(idx)
      return
    }
    const dlBtn = (e.target as HTMLElement).closest<HTMLButtonElement>('.jfs-fe-dl-btn')
    if (dlBtn) {
      e.stopPropagation()
      const idx = parseInt(dlBtn.dataset.idx ?? '')
      if (!isNaN(idx) && _frames[idx]) downloadFrame(_frames[idx].posMs)
      return
    }
    const rmBtn = (e.target as HTMLElement).closest<HTMLButtonElement>('.jfs-fe-rm-btn')
    if (rmBtn) {
      e.stopPropagation()
      const idx = parseInt(rmBtn.dataset.idx ?? '')
      if (!isNaN(idx) && _frames[idx]) {
        _frames[idx].removed = true
        _frames[idx].selected = false
        renderGrid()
      }
    }
  })

  // Image load errors (delegated via capture)
  grid.addEventListener('error', (e) => {
    const img = e.target as HTMLImageElement
    if (!img.dataset.imgIdx) return
    const idx = parseInt(img.dataset.imgIdx)
    if (!isNaN(idx) && _frames[idx]) {
      _frames[idx].loadError = true
      renderGrid()
    }
  }, true)
}

// ── openLightbox ──────────────────────────────────────────────────────────────
function openLightbox(startIdx: number): void {
  let currentIdx = startIdx
  const overlay = document.createElement('div')
  overlay.className = 'jfs-fe-lb'

  const renderLb = (): void => {
    const f = _frames[currentIdx]
    if (!f) return
    const hasPrev = currentIdx > 0
    const hasNext = currentIdx < _frames.length - 1
    overlay.innerHTML = `
      <button class="jfs-fe-lb-nav jfs-fe-lb-prev" title="上一帧（←）"${hasPrev ? '' : ' disabled'}>${ICON_PREV}</button>
      <img src="${frameUrl(f.posMs, 0)}" alt="${formatTime(f.posMs)}" />
      <button class="jfs-fe-lb-nav jfs-fe-lb-next" title="下一帧（→）"${hasNext ? '' : ' disabled'}>${ICON_NEXT}</button>
      <button class="jfs-fe-lb-close" title="关闭">✕</button>
      <div class="jfs-fe-lb-info">${currentIdx + 1} / ${_frames.length} · ${formatTime(f.posMs)}</div>
    `
    overlay.querySelector('.jfs-fe-lb-close')!.addEventListener('click', close)
    overlay.querySelector('.jfs-fe-lb-prev')?.addEventListener('click', (e) => {
      e.stopPropagation(); if (currentIdx > 0) { currentIdx--; renderLb() }
    })
    overlay.querySelector('.jfs-fe-lb-next')?.addEventListener('click', (e) => {
      e.stopPropagation(); if (currentIdx < _frames.length - 1) { currentIdx++; renderLb() }
    })
  }

  const close = (): void => { overlay.remove(); document.removeEventListener('keydown', kbHandler, true) }
  const kbHandler = (ev: KeyboardEvent): void => {
    ev.stopPropagation()
    if (ev.key === 'Escape') close()
    else if (ev.key === 'ArrowLeft' && currentIdx > 0) { currentIdx--; renderLb() }
    else if (ev.key === 'ArrowRight' && currentIdx < _frames.length - 1) { currentIdx++; renderLb() }
  }
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close() })
  document.addEventListener('keydown', kbHandler, { capture: true })
  renderLb()
  document.body.appendChild(overlay)
}

// ── downloadFrame ─────────────────────────────────────────────────────────────
function downloadFrame(posMs: number): void {
  const url = frameUrl(posMs, 0)
  const title = document.title.replace(/\s*[-|]\s*Jellyfin\s*$/i, '').trim() || 'frame'
  const ts = formatTime(posMs).replace(/[:.]/g, '-')
  const a = document.createElement('a')
  a.href = url
  a.download = `jellyfin-frame-${title}-${ts}.jpg`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

// ── prefetchAndStream ─────────────────────────────────────────────────────────
async function prefetchAndStream(positions: number[], width: number): Promise<void> {
  if (positions.length === 0) return
  const base = getBaseUrl()
  const token = getToken()

  try {
    await fetch(
      `${base}/JellyfinSuite/FrameExport/Prefetch/${_itemId}?api_key=${encodeURIComponent(token)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positions: positions.map(p => Math.round(p)), width }),
      }
    )
  } catch { /* proceed even if prefetch request fails */ }

  return new Promise((resolve) => {
    const sseUrl = `${base}/JellyfinSuite/FrameExport/PrefetchReady/${_itemId}?width=${width}&api_key=${encodeURIComponent(token)}`
    const evSrc = new EventSource(sseUrl)
    const pending = new Set(positions)
    sPrefetchTotal.value = pending.size
    sPrefetchDone.value = 0

    evSrc.onmessage = (e) => {
      const posMs = parseInt(e.data)
      if (isNaN(posMs) || !pending.delete(posMs)) return

      sPrefetchDone.value = sPrefetchTotal.value - pending.size
      // Update only the card that matches this exact posMs
      for (let i = 0; i < _frames.length; i++) {
        if (_frames[i].posMs === posMs) {
          _frames[i].jpegUrl = frameUrl(_frames[i].posMs, width)
          updateFrameImage(i)
        }
      }

      if (pending.size === 0) { evSrc.close(); resolve(undefined) }
    }

    evSrc.onerror = () => { evSrc.close(); resolve(undefined) }
  }).then(() => {
    sPrefetchTotal.value = 0
    sPrefetchDone.value = 0
  })
}

// ── loadInitialFrames ─────────────────────────────────────────────────────────
async function loadInitialFrames(): Promise<void> {
  if (!_videoEl) return
  const dur = _videoEl.duration
  const durationMs = (isFinite(dur) && dur > 0) ? dur * 1000 : Number.MAX_SAFE_INTEGER
  const centerMs = Math.round(_videoEl.currentTime * 1000)

  const hasIndex = await fetchFrameIndex()

  if (hasIndex && _frameIndex && _frameIndex.length > 0) {
    const startMs = Math.max(0, centerMs - 1000)
    const endMs   = centerMs + 1000

    let startFi = _frameIndex.findIndex(f => f.ms >= startMs)
    if (startFi < 0) startFi = 0
    let endFi = _frameIndex.findIndex(f => f.ms > endMs)
    if (endFi < 0) endFi = _frameIndex.length
    endFi = Math.max(startFi, endFi - 1)

    _fiMinIdx = startFi
    _fiMaxIdx = endFi

    const slice = _frameIndex.slice(startFi, endFi + 1)
    _minPosMs = slice[0]?.ms ?? centerMs
    _maxPosMs = slice[slice.length - 1]?.ms ?? centerMs
    _frames = slice.map(f => ({
      posMs: f.ms, actualPtsMs: f.ms, selected: true, jpegUrl: '', isJunk: false, junkReason: null,
    }))
    renderGrid()
    await prefetchAndStream(slice.map(f => f.ms), 320)
  } else {
    if (!hasIndex) _fpsFrac = await fetchVideoFps()
    const startMs = Math.max(0, centerMs - 1000)
    const endMs   = Math.min(durationMs, centerMs + 1000)
    const positions = samplePositionsInRange(startMs, endMs)
    _minPosMs = positions[0] ?? centerMs
    _maxPosMs = positions[positions.length - 1] ?? centerMs
    _frames = positions.map(posMs => ({ posMs, selected: true, jpegUrl: '', isJunk: false, junkReason: null }))
    renderGrid()
    await prefetchAndStream(positions, 320)
  }
}

// ── expandFrames ──────────────────────────────────────────────────────────────
async function expandFrames(direction: number): Promise<void> {
  if (!_videoEl) return
  const dur = _videoEl.duration
  const durationMs = (isFinite(dur) && dur > 0) ? dur * 1000 : Number.MAX_SAFE_INTEGER
  const rangeMs = 1000

  // Signal the button is disabled by re-rendering — we track loading state via a flag
  // (keep consistent with original: disable via DOM attribute briefly, restored in finally)
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
        _fiMinIdx = sliceStart
        _minPosMs = _frameIndex[sliceStart].ms
      } else {
        if (_fiMaxIdx >= _frameIndex.length - 1) return
        sliceStart = _fiMaxIdx + 1
        const targetMs = _frameIndex[_fiMaxIdx].ms + rangeMs
        sliceEnd = _frameIndex.length - 1
        for (let i = sliceStart; i < _frameIndex.length; i++) {
          if (_frameIndex[i].ms > targetMs) { sliceEnd = i - 1; break }
        }
        _fiMaxIdx = sliceEnd
        _maxPosMs = _frameIndex[sliceEnd].ms
      }

      const slice = _frameIndex.slice(sliceStart, sliceEnd + 1)
      if (slice.length === 0) return

      const placeholders: FrameEntry[] = slice.map(f => ({
        posMs: f.ms, actualPtsMs: f.ms, selected: true, jpegUrl: '', isJunk: false, junkReason: null,
      }))
      if (direction < 0) _frames = [...placeholders, ..._frames]
      else _frames.push(...placeholders)
      renderGrid()
      await prefetchAndStream(slice.map(f => f.ms), 320)
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
        if (direction < 0) _minPosMs = newPositions[0]
        else _maxPosMs = newPositions[newPositions.length - 1]
        const placeholders: FrameEntry[] = newPositions.map(posMs => ({
          posMs, selected: true, jpegUrl: '', isJunk: false, junkReason: null,
        }))
        if (direction < 0) _frames = [...placeholders, ..._frames]
        else _frames.push(...placeholders)
        renderGrid()
        await prefetchAndStream(newPositions, 320)
      } else {
        if (direction < 0) _minPosMs = queryStart
        else _maxPosMs = queryEnd
      }
    }
  } finally {
    if (btn) btn.removeAttribute('disabled')
    renderGrid()  // re-render to update expand button disabled state
  }
}

// ── SVG Icons ─────────────────────────────────────────────────────────────────
const ICON_PREV = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`
const ICON_NEXT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`

const ICON_VIEW = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/>
</svg>`

const ICON_DOWNLOAD = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
</svg>`

const ICON_TRASH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`
const ICON_CCW  = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>`
const ICON_CW   = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`
const ICON_CROP = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 2 6 17 21 17"/><polyline points="2 6 17 6 17 21"/></svg>`

// ── Crop Popover helpers ──────────────────────────────────────────────────────
function showToast(msg: string, ms = 2800): void {
  document.getElementById('jfs-fe-toast')?.remove()
  const el = document.createElement('div')
  el.id = 'jfs-fe-toast'
  el.className = 'jfs-fe-toast'
  el.textContent = msg
  document.body.appendChild(el)
  setTimeout(() => el.remove(), ms)
}

type HandleId = 'nw'|'n'|'ne'|'e'|'se'|'s'|'sw'|'w'|'move'|'draw'

const HANDLE_CURSOR: Record<HandleId, string> = {
  nw: 'nw-resize', n: 'n-resize', ne: 'ne-resize', e: 'e-resize',
  se: 'se-resize', s: 's-resize', sw: 'sw-resize', w: 'w-resize',
  move: 'move', draw: 'crosshair',
}

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
  if (d.w >= 0.99 && d.h >= 0.99) return 'draw'
  const THRESH = 14
  for (const h of getHandles(d, cw, ch)) {
    if (Math.abs(mx - h.x) <= THRESH && Math.abs(my - h.y) <= THRESH) return h.id
  }
  const [px, py, pw, ph] = [d.x * cw, d.y * ch, d.w * cw, d.h * ch]
  if (mx >= px && mx <= px + pw && my >= py && my <= py + ph) return 'move'
  return 'draw'
}

function applyHandleResize(handle: HandleId, orig: CropRect, dx: number, dy: number): CropRect {
  const MIN = 0.02
  let { x, y, w, h } = orig
  switch (handle) {
    case 'nw': x = Math.min(orig.x + dx, orig.x + orig.w - MIN); y = Math.min(orig.y + dy, orig.y + orig.h - MIN); w = orig.x + orig.w - x; h = orig.y + orig.h - y; break
    case 'n':  y = Math.min(orig.y + dy, orig.y + orig.h - MIN); h = orig.y + orig.h - y; break
    case 'ne': w = Math.max(MIN, orig.w + dx); y = Math.min(orig.y + dy, orig.y + orig.h - MIN); h = orig.y + orig.h - y; break
    case 'e':  w = Math.max(MIN, orig.w + dx); break
    case 'se': w = Math.max(MIN, orig.w + dx); h = Math.max(MIN, orig.h + dy); break
    case 's':  h = Math.max(MIN, orig.h + dy); break
    case 'sw': x = Math.min(orig.x + dx, orig.x + orig.w - MIN); w = orig.x + orig.w - x; h = Math.max(MIN, orig.h + dy); break
    case 'w':  x = Math.min(orig.x + dx, orig.x + orig.w - MIN); w = orig.x + orig.w - x; break
    default: break
  }
  x = Math.max(0, x); y = Math.max(0, y)
  w = Math.min(w, 1 - x); h = Math.min(h, 1 - y)
  return { x, y, w: Math.max(MIN, w), h: Math.max(MIN, h) }
}

function openCropPopover(): void {
  if (document.getElementById('jfs-cp-stage')) return
  const loadedFrames = _frames.filter(f => !f.removed && f.jpegUrl)
  if (loadedFrames.length === 0) { showToast('没有已加载的帧，请先加载再裁切'); return }

  const currentMs = (_videoEl?.currentTime ?? 0) * 1000
  let curIdx = 0; let minDiff = Infinity
  loadedFrames.forEach((f, i) => { const d = Math.abs(f.posMs - currentMs); if (d < minDiff) { minDiff = d; curIdx = i } })

  const st = sSettings.value
  let draft: CropRect = st.cropRect ? { ...st.cropRect } : { x: 0, y: 0, w: 1, h: 1 }
  let activeHandle: HandleId | null = null
  let handleStart: { mx: number; my: number; draft0: CropRect } | null = null

  const overlayEl = document.createElement('div')
  overlayEl.className = 'jfs-fe-crop-overlay'
  overlayEl.innerHTML = `
    <div class="jfs-fe-crop-dialog">
      <div class="jfs-fe-crop-stage" id="jfs-cp-stage">
        <img id="jfs-cp-img" alt="" />
        <canvas id="jfs-cp-canvas" class="jfs-fe-crop-canvas"></canvas>
        <button id="jfs-cp-prev" class="jfs-fe-cp-nav jfs-fe-cp-nav-l">‹</button>
        <button id="jfs-cp-next" class="jfs-fe-cp-nav jfs-fe-cp-nav-r">›</button>
        <div class="jfs-fe-cp-label" id="jfs-cp-label"></div>
      </div>
      <div class="jfs-fe-row sep-t" style="gap:6px">
        <span class="jfs-fe-muted" id="jfs-cp-info" style="flex:1;font-size:11px">选择裁切区域</span>
        <button id="jfs-cp-reset" class="jfs-fe-btn g" style="padding:3px 10px;font-size:12px">重置</button>
        <button id="jfs-cp-cancel" class="jfs-fe-btn" style="padding:3px 10px;font-size:12px">取消</button>
        <button id="jfs-cp-apply" class="jfs-fe-btn p" style="padding:3px 10px;font-size:12px">应用</button>
      </div>
    </div>
  `
  document.body.appendChild(overlayEl)

  const img    = document.getElementById('jfs-cp-img')    as HTMLImageElement
  const canvas = document.getElementById('jfs-cp-canvas') as HTMLCanvasElement
  const label  = document.getElementById('jfs-cp-label')!
  const info   = document.getElementById('jfs-cp-info')!

  function isApplyEnabled(): boolean {
    return true
  }

  function updateApplyBtn(): void {
    const btn = document.getElementById('jfs-cp-apply') as HTMLButtonElement | null
    if (btn) btn.disabled = !isApplyEnabled()
  }

  function drawCanvas(): void {
    const ctx = canvas.getContext('2d')!
    const cw = canvas.width, ch = canvas.height
    ctx.clearRect(0, 0, cw, ch)
    const isFullFrame = draft.w >= 0.99 && draft.h >= 0.99
    if (isFullFrame) {
      ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1; ctx.setLineDash([4, 4])
      ctx.strokeRect(1, 1, cw - 2, ch - 2); ctx.restore()
      return
    }
    const { x, y, w, h } = draft
    const [px, py, pw, ph] = [x * cw, y * ch, w * cw, h * ch]
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.fillRect(0, 0, cw, ch)
    ctx.clearRect(px, py, pw, ph)
    ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3])
    ctx.strokeRect(px + 0.5, py + 0.5, pw - 1, ph - 1); ctx.restore()
    ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,0.2)'; ctx.lineWidth = 0.5
    for (let i = 1; i < 3; i++) {
      ctx.beginPath(); ctx.moveTo(px + pw * i / 3, py); ctx.lineTo(px + pw * i / 3, py + ph); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(px, py + ph * i / 3); ctx.lineTo(px + pw, py + ph * i / 3); ctx.stroke()
    }
    ctx.restore()
    const CORNERS: HandleId[] = ['nw', 'ne', 'sw', 'se']
    ctx.save(); ctx.fillStyle = '#fff'; ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 1
    for (const hdl of getHandles(draft, cw, ch)) {
      const sz = CORNERS.includes(hdl.id) ? 6 : 4
      ctx.beginPath(); ctx.rect(hdl.x - sz, hdl.y - sz, sz * 2, sz * 2); ctx.fill(); ctx.stroke()
    }
    ctx.restore()
  }

  function updateInfo(): void {
    const cropW = Math.round(draft.w * img.naturalWidth)
    const cropH = Math.round(draft.h * img.naturalHeight)
    const currentSt = sSettings.value
    let targetPx = 0, resizeMode = currentSt.resizeMode
    if (currentSt.resizeMode === 'height' && currentSt.customHeight > 0) {
      targetPx = currentSt.customHeight
    } else if (currentSt.customWidth > 0) {
      targetPx = currentSt.customWidth; resizeMode = 'width'
    } else if (currentSt.resolutionPreset !== 'original') {
      const pm: Record<string, number> = { '1080p': 1080, '720p': 720, '480p': 480, '360p': 360 }
      targetPx = pm[currentSt.resolutionPreset] ?? 0; resizeMode = 'width'
    }
    let outW = cropW, outH = cropH
    if (targetPx > 0) {
      if (resizeMode === 'width') { outW = targetPx; outH = Math.round(cropH * targetPx / cropW) }
      else { outH = targetPx; outW = Math.round(cropW * targetPx / cropH) }
    }
    info.textContent = (outW === cropW && outH === cropH)
      ? `选区 ${cropW}×${cropH} px`
      : `选区 ${cropW}×${cropH} → 输出 ${outW}×${outH} px`
  }

  function positionCanvas(): void {
    const stage = document.getElementById('jfs-cp-stage')!
    const sRect = stage.getBoundingClientRect()
    const iRect = img.getBoundingClientRect()
    canvas.style.left   = `${iRect.left - sRect.left}px`
    canvas.style.top    = `${iRect.top  - sRect.top}px`
    canvas.style.width  = `${iRect.width}px`
    canvas.style.height = `${iRect.height}px`
    canvas.width  = Math.round(iRect.width)  || img.naturalWidth
    canvas.height = Math.round(iRect.height) || img.naturalHeight
  }

  function loadFrame(idx: number): void {
    curIdx = idx
    const f = loadedFrames[idx]
    label.textContent = `${idx + 1} / ${loadedFrames.length} · ${formatTime(f.posMs)}`
    const prevBtn = document.getElementById('jfs-cp-prev') as HTMLButtonElement | null
    const nextBtn = document.getElementById('jfs-cp-next') as HTMLButtonElement | null
    if (prevBtn) prevBtn.disabled = idx === 0
    if (nextBtn) nextBtn.disabled = idx === loadedFrames.length - 1
    img.onload = () => requestAnimationFrame(() => {
      positionCanvas(); drawCanvas(); updateInfo(); updateApplyBtn()
    })
    img.src = f.jpegUrl
  }

  function applyDragCrop(clientX: number, clientY: number): void {
    const r = canvas.getBoundingClientRect()
    const pos = {
      x: Math.max(0, Math.min(canvas.width,  (clientX - r.left) * canvas.width  / r.width)),
      y: Math.max(0, Math.min(canvas.height, (clientY - r.top)  * canvas.height / r.height)),
    }
    if (!activeHandle || !handleStart) return
    const dx = (pos.x - handleStart.mx) / canvas.width
    const dy = (pos.y - handleStart.my) / canvas.height
    const orig = handleStart.draft0
    if (activeHandle === 'draw') {
      const sx = orig.x, sy = orig.y
      const cx = Math.max(0, Math.min(1, pos.x / canvas.width))
      const cy = Math.max(0, Math.min(1, pos.y / canvas.height))
      draft = { x: Math.min(sx, cx), y: Math.min(sy, cy), w: Math.max(0.01, Math.abs(cx - sx)), h: Math.max(0.01, Math.abs(cy - sy)) }
    } else if (activeHandle === 'move') {
      draft = { x: Math.max(0, Math.min(1 - orig.w, orig.x + dx)), y: Math.max(0, Math.min(1 - orig.h, orig.y + dy)), w: orig.w, h: orig.h }
    } else {
      draft = applyHandleResize(activeHandle, orig, dx, dy)
    }
    drawCanvas(); updateInfo(); updateApplyBtn()
  }

  canvas.addEventListener('pointerdown', (e) => {
    const r = canvas.getBoundingClientRect()
    const pos = {
      x: Math.max(0, Math.min(canvas.width,  (e.clientX - r.left) * canvas.width  / r.width)),
      y: Math.max(0, Math.min(canvas.height, (e.clientY - r.top)  * canvas.height / r.height)),
    }
    const type = hitTest(pos.x, pos.y, draft, canvas.width, canvas.height)
    activeHandle = type
    handleStart = { mx: pos.x, my: pos.y, draft0: { ...draft } }
    if (type === 'draw') {
      const nx = pos.x / canvas.width, ny = pos.y / canvas.height
      draft = { x: nx, y: ny, w: 0.01, h: 0.01 }
    }
    canvas.setPointerCapture(e.pointerId); e.preventDefault()
  }, { passive: false })

  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect()
    const pos = {
      x: Math.max(0, Math.min(canvas.width,  (e.clientX - r.left) * canvas.width  / r.width)),
      y: Math.max(0, Math.min(canvas.height, (e.clientY - r.top)  * canvas.height / r.height)),
    }
    if (!activeHandle || !handleStart) {
      canvas.style.cursor = HANDLE_CURSOR[hitTest(pos.x, pos.y, draft, canvas.width, canvas.height)]
      return
    }
    applyDragCrop(e.clientX, e.clientY); e.preventDefault()
  }, { passive: false })

  canvas.addEventListener('pointerup', () => { activeHandle = null; handleStart = null })

  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault()
    const touch = e.touches[0]
    const r = canvas.getBoundingClientRect()
    const pos = {
      x: Math.max(0, Math.min(canvas.width,  (touch.clientX - r.left) * canvas.width  / r.width)),
      y: Math.max(0, Math.min(canvas.height, (touch.clientY - r.top)  * canvas.height / r.height)),
    }
    const type = hitTest(pos.x, pos.y, draft, canvas.width, canvas.height)
    activeHandle = type
    handleStart = { mx: pos.x, my: pos.y, draft0: { ...draft } }
    if (type === 'draw') draft = { x: pos.x / canvas.width, y: pos.y / canvas.height, w: 0.01, h: 0.01 }
  }, { passive: false })

  canvas.addEventListener('touchmove', (e) => {
    e.preventDefault()
    const touch = e.touches[0]
    applyDragCrop(touch.clientX, touch.clientY)
  }, { passive: false })

  canvas.addEventListener('touchend', () => { activeHandle = null; handleStart = null }, { passive: true })

  document.getElementById('jfs-cp-prev')?.addEventListener('click', () => { if (curIdx > 0) loadFrame(curIdx - 1) })
  document.getElementById('jfs-cp-next')?.addEventListener('click', () => { if (curIdx < loadedFrames.length - 1) loadFrame(curIdx + 1) })
  document.getElementById('jfs-cp-reset')?.addEventListener('click', () => {
    draft = { x: 0, y: 0, w: 1, h: 1 }; drawCanvas(); updateInfo(); updateApplyBtn()
  })
  document.getElementById('jfs-cp-cancel')?.addEventListener('click', () => overlayEl.remove())
  overlayEl.addEventListener('click', (e) => { if (e.target === overlayEl) overlayEl.remove() })

  document.getElementById('jfs-cp-apply')?.addEventListener('click', () => {
    if (!isApplyEnabled()) return
    const isFullFrame = draft.w >= 0.99 && draft.h >= 0.99
    const newCrop = isFullFrame ? null : { ...draft }
    const currentSt = sSettings.value
    const changed = JSON.stringify(newCrop) !== JSON.stringify(currentSt.cropRect)
    const patch: Partial<ExportSettings> = { cropRect: newCrop }
    if (changed && (currentSt.customWidth > 0 || currentSt.customHeight > 0)) {
      const vw = _videoEl?.videoWidth || 1
      const vh = _videoEl?.videoHeight || 1
      if (currentSt.resizeMode === 'width' && currentSt.customWidth > 0) {
        const hRatio = newCrop ? (newCrop.h * vh) / (newCrop.w * vw) : vh / vw
        patch.customHeight = Math.round(currentSt.customWidth * hRatio)
        showToast('已根据裁切比例自动调整高度')
      } else if (currentSt.resizeMode === 'height' && currentSt.customHeight > 0) {
        const wRatio = newCrop ? (newCrop.w * vw) / (newCrop.h * vh) : vw / vh
        patch.customWidth = Math.round(currentSt.customHeight * wRatio)
        showToast('已根据裁切比例自动调整宽度')
      }
    }
    updateSettings(patch)
    overlayEl.remove()
  })

  loadFrame(curIdx)
}

// ── submitGenerate ────────────────────────────────────────────────────────────
async function submitGenerate(): Promise<void> {
  const exportType = sExportType.value
  const st = sSettings.value
  const allSelected = _frames.filter(f => f.selected && !f.removed)
  const seenMs = new Set<number>()
  const selected = allSelected.filter(f => {
    const ms = Math.round(f.posMs)
    if (seenMs.has(ms)) return false
    seenMs.add(ms)
    return true
  })
  if (selected.length < 2) { alert('至少需要选择 2 帧'); return }
  if (selected.length > 240 && !confirm(`选中 ${selected.length} 帧，文件可能较大。继续？`)) return

  const format = exportType === 'animate' ? st.animateFormat : st.stitchFormat
  const body = {
    itemId: _itemId,
    itemTitle: document.title.replace(/\s*[-|]\s*Jellyfin\s*$/i, '').trim() || 'export',
    type: exportType,
    frames: selected.map(f => ({ positionMs: Math.round(f.posMs) })),
    params: {
      format,
      resizeMode: st.resizeMode,
      customWidth: st.customWidth || null,
      customHeight: st.customHeight || null,
      resolutionPreset: st.resolutionPreset,
      speed: st.speed,
      loopCount: st.loopCount,
      cropX: st.cropRect?.x ?? 0,
      cropY: st.cropRect?.y ?? 0,
      cropW: st.cropRect?.w ?? 0,
      cropH: st.cropRect?.h ?? 0,
      quality: exportType === 'animate' ? st.animateQuality : st.stitchQuality,
    },
  }

  const res = await fetch(
    `${getBaseUrl()}/JellyfinSuite/FrameExport/Generate?api_key=${encodeURIComponent(getToken())}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  )
  if (!res.ok) { alert(`生成失败: ${res.status}`); return }

  const { taskId } = await res.json() as GenerateResponse
  if (!taskId) { alert('生成失败: 未返回任务 ID'); return }
  showProgressPage(taskId)
}

// ── Components ────────────────────────────────────────────────────────────────

function FrameCard({ frame: f, idx }: { frame: FrameEntry; idx: number }) {
  const prefetchPct = sPrefetchTotal.value > 0
    ? sPrefetchDone.value / sPrefetchTotal.value * 100
    : 100

  const imgContent = f.loadError
    ? <div class="jfs-fe-err-ph">{t('frameExport.loadError')}</div>
    : f.blobUrl
      ? <img src={f.blobUrl} alt={formatTime(f.posMs)} data-img-idx={String(idx)} />
      : <div class="jfs-fe-loading"><div class="jfs-fe-load-bar" style={{ width: `${prefetchPct}%` }} /></div>

  const displayMs = f.actualPtsMs ?? f.posMs

  return (
    <div class={`jfs-fe-card${f.selected ? ' sel' : ''}${f.isJunk ? ' junk' : ''}`}
         data-idx={String(idx)} style={{ cursor: 'pointer' }}>
      {f.isJunk && <span class="jfs-fe-badge">{f.junkReason || '垃圾帧'}</span>}
      {imgContent}
      <div class="jfs-fe-card-acts">
        <button class="jfs-fe-card-act jfs-fe-view-btn" data-idx={String(idx)} title="查看大图" dangerouslySetInnerHTML={{ __html: ICON_VIEW }} />
        <button class="jfs-fe-card-act jfs-fe-dl-btn" data-idx={String(idx)} title="下载原图" dangerouslySetInnerHTML={{ __html: ICON_DOWNLOAD }} />
        <button class="jfs-fe-card-act jfs-fe-rm-btn" data-idx={String(idx)} title="移除此帧" dangerouslySetInnerHTML={{ __html: ICON_TRASH }} />
      </div>
      <div class="jfs-fe-card-foot">
        <input type="checkbox" checked={f.selected} data-idx={String(idx)} class="jfs-fe-cb" style={{ cursor: 'pointer' }} />
        {formatTime(displayMs)} <span class="jfs-fe-frnum">#{msToFrameIdx(displayMs)}</span>
      </div>
    </div>
  )
}

function FrameGrid() {
  const gridRef = useRef<HTMLDivElement>(null)
  const frames = sFrames.value

  // Mount drag handlers once on first render
  useEffect(() => {
    if (!gridRef.current) return
    wireGridHandlers(gridRef.current)
    // wireGridHandlers attaches listeners to the grid element; they survive rerenders
    // No cleanup needed — element removal takes care of it
  }, [])

  return (
    <div class="jfs-fe-scroll">
      <div id="jfs-fe-grid" class="jfs-fe-grid" ref={gridRef}>
        {frames.map((f, i) => f.removed ? null : (
          <FrameCard key={f.posMs} frame={f} idx={i} />
        ))}
      </div>
    </div>
  )
}

function ParamsPanel() {
  const st = sSettings.value
  const isAnim = sExportType.value === 'animate'
  const curQuality = isAnim ? st.animateQuality : st.stitchQuality
  const isLossless = curQuality <= 0
  const presets = ['original', '1080p', '720p', '480p', '360p']

  function handleCustomToggle(e: Event): void {
    const checked = (e.target as HTMLInputElement).checked
    if (!checked) {
      updateSettings({ useCustomResolution: false, customWidth: 0, customHeight: 0 })
    } else {
      updateSettings({ useCustomResolution: true, resolutionPreset: 'original' })
    }
  }

  function handlePresetChange(e: Event): void {
    const val = (e.target as HTMLSelectElement).value
    if (val !== 'original') {
      updateSettings({ resolutionPreset: val, resizeMode: 'width', customWidth: 0, customHeight: 0 })
    } else {
      updateSettings({ resolutionPreset: val })
    }
  }

  function handleWidthInput(e: Event): void {
    const v = parseInt((e.target as HTMLInputElement).value) || 0
    const patch: Partial<ExportSettings> = { customWidth: v, resizeMode: 'width', resolutionPreset: 'original' }
    if (v > 0 && _videoEl) {
      const cr = st.cropRect
      const hRatio = cr
        ? (cr.h * (_videoEl.videoHeight || 1)) / (cr.w * (_videoEl.videoWidth || 1))
        : (_videoEl.videoHeight || 1) / (_videoEl.videoWidth || 1)
      patch.customHeight = Math.round(v * hRatio)
    } else {
      patch.customHeight = 0
    }
    updateSettings(patch)
  }

  function handleHeightInput(e: Event): void {
    const v = parseInt((e.target as HTMLInputElement).value) || 0
    const patch: Partial<ExportSettings> = { customHeight: v, resizeMode: 'height', resolutionPreset: 'original' }
    if (v > 0 && _videoEl) {
      const cr = st.cropRect
      const wRatio = cr
        ? (cr.w * (_videoEl.videoWidth || 1)) / (cr.h * (_videoEl.videoHeight || 1))
        : (_videoEl.videoWidth || 1) / (_videoEl.videoHeight || 1)
      patch.customWidth = Math.round(v * wRatio)
    } else {
      patch.customWidth = 0
    }
    updateSettings(patch)
  }

  function handleSpeedChange(e: Event): void {
    updateSettings({ speed: parseFloat((e.target as HTMLSelectElement).value) || 1.0 })
  }

  function handleLoopInput(e: Event): void {
    updateSettings({ loopCount: Math.max(0, Math.min(99, parseInt((e.target as HTMLInputElement).value) || 0)) })
  }

  function handleLosslessChange(e: Event): void {
    const checked = (e.target as HTMLInputElement).checked
    const qualVal = isAnim ? st.animateQuality : st.stitchQuality
    const fallbackQual = qualVal > 0 ? qualVal : 0.75
    if (isAnim) {
      updateSettings({ animateQuality: checked ? 0 : fallbackQual })
    } else {
      updateSettings({ stitchQuality: checked ? 0 : fallbackQual })
    }
  }

  function handleQualityChange(e: Event): void {
    const v = parseFloat((e.target as HTMLSelectElement).value) || 0.75
    if (isAnim) updateSettings({ animateQuality: v })
    else updateSettings({ stitchQuality: v })
  }

  const qualityOptions = [
    { v: 0.85, label: '高质量 85%' },
    { v: 0.75, label: '标准 75%' },
    { v: 0.60, label: '普通 60%' },
  ]
  const qualVal = isLossless ? 0.75 : curQuality

  return (
    <div class="jfs-fe-pbar dark-bg sep-b">
      {isAnim && <>
        {/* Resolution group */}
        <div class="jfs-fe-pgroup">
          <div class="jfs-fe-pgroup-body">
            <label class="jfs-fe-lbl" style={{ gap: '5px', whiteSpace: 'nowrap' }}>
              <span class="jfs-fe-muted" style={{ fontSize: '11px' }}>预设</span>
              <input type="checkbox" class="jfs-fe-toggle-chk" checked={st.useCustomResolution} onChange={handleCustomToggle} />
              <span class="jfs-fe-toggle-track" />
              <span class="jfs-fe-muted" style={{ fontSize: '11px' }}>自定义</span>
            </label>
            {!st.useCustomResolution
              ? <select class="jfs-fe-sel" value={st.resolutionPreset} onChange={handlePresetChange}>
                  {presets.map(p => (
                    <option key={p} value={p}>{p === 'original' ? '原始' : p}</option>
                  ))}
                </select>
              : <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span class="jfs-fe-muted" style={{ width: '16px' }}>宽</span>
                    <input
                      type="number"
                      value={st.customWidth || ''}
                      placeholder="px"
                      class="jfs-fe-inp"
                      style={{ width: '56px' }}
                      onInput={handleWidthInput}
                      onKeyDown={(e: KeyboardEvent) => e.stopPropagation()}
                      onWheel={(e: WheelEvent) => e.stopPropagation()}
                    />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span class="jfs-fe-muted" style={{ width: '16px' }}>高</span>
                    <input
                      type="number"
                      value={st.customHeight || ''}
                      placeholder="auto"
                      class="jfs-fe-inp"
                      style={{ width: '56px' }}
                      onInput={handleHeightInput}
                      onKeyDown={(e: KeyboardEvent) => e.stopPropagation()}
                      onWheel={(e: WheelEvent) => e.stopPropagation()}
                    />
                  </div>
                </>
            }
          </div>
          <div class="jfs-fe-pgroup-label">分辨率</div>
        </div>
        <div class="jfs-fe-pgroup-sep" />
        {/* Speed / Loop group */}
        <div class="jfs-fe-pgroup">
          <div class="jfs-fe-pgroup-body">
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <span class="jfs-fe-muted" style={{ width: '28px' }}>倍速</span>
              <select class="jfs-fe-sel" value={String(st.speed)} onChange={handleSpeedChange}>
                {[0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4].map(v => (
                  <option key={v} value={String(v)}>{v}x</option>
                ))}
              </select>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <span class="jfs-fe-muted" style={{ width: '28px' }}>循环</span>
              <input
                type="number"
                min={0}
                max={99}
                value={st.loopCount}
                class="jfs-fe-inp"
                style={{ width: '44px' }}
                onInput={handleLoopInput}
                onKeyDown={(e: KeyboardEvent) => e.stopPropagation()}
                onWheel={(e: WheelEvent) => e.stopPropagation()}
              />
              <span class="jfs-fe-muted">(0=∞)</span>
            </div>
          </div>
          <div class="jfs-fe-pgroup-label">动效</div>
        </div>
        <div class="jfs-fe-pgroup-sep" />
        {/* Crop group */}
        <div class="jfs-fe-pgroup">
          <div class="jfs-fe-pgroup-body" style={{ justifyContent: 'center', alignItems: 'center', flex: '1' }}>
            <button
              class={`jfs-fe-btn${st.cropRect ? ' p' : ''}`}
              onClick={() => openCropPopover()}
              title={st.cropRect ? '已裁切 (点击修改)' : '设置裁切区域'}
              style={{ padding: '5px', width: '30px', height: '30px', fontSize: '0' }}
              dangerouslySetInnerHTML={{ __html: ICON_CROP }}
            />
          </div>
          <div class="jfs-fe-pgroup-label">裁切</div>
        </div>
        <div class="jfs-fe-pgroup-sep" />
      </>}
      {/* Quality group */}
      <div class="jfs-fe-pgroup">
        <div class="jfs-fe-pgroup-body">
          <label class="jfs-fe-lbl">
            <input type="checkbox" checked={isLossless} onChange={handleLosslessChange} style={{ cursor: 'pointer' }} />
            无损
          </label>
          <select class="jfs-fe-sel" disabled={isLossless} value={String(qualVal)} onChange={handleQualityChange}>
            {qualityOptions.map(o => (
              <option key={o.v} value={String(o.v)}>{o.label}</option>
            ))}
          </select>
        </div>
        <div class="jfs-fe-pgroup-label">质量</div>
      </div>
    </div>
  )
}

function GridPage() {
  const frames = sFrames.value
  const exportType = sExportType.value
  const st = sSettings.value
  const paramsOpen = sParamsOpen.value

  const visible = frames.filter(f => !f.removed)
  const selectedCount = visible.filter(f => f.selected).length
  const allSel = visible.length > 0 && selectedCount === visible.length
  const removedCount = frames.filter(f => f.removed).length
  const isMobile = window.innerWidth < 600

  const dur = _videoEl?.duration ?? 0
  const maxMs = (isFinite(dur) && dur > 0) ? dur * 1000 : 0
  const atStart = _frameIndex ? _fiMinIdx <= 0 : _minPosMs <= 0
  const atEnd = _frameIndex
    ? _fiMaxIdx >= (_frameIndex.length - 1)
    : (maxMs > 0 && _maxPosMs >= maxMs - frameInterval())

  const prefTotal = sPrefetchTotal.value
  const prefDone = sPrefetchDone.value
  const countLabel = prefTotal > 0 && prefDone < prefTotal
    ? `${t('frameExport.loading')} ${prefDone}/${prefTotal}`
    : `${isMobile ? '' : t('frameExport.selected') + ' '}${selectedCount}/${visible.length}`

  function handleSelectAll(): void {
    const shouldSelectAll = !visible.every(f => f.selected)
    visible.forEach(f => { f.selected = shouldSelectAll })
    renderGrid()
  }

  function handleRestore(): void {
    _frames.forEach(f => { if (f.removed) { f.removed = false; f.selected = true } })
    renderGrid()
  }

  function handleSparseChange(e: Event): void {
    const n = parseInt((e.target as HTMLSelectElement).value) || 0
    if (n <= 0) return
    _frames.forEach((f, i) => { if (!f.removed) f.selected = i % n === 0 });
    (e.target as HTMLSelectElement).value = '0'
    renderGrid()
  }

  function handleFormatChange(e: Event): void {
    const val = (e.target as HTMLSelectElement).value
    if (exportType === 'animate') updateSettings({ animateFormat: val as 'gif' | 'webp' })
    else updateSettings({ stitchFormat: val as 'png' | 'webp' })
  }

  const fmt = exportType === 'animate' ? st.animateFormat : st.stitchFormat
  const formatOpts = exportType === 'animate' ? ['gif', 'webp'] : ['png', 'webp']

  return (
    <div class="jfs-fe-osd">
      <FrameGrid />
      {paramsOpen && <ParamsPanel />}
      <div class="jfs-fe-row sep-t" id="jfs-fe-tbar">
        <span class="jfs-fe-title">剪辑工坊</span>
        <div class="jfs-fe-seg">
          <button
            class={`jfs-fe-seg-btn${exportType === 'animate' ? ' active' : ''}`}
            onClick={() => { sExportType.value = 'animate' }}
          >动画</button>
          <button
            class={`jfs-fe-seg-btn${exportType === 'stitch' ? ' active' : ''}`}
            onClick={() => { sExportType.value = 'stitch' }}
          >全景图</button>
        </div>
        <select class="jfs-fe-sel" value={fmt} onChange={handleFormatChange}>
          {formatOpts.map(o => (
            <option key={o} value={o}>{o.toUpperCase()}</option>
          ))}
        </select>
        <select class="jfs-fe-sel" title="稀疏选择" style={{ minWidth: '0' }} onChange={handleSparseChange}>
          <option value="0">稀疏▾</option>
          <option value="1">全</option>
          <option value="2">½</option>
          <option value="3">⅓</option>
          <option value="4">¼</option>
        </select>
        <button
          class={`jfs-fe-btn g`}
          onClick={() => { sParamsOpen.value = !sParamsOpen.value }}
        >{paramsOpen ? '参数 ▾' : '参数 ▴'}</button>
        <span class="jfs-fe-tbar-break" />
        <div class="jfs-fe-spacer" />
        <span class="jfs-fe-muted">
          {countLabel}
          <button class="jfs-fe-btn g" style={{ fontSize: '11px', padding: '2px 7px', marginLeft: '4px' }} onClick={handleSelectAll}>
            {allSel ? t('frameExport.deselectAll') : t('frameExport.selectAll')}
          </button>
          {removedCount > 0 && (
            <button
              class="jfs-fe-btn"
              style={{ fontSize: '11px', padding: '2px 7px', marginLeft: '4px', background: 'rgba(239,68,68,0.75)' }}
              onClick={handleRestore}
            >还原 {removedCount} 帧</button>
          )}
        </span>
        <button id="jfs-fe-prev" class="jfs-fe-btn" disabled={atStart} onClick={() => expandFrames(-1)}>
          {atStart ? t('frameExport.atStart') : t('frameExport.loadPrev')}
        </button>
        <button id="jfs-fe-next" class="jfs-fe-btn" disabled={atEnd} onClick={() => expandFrames(1)}>
          {atEnd ? t('frameExport.atEnd') : t('frameExport.loadNext')}
        </button>
        <button class="jfs-fe-btn p" onClick={submitGenerate}>
          {exportType === 'animate' ? '生成动画' : '导出全景图'}
        </button>
        <button class="jfs-fe-btn g" style={{ padding: '2px 8px', fontSize: '16px' }} onClick={closeModal}>✕</button>
      </div>
    </div>
  )
}

function ProgressPage() {
  const taskId = sProgressTaskId.value
  const [pct, setPct] = useState(0)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const indicatorAcRef = useRef<AbortController | null>(null)

  function hideIndicator(): void {
    indicatorAcRef.current?.abort()
    indicatorAcRef.current = null
    const ind = document.getElementById('jfs-enhancer-prog-indicator')
    if (ind) ind.style.display = 'none'
    if (_modalRoot) _modalRoot.style.display = ''
  }

  useEffect(() => {
    let retries = 0
    const evSrc = new EventSource(
      `${getBaseUrl()}/JellyfinSuite/FrameExport/Progress?taskId=${encodeURIComponent(taskId)}&api_key=${encodeURIComponent(getToken())}`
    )

    evSrc.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as TaskProgressEvent
        setPct(data.percent)
        const ind = document.getElementById('jfs-enhancer-prog-indicator')
        if (ind && ind.style.display !== 'none') ind.textContent = `${Math.round(data.percent)}%`
        if (data.status === 'complete' && data.resultUrl) {
          evSrc.close()
          hideIndicator()
          showResultPage(data.resultUrl, data.fileSize ?? 0)
        } else if (data.status === 'error') {
          evSrc.close()
          hideIndicator()
          setErrorMsg(data.error ?? '生成失败')
        } else if (data.status === 'cancelled') {
          evSrc.close()
          hideIndicator()
          closeModal()
        }
      } catch { /* ignore */ }
    }

    evSrc.onerror = () => {
      if (retries++ < 3) return
      evSrc.close()
      hideIndicator()
      setErrorMsg('连接中断，请重试')
    }

    return () => { evSrc.close() }
  }, [taskId])

  function handleMinimize(): void {
    if (!_modalRoot) return
    _modalRoot.style.display = 'none'
    setGesturesSuspended(false)
    const ind = document.getElementById('jfs-enhancer-prog-indicator')
    if (ind) {
      ind.textContent = `${Math.round(pct)}%`
      ind.style.display = ''
      const ac = new AbortController()
      indicatorAcRef.current = ac
      ind.addEventListener('click', () => {
        ac.abort()
        indicatorAcRef.current = null
        ind.style.display = 'none'
        if (_modalRoot) _modalRoot.style.display = ''
        setGesturesSuspended(true)
      }, { signal: ac.signal })
    }
  }

  function handleCancel(): void {
    fetch(
      `${getBaseUrl()}/JellyfinSuite/FrameExport/Cancel/${taskId}?api_key=${encodeURIComponent(getToken())}`,
      { method: 'POST' }
    ).catch(() => {})
    closeModal()
  }

  return (
    <div class="jfs-fe-osd" style={{ minWidth: '480px', maxWidth: '640px', margin: '0 auto', height: 'auto' }}>
      <div class="jfs-fe-row sep-b">
        <span class="jfs-fe-title">生成中</span>
        <div class="jfs-fe-spacer" />
        <button class="jfs-fe-btn g" style={{ padding: '2px 8px', fontSize: '15px', lineHeight: '1' }} title="最小化到控制栏" onClick={handleMinimize}>−</button>
        <button class="jfs-fe-btn" onClick={handleCancel}>{errorMsg ? '关闭' : '取消'}</button>
      </div>
      <div style={{ padding: '16px 16px 20px' }}>
        <div class="jfs-fe-progress">
          <div
            class="jfs-fe-bar"
            style={{ width: `${errorMsg ? 100 : pct}%`, background: errorMsg ? 'rgba(239,68,68,0.8)' : undefined }}
          />
          <span class="jfs-fe-progress-label">
            {errorMsg ? errorMsg.substring(0, 40) : `${Math.round(pct)}%`}
          </span>
        </div>
      </div>
    </div>
  )
}

function ResultPage() {
  const resultUrl = sResultUrl.value
  const fileSize = sFileSize.value
  const [rotation, setRotation] = useState(0)

  const fullUrl = resultUrl.startsWith('http')
    ? resultUrl
    : `${getBaseUrl()}${resultUrl}?api_key=${encodeURIComponent(getToken())}`
  const sizeStr = fileSize > 1024 * 1024
    ? `${(fileSize / 1024 / 1024).toFixed(1)} MB`
    : `${(fileSize / 1024).toFixed(0)} KB`

  function handleDelete(): void {
    fetch(
      `${getBaseUrl()}/JellyfinSuite/FrameExport/Result/${_activeTaskId}?api_key=${encodeURIComponent(getToken())}`,
      { method: 'DELETE' }
    ).catch(() => {})
    sPage.value = 'grid'
  }

  function handleDownload(): void {
    const ext = resultUrl.split('.').pop() ?? 'bin'
    const prefix = sExportType.value === 'animate' ? 'jellyfin-animate' : 'jellyfin-stitch'
    const dlTitle = document.title.replace(/\s*[-|]\s*Jellyfin\s*$/i, '').trim() || 'export'
    const sel = _frames.filter(f => f.selected)
    const ts1 = formatTime(sel[0]?.posMs ?? 0).replace(/[:.]/g, '-')
    const ts2 = formatTime(sel[sel.length - 1]?.posMs ?? 0).replace(/[:.]/g, '-')
    const a = document.createElement('a')
    a.href = fullUrl
    a.download = `${prefix}-${dlTitle}-${ts1}-to-${ts2}.${ext}`
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
  }

  return (
    <div class="jfs-fe-osd" style={{ maxWidth: '640px', margin: '0 auto', height: 'auto' }}>
      <div class="jfs-fe-row sep-b">
        <button class="jfs-fe-btn g" style={{ flex: '0 0 auto' }} onClick={() => { sPage.value = 'grid' }}>← 返回</button>
        <div style={{ flex: '1' }} />
        <span class="jfs-fe-title">预览 · {sizeStr}</span>
        <div style={{ flex: '1' }} />
        <button class="jfs-fe-btn g" style={{ flex: '0 0 auto', padding: '2px 8px', fontSize: '16px' }} onClick={closeModal}>✕</button>
      </div>
      <div style={{ overflow: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '12px', background: 'rgba(0,0,0,0.3)' }}>
        <img
          src={fullUrl}
          style={{
            maxWidth: '100%',
            maxHeight: '36vh',
            objectFit: 'contain',
            borderRadius: '6px',
            boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
            transition: 'transform 0.15s',
            transform: `rotate(${rotation}deg)`,
          }}
          alt="result"
        />
      </div>
      <div class="jfs-fe-row sep-t" style={{ flexWrap: 'wrap', gap: '6px' }}>
        <button class="jfs-fe-btn g" onClick={() => setRotation(r => r - 5)} dangerouslySetInnerHTML={{ __html: ICON_CCW + ' 5°' }} />
        <button class="jfs-fe-btn g" onClick={() => setRotation(r => r - 1)} dangerouslySetInnerHTML={{ __html: ICON_CCW + ' 1°' }} />
        <span class="jfs-fe-muted" style={{ minWidth: '28px', textAlign: 'center' }}>{rotation}°</span>
        <button class="jfs-fe-btn g" onClick={() => setRotation(r => r + 1)} dangerouslySetInnerHTML={{ __html: '1° ' + ICON_CW }} />
        <button class="jfs-fe-btn g" onClick={() => setRotation(r => r + 5)} dangerouslySetInnerHTML={{ __html: '5° ' + ICON_CW }} />
        <div class="jfs-fe-spacer" />
        <button class="jfs-fe-btn p" onClick={handleDownload}>下载</button>
        <button class="jfs-fe-btn" onClick={handleDelete}>删除</button>
      </div>
    </div>
  )
}

function FrameExportModal() {
  const page = sPage.value
  if (page === 'progress') return <ProgressPage />
  if (page === 'result') return <ResultPage />
  return <GridPage />
}

// ── Public API ────────────────────────────────────────────────────────────────

export function openFrameExportModal(videoEl: HTMLVideoElement, itemId: string): void {
  _videoEl = videoEl
  if (itemId !== _itemId) _frameIndex = null  // new item — discard cached index
  _itemId = itemId
  _activeTaskId = ''

  videoEl.pause()

  document.body.classList.add('jfs-fe-open')
  setGesturesSuspended(true)

  _modalRoot = document.createElement('div')
  Object.assign(_modalRoot.style, {
    position: 'fixed',
    bottom: '12px',
    left: '50%',
    transform: 'translateX(-50%)',
    width: 'min(92vw, 960px)',
    zIndex: '99999',
    display: 'flex',
    flexDirection: 'column',
    boxSizing: 'border-box',
    fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
    pointerEvents: 'none',
  })

  _modalRoot.addEventListener('wheel', (e) => { e.stopPropagation() }, { passive: true })
  document.addEventListener('keydown', escHandler, { capture: true })
  document.body.appendChild(_modalRoot)
  _dragController = makeDraggable(_modalRoot)
  document.addEventListener('mouseup', () => { _dragMode = false }, { signal: _dragController.signal })

  _domObserver = new MutationObserver(() => {
    if (!_videoEl?.isConnected) closeModal()
  })
  _domObserver.observe(document.body, { childList: true, subtree: true })

  // Restore previous state if same item and playback position is still within the loaded range
  const currentMs = Math.round(videoEl.currentTime * 1000)
  if (
    _savedState &&
    _savedState.itemId === itemId &&
    currentMs >= _savedState.minPosMs - 2000 &&
    currentMs <= _savedState.maxPosMs + 2000
  ) {
    _frames = _savedState.frames.map(f => ({ ...f }))
    sExportType.value = _savedState.exportType
    _minPosMs = _savedState.minPosMs
    _maxPosMs = _savedState.maxPosMs
    _fpsFrac = _savedState.fpsFrac
    _lastClickedIdx = _savedState.lastClickedIdx
    _fiMinIdx = _savedState.fiMinIdx
    _fiMaxIdx = _savedState.fiMaxIdx
    sPrefetchTotal.value = 0
    sPrefetchDone.value = 0
    sPage.value = 'grid'
    render(<FrameExportModal />, _modalRoot)
    renderGrid()
    return
  }

  _frames = []
  sPage.value = 'grid'
  render(<FrameExportModal />, _modalRoot)
  loadInitialFrames()
}

export function closeModal(): void {
  stopAutoScroll()
  // Revoke all blob URLs before clearing frames
  _frames.forEach(f => { if (f.blobUrl) { URL.revokeObjectURL(f.blobUrl); f.blobUrl = undefined } })

  if (_itemId && _frames.length > 0) {
    _savedState = {
      itemId: _itemId,
      // blobUrl is a browser resource — exclude from saved state
      frames: _frames.map(({ blobUrl: _b, ...rest }) => rest),
      exportType: sExportType.value,
      minPosMs: _minPosMs,
      maxPosMs: _maxPosMs,
      fpsFrac: { ..._fpsFrac },
      lastClickedIdx: _lastClickedIdx,
      fiMinIdx: _fiMinIdx,
      fiMaxIdx: _fiMaxIdx,
    }
  }

  document.removeEventListener('keydown', escHandler, true)
  _dragController?.abort()
  _dragController = null
  _domObserver?.disconnect()
  _domObserver = null
  document.body.classList.remove('jfs-fe-open')
  setGesturesSuspended(false)
  if (_modalRoot) {
    render(null, _modalRoot)
    _modalRoot.remove()
    _modalRoot = null
  }
  _lastClickedIdx = -1
  _dragMode = false
}

export function showProgressPage(taskId: string): void {
  _activeTaskId = taskId
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
  sFileSize.value = fileSize
  sPage.value = 'result'
}
