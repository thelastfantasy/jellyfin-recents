// ── Frame Export OSD Panel — Grid (US1-3), Progress (US7), Result (US7) ──

import { setGesturesSuspended } from './gestures'
import { t } from './i18n'
import type { components } from './jellyfin-api'
import type { TaskProgressEvent } from './api-types'

type GenerateResponse = components['schemas']['GenerateResponse']

let _modalRoot: HTMLDivElement | null = null
let _dragController: AbortController | null = null
let _domObserver: MutationObserver | null = null
let _videoEl: HTMLVideoElement | null = null
let _itemId = ''
let _activeTaskId = ''
let _exportType: 'animate' | 'stitch' = 'animate'

// State
let _frames: FrameEntry[] = []
let _minPosMs = 0
let _maxPosMs = 0
interface FpsFrac { num: number; den: number }
let _fpsFrac: FpsFrac = { num: 24, den: 1 }
let _prefetchTotal = 0
let _prefetchDone = 0
let _lastClickedIdx = -1
let _dragMode = false
let _dragSelectValue = false
let _longPressTimer: ReturnType<typeof setTimeout> | null = null
let _longPressCard: HTMLElement | null = null
let _suppressNextMousedown = false
let _autoScrollRaf: number | null = null
let _lastTouchX = 0
let _lastTouchY = 0

// Cached state for modal restore (survives close/reopen if same item + position)
interface SavedModalState {
  itemId: string
  frames: FrameEntry[]
  exportType: 'animate' | 'stitch'
  minPosMs: number
  maxPosMs: number
  fpsFrac: FpsFrac
  lastClickedIdx: number
}
let _savedState: SavedModalState | null = null

// ── Settings (localStorage) ─────────────────────────────────────────────────
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

function loadSettings(): ExportSettings {
  try {
    const raw = localStorage.getItem('jfs-frameexport-settings')
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch { /* ignore */ }
  return { ...DEFAULT_SETTINGS }
}

function saveSettings(s: ExportSettings): void {
  try { localStorage.setItem('jfs-frameexport-settings', JSON.stringify(s)) } catch { /* ignore */ }
}

let _settings = loadSettings()
let _paramsOpen = false

interface FrameEntry {
  posMs: number
  selected: boolean
  jpegUrl: string
  isJunk: boolean
  junkReason: string | null
  loadError?: boolean
  removed?: boolean
}

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

function frameInterval(): number {
  return _fpsFrac.den * 1000 / _fpsFrac.num
}

function frameToMs(idx: number): number {
  return Math.round(idx * _fpsFrac.den * 1000 / _fpsFrac.num)
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


function escHandler(e: KeyboardEvent): void {
  // Capture phase — stop all keyboard events from reaching the Jellyfin player
  e.stopPropagation()
  if (e.key === 'Escape') closeModal()
}

// ── Public API ──────────────────────────────────────────────────────────────

export function openFrameExportModal(videoEl: HTMLVideoElement, itemId: string): void {
  _videoEl = videoEl
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
    _exportType = _savedState.exportType
    _minPosMs = _savedState.minPosMs
    _maxPosMs = _savedState.maxPosMs
    _fpsFrac = _savedState.fpsFrac
    _lastClickedIdx = _savedState.lastClickedIdx
    _prefetchTotal = 0
    _prefetchDone = 0
    showGridPage()
    renderGrid()
    return
  }

  _frames = []
  showGridPage()
  loadInitialFrames()
}

function stopAutoScroll(): void {
  if (_autoScrollRaf !== null) { cancelAnimationFrame(_autoScrollRaf); _autoScrollRaf = null }
}

function applyDragToPoint(x: number, y: number): void {
  const el = document.elementFromPoint(x, y) as HTMLElement | null
  const card = el?.closest<HTMLElement>('.jfs-fe-card')
  if (!card) return
  const idx = parseInt(card.dataset.idx ?? '')
  if (isNaN(idx) || !_frames[idx] || _frames[idx].selected === _dragSelectValue) return
  _frames[idx].selected = _dragSelectValue
  card.classList.toggle('sel', _dragSelectValue)
  const cb = card.querySelector<HTMLInputElement>('.jfs-fe-cb')
  if (cb) cb.checked = _dragSelectValue
  updateCount()
}

function closeModal(): void {
  stopAutoScroll()
  // Save state before closing so it can be restored on reopen
  if (_itemId && _frames.length > 0) {
    _savedState = {
      itemId: _itemId,
      frames: _frames.map(f => ({ ...f })),
      exportType: _exportType,
      minPosMs: _minPosMs,
      maxPosMs: _maxPosMs,
      fpsFrac: { ..._fpsFrac },
      lastClickedIdx: _lastClickedIdx,
    }
  }

  document.removeEventListener('keydown', escHandler, true)
  _dragController?.abort()
  _dragController = null
  _domObserver?.disconnect()
  _domObserver = null
  document.body.classList.remove('jfs-fe-open')
  setGesturesSuspended(false)
  _modalRoot?.remove()
  _modalRoot = null
  _lastClickedIdx = -1
  _dragMode = false
}

// ── Grid Page ───────────────────────────────────────────────────────────────

function formatOptions(): string {
  const isAnim = _exportType === 'animate'
  const fmt = isAnim ? _settings.animateFormat : _settings.stitchFormat
  return (isAnim ? ['gif', 'webp'] : ['png', 'webp'])
    .map(o => `<option value="${o}"${fmt === o ? ' selected' : ''}>${o.toUpperCase()}</option>`)
    .join('')
}

function showGridPage(): void {
  if (!_modalRoot) return

  _modalRoot.innerHTML = `
    <div class="jfs-fe-osd">
      <div class="jfs-fe-scroll">
        <div id="jfs-fe-grid" class="jfs-fe-grid"></div>
      </div>
      ${renderParamsPanel()}
      <div class="jfs-fe-row sep-t" id="jfs-fe-tbar">
        <span class="jfs-fe-title">剪辑工坊</span>
        <div class="jfs-fe-seg">
          <button class="jfs-fe-seg-btn${_exportType === 'animate' ? ' active' : ''}" data-type="animate">动画</button>
          <button class="jfs-fe-seg-btn${_exportType === 'stitch' ? ' active' : ''}" data-type="stitch">全景图</button>
        </div>
        <select id="jfs-fe-format" class="jfs-fe-sel">${formatOptions()}</select>
        <select id="jfs-fe-sparse" class="jfs-fe-sel" title="稀疏选择" style="min-width:0">
          <option value="0">稀疏▾</option>
          <option value="1">全</option>
          <option value="2">½</option>
          <option value="3">⅓</option>
          <option value="4">¼</option>
        </select>
        <button id="jfs-fe-params-toggle" class="jfs-fe-btn g">参数 ▴</button>
        <span class="jfs-fe-tbar-break"></span>
        <div class="jfs-fe-spacer"></div>
        <span id="jfs-fe-count" class="jfs-fe-muted">${t('frameExport.loading')}...</span>
        <button id="jfs-fe-prev" class="jfs-fe-btn">${t('frameExport.loadPrev')}</button>
        <button id="jfs-fe-next" class="jfs-fe-btn">${t('frameExport.loadNext')}</button>
        <button id="jfs-fe-generate" class="jfs-fe-btn p">${_exportType === 'animate' ? '生成动画' : '导出全景图'}</button>
        <button id="jfs-fe-close" class="jfs-fe-btn g" style="padding:2px 8px;font-size:16px">✕</button>
      </div>
    </div>
  `

  const gridEl = document.getElementById('jfs-fe-grid')
  if (gridEl) wireGridHandlers(gridEl)

  document.getElementById('jfs-fe-close')?.addEventListener('click', closeModal)
  document.getElementById('jfs-fe-prev')?.addEventListener('click', () => expandFrames(-1))
  document.getElementById('jfs-fe-next')?.addEventListener('click', () => expandFrames(1))
  document.getElementById('jfs-fe-generate')?.addEventListener('click', submitGenerate)

  // Segmented control
  _modalRoot.querySelectorAll<HTMLButtonElement>('.jfs-fe-seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.type as 'animate' | 'stitch'
      if (_exportType === t) return
      _exportType = t
      _modalRoot?.querySelectorAll('.jfs-fe-seg-btn').forEach(b => b.classList.toggle('active', b === btn))
      const genBtn = document.getElementById('jfs-fe-generate')
      if (genBtn) genBtn.textContent = t === 'animate' ? '生成动画' : '导出全景图'
      const fmtSel = document.getElementById('jfs-fe-format') as HTMLSelectElement | null
      if (fmtSel) fmtSel.innerHTML = formatOptions()
      refreshParamsUI()
      renderGrid()
    })
  })

  wireParams()
}

function lossyQualityOptions(val: number): string {
  const lossy = val <= 0 ? 0.75 : val
  return [
    { v: 0.85, label: '高质量 85%' },
    { v: 0.75, label: '标准 75%' },
    { v: 0.60, label: '普通 60%' },
  ].map(o => `<option value="${o.v}"${lossy === o.v ? ' selected' : ''}>${o.label}</option>`).join('')
}

function renderParamsPanel(): string {
  const isAnim = _exportType === 'animate'
  const presets = ['original', '1080p', '720p', '480p', '360p']
  const resOptions = presets
    .map(p => `<option value="${p}"${_settings.resolutionPreset === p ? ' selected' : ''}>${p === 'original' ? '原始' : p}</option>`)
    .join('')
  const curQuality = isAnim ? _settings.animateQuality : _settings.stitchQuality

  if (!_paramsOpen) return ''

  return `
    <div id="jfs-fe-params" class="jfs-fe-pbar dark-bg sep-b">
      ${isAnim ? `
      <div class="jfs-fe-pgroup">
        <div class="jfs-fe-pgroup-body">
          <label class="jfs-fe-lbl" style="gap:5px;white-space:nowrap">
            <span class="jfs-fe-muted" style="font-size:11px">预设</span>
            <input type="checkbox" id="jfs-fe-custom-toggle" class="jfs-fe-toggle-chk" ${_settings.useCustomResolution ? 'checked' : ''} />
            <span class="jfs-fe-toggle-track"></span>
            <span class="jfs-fe-muted" style="font-size:11px">自定义</span>
          </label>
          ${!_settings.useCustomResolution ? `
          <select id="jfs-fe-preset" class="jfs-fe-sel">${resOptions}</select>
          ` : `
          <div style="display:flex;align-items:center;gap:4px">
            <span class="jfs-fe-muted" style="width:16px">宽</span>
            <input id="jfs-fe-cw" type="number" value="${_settings.customWidth || ''}" placeholder="px" class="jfs-fe-inp" style="width:56px" />
          </div>
          <div style="display:flex;align-items:center;gap:4px">
            <span class="jfs-fe-muted" style="width:16px">高</span>
            <input id="jfs-fe-ch" type="number" value="${_settings.customHeight || ''}" placeholder="auto" class="jfs-fe-inp" style="width:56px" />
          </div>
          `}
        </div>
        <div class="jfs-fe-pgroup-label">分辨率</div>
      </div>
      <div class="jfs-fe-pgroup-sep"></div>
      <div class="jfs-fe-pgroup">
        <div class="jfs-fe-pgroup-body">
          <div style="display:flex;align-items:center;gap:4px">
            <span class="jfs-fe-muted" style="width:28px">倍速</span>
            <select id="jfs-fe-speed" class="jfs-fe-sel">
              ${[0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4].map(v =>
                `<option value="${v}"${_settings.speed === v ? ' selected' : ''}>${v}x</option>`
              ).join('')}
            </select>
          </div>
          <div style="display:flex;align-items:center;gap:4px">
            <span class="jfs-fe-muted" style="width:28px">循环</span>
            <input id="jfs-fe-loop" type="number" min="0" max="99" value="${_settings.loopCount}" class="jfs-fe-inp" style="width:44px" />
            <span class="jfs-fe-muted">(0=∞)</span>
          </div>
        </div>
        <div class="jfs-fe-pgroup-label">动效</div>
      </div>
      <div class="jfs-fe-pgroup-sep"></div>
      <div class="jfs-fe-pgroup">
        <div class="jfs-fe-pgroup-body" style="justify-content:center;align-items:center;flex:1">
          <button id="jfs-fe-crop-open" class="jfs-fe-btn${_settings.cropRect ? ' p' : ''}" style="padding:5px;width:30px;height:30px;font-size:0" title="${_settings.cropRect ? '已裁切 (点击修改)' : '设置裁切区域'}">${ICON_CROP}</button>
        </div>
        <div class="jfs-fe-pgroup-label">裁切</div>
      </div>
      <div class="jfs-fe-pgroup-sep"></div>
      ` : ''}
      <div class="jfs-fe-pgroup">
        <div class="jfs-fe-pgroup-body">
          <label class="jfs-fe-lbl">
            <input type="checkbox" id="jfs-fe-lossless" ${curQuality <= 0 ? 'checked' : ''} style="cursor:pointer" />
            无损
          </label>
          <select id="jfs-fe-quality" class="jfs-fe-sel"${curQuality <= 0 ? ' disabled' : ''}>${lossyQualityOptions(curQuality)}</select>
        </div>
        <div class="jfs-fe-pgroup-label">质量</div>
      </div>
    </div>
  `
}

function refreshParamsUI(): void {
  const existing = document.getElementById('jfs-fe-params')
  const newHtml = renderParamsPanel()
  if (existing) {
    if (newHtml) {
      const tmp = document.createElement('div')
      tmp.innerHTML = newHtml
      existing.replaceWith(tmp.firstElementChild!)
    } else {
      existing.remove()
    }
    wireParamsPanel()
  }
}

function wireParams(): void {
  document.getElementById('jfs-fe-params-toggle')?.addEventListener('click', () => {
    _paramsOpen = !_paramsOpen
    const toggleBtn = document.getElementById('jfs-fe-params-toggle')
    if (toggleBtn) toggleBtn.textContent = _paramsOpen ? '参数 ▾' : '参数 ▴'
    if (_paramsOpen) {
      const tmp = document.createElement('div')
      tmp.innerHTML = renderParamsPanel()
      const newEl = tmp.firstElementChild as HTMLElement
      document.getElementById('jfs-fe-tbar')?.before(newEl)
      wireParamsPanel()
    } else {
      document.getElementById('jfs-fe-params')?.remove()
    }
  })
  document.getElementById('jfs-fe-format')?.addEventListener('change', (e) => {
    if (_exportType === 'animate') _settings.animateFormat = (e.target as HTMLSelectElement).value as 'gif' | 'webp'
    else _settings.stitchFormat = (e.target as HTMLSelectElement).value as 'png' | 'webp'
    saveSettings(_settings)
  })
  document.getElementById('jfs-fe-sparse')?.addEventListener('change', (e) => {
    const n = parseInt((e.target as HTMLSelectElement).value) || 0
    if (n <= 0) return
    _frames.forEach((f, i) => { if (!f.removed) f.selected = i % n === 0 })
    ;(e.target as HTMLSelectElement).value = '0'
    renderGrid()
  })
}

function wireParamsPanel(): void {
  document.getElementById('jfs-fe-custom-toggle')?.addEventListener('change', (e) => {
    _settings.useCustomResolution = (e.target as HTMLInputElement).checked
    if (!_settings.useCustomResolution) {
      _settings.customWidth = 0; _settings.customHeight = 0
    } else {
      _settings.resolutionPreset = 'original'
    }
    saveSettings(_settings); refreshParamsUI()
  })
  document.getElementById('jfs-fe-preset')?.addEventListener('change', (e) => {
    _settings.resolutionPreset = (e.target as HTMLSelectElement).value
    if (_settings.resolutionPreset !== 'original') {
      _settings.resizeMode = 'width'; _settings.customWidth = 0; _settings.customHeight = 0
    }
    saveSettings(_settings)
  })
  document.getElementById('jfs-fe-crop-open')?.addEventListener('click', () => openCropPopover())
  document.getElementById('jfs-fe-cw')?.addEventListener('input', (e) => {
    const v = parseInt((e.target as HTMLInputElement).value) || 0
    _settings.customWidth = v
    _settings.resizeMode = 'width'
    _settings.resolutionPreset = 'original'
    const chEl = document.getElementById('jfs-fe-ch') as HTMLInputElement | null
    const preEl = document.getElementById('jfs-fe-preset') as HTMLSelectElement | null
    const clearBtn = document.getElementById('jfs-fe-preset-clear') as HTMLButtonElement | null
    if (v > 0 && _videoEl) {
      const cr = _settings.cropRect
      const hRatio = cr
        ? (cr.h * (_videoEl.videoHeight || 1)) / (cr.w * (_videoEl.videoWidth || 1))
        : (_videoEl.videoHeight || 1) / (_videoEl.videoWidth || 1)
      _settings.customHeight = Math.round(v * hRatio)
      if (chEl) chEl.value = String(_settings.customHeight)
    } else {
      _settings.customHeight = 0
      if (chEl) chEl.value = ''
    }
    if (preEl) { preEl.value = 'original'; preEl.disabled = v > 0 }
    if (clearBtn) { clearBtn.style.visibility = v > 0 ? '' : 'hidden'; clearBtn.style.pointerEvents = v > 0 ? '' : 'none' }
    saveSettings(_settings)
  })
  document.getElementById('jfs-fe-ch')?.addEventListener('input', (e) => {
    const v = parseInt((e.target as HTMLInputElement).value) || 0
    _settings.customHeight = v
    _settings.resizeMode = 'height'
    _settings.resolutionPreset = 'original'
    const cwEl = document.getElementById('jfs-fe-cw') as HTMLInputElement | null
    const preEl = document.getElementById('jfs-fe-preset') as HTMLSelectElement | null
    const clearBtn = document.getElementById('jfs-fe-preset-clear') as HTMLButtonElement | null
    if (v > 0 && _videoEl) {
      const cr = _settings.cropRect
      const wRatio = cr
        ? (cr.w * (_videoEl.videoWidth || 1)) / (cr.h * (_videoEl.videoHeight || 1))
        : (_videoEl.videoWidth || 1) / (_videoEl.videoHeight || 1)
      _settings.customWidth = Math.round(v * wRatio)
      if (cwEl) cwEl.value = String(_settings.customWidth)
    } else {
      _settings.customWidth = 0
      if (cwEl) cwEl.value = ''
    }
    if (preEl) { preEl.value = 'original'; preEl.disabled = v > 0 }
    if (clearBtn) { clearBtn.style.visibility = v > 0 ? '' : 'hidden'; clearBtn.style.pointerEvents = v > 0 ? '' : 'none' }
    saveSettings(_settings)
  })
  // Block player keyboard & wheel shortcuts from number/select inputs
  ;['jfs-fe-cw', 'jfs-fe-ch', 'jfs-fe-loop'].forEach(id => {
    const el = document.getElementById(id)
    if (!el) return
    el.addEventListener('keydown', (ev) => ev.stopPropagation())
    el.addEventListener('wheel', (ev) => ev.stopPropagation(), { passive: true })
  })
  document.getElementById('jfs-fe-speed')?.addEventListener('change', (e) => {
    _settings.speed = parseFloat((e.target as HTMLSelectElement).value) || 1.0
    saveSettings(_settings)
  })
  document.getElementById('jfs-fe-loop')?.addEventListener('input', (e) => {
    _settings.loopCount = Math.max(0, Math.min(99, parseInt((e.target as HTMLInputElement).value) || 0))
    saveSettings(_settings)
  })
  document.getElementById('jfs-fe-lossless')?.addEventListener('change', (e) => {
    const checked = (e.target as HTMLInputElement).checked
    const qualSel = document.getElementById('jfs-fe-quality') as HTMLSelectElement | null
    if (_exportType === 'animate') _settings.animateQuality = checked ? 0 : parseFloat(qualSel?.value ?? '0.75') || 0.75
    else _settings.stitchQuality = checked ? 0 : parseFloat(qualSel?.value ?? '0.75') || 0.75
    if (qualSel) qualSel.disabled = checked
    saveSettings(_settings)
  })
  document.getElementById('jfs-fe-quality')?.addEventListener('change', (e) => {
    const v = parseFloat((e.target as HTMLSelectElement).value) || 0.75
    if (_exportType === 'animate') _settings.animateQuality = v
    else _settings.stitchQuality = v
    saveSettings(_settings)
  })
}

async function loadInitialFrames(): Promise<void> {
  if (!_videoEl) return
  const dur = _videoEl.duration
  const durationMs = (isFinite(dur) && dur > 0) ? dur * 1000 : Number.MAX_SAFE_INTEGER
  const centerMs = Math.round(_videoEl.currentTime * 1000)

  _fpsFrac = await fetchVideoFps()
  const startMs = Math.max(0, centerMs - 1000)
  const endMs = Math.min(durationMs, centerMs + 1000)
  const positions = samplePositionsInRange(startMs, endMs)

  _minPosMs = positions[0] ?? centerMs
  _maxPosMs = positions[positions.length - 1] ?? centerMs
  _frames = positions.map(posMs => ({ posMs, selected: true, jpegUrl: '', isJunk: false, junkReason: null }))
  renderGrid()

  await prefetchAndStream(positions, 320)
}

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
    _prefetchTotal = pending.size
    _prefetchDone = 0
    updateCount()

    evSrc.onmessage = (e) => {
      const posMs = parseInt(e.data)
      if (isNaN(posMs) || !pending.delete(posMs)) return

      _prefetchDone = _prefetchTotal - pending.size
      // Update only the card that matches this exact posMs
      for (let i = 0; i < _frames.length; i++) {
        if (_frames[i].posMs === posMs) {
          _frames[i].jpegUrl = frameUrl(_frames[i].posMs, width)
          updateFrameImage(i)
        }
      }
      updateCount()

      if (pending.size === 0) { evSrc.close(); resolve(undefined) }
    }

    evSrc.onerror = () => { evSrc.close(); resolve(undefined) }
  }).then(() => {
    _prefetchTotal = 0
    _prefetchDone = 0
    updateCount()
  })
}

async function expandFrames(direction: number): Promise<void> {
  if (!_videoEl) return
  const dur = _videoEl.duration
  const durationMs = (isFinite(dur) && dur > 0) ? dur * 1000 : Number.MAX_SAFE_INTEGER
  const rangeMs = 1000

  const btn = document.getElementById(direction < 0 ? 'jfs-fe-prev' : 'jfs-fe-next')
  if (btn) btn.setAttribute('disabled', '')

  try {
    let queryStart: number, queryEnd: number
    if (direction < 0) {
      queryEnd = _minPosMs
      queryStart = Math.max(0, _minPosMs - rangeMs)
    } else {
      queryStart = _maxPosMs
      queryEnd = Math.min(durationMs, _maxPosMs + rangeMs)
    }

    const newPositions = samplePositionsInRange(queryStart, queryEnd)

    if (newPositions.length > 0) {
      if (direction < 0) _minPosMs = newPositions[0]
      else _maxPosMs = newPositions[newPositions.length - 1]

      const placeholders: FrameEntry[] = newPositions.map((posMs) => ({
        posMs,
        selected: true,
        jpegUrl: '',
        isJunk: false,
        junkReason: null,
      }))
      if (direction < 0) _frames = [...placeholders, ..._frames]
      else _frames.push(...placeholders)
      renderGrid()

      await prefetchAndStream(newPositions, 320)
    } else {
      // No new frames — advance the boundary anyway so repeated clicks move forward
      if (direction < 0) _minPosMs = queryStart
      else _maxPosMs = queryEnd
    }
  } finally {
    if (btn) btn.removeAttribute('disabled')
    updateExpandButtons()
  }
}


// SVG icons for card actions
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

function openLightbox(startIdx: number): void {
  let currentIdx = startIdx
  const overlay = document.createElement('div')
  overlay.className = 'jfs-fe-lb'

  const render = (): void => {
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
      e.stopPropagation(); if (currentIdx > 0) { currentIdx--; render() }
    })
    overlay.querySelector('.jfs-fe-lb-next')?.addEventListener('click', (e) => {
      e.stopPropagation(); if (currentIdx < _frames.length - 1) { currentIdx++; render() }
    })
  }

  const close = (): void => { overlay.remove(); document.removeEventListener('keydown', kbHandler, true) }
  const kbHandler = (ev: KeyboardEvent): void => {
    ev.stopPropagation()
    if (ev.key === 'Escape') close()
    else if (ev.key === 'ArrowLeft' && currentIdx > 0) { currentIdx--; render() }
    else if (ev.key === 'ArrowRight' && currentIdx < _frames.length - 1) { currentIdx++; render() }
  }
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close() })
  document.addEventListener('keydown', kbHandler, { capture: true })
  render()
  document.body.appendChild(overlay)
}

function makeDraggable(el: HTMLDivElement): AbortController {
  const ac = new AbortController()
  const { signal } = ac
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
  }, { signal })

  document.addEventListener('mousemove', (e: MouseEvent) => {
    if (!dragging) return
    el.style.left = `${Math.max(0, Math.min(window.innerWidth - el.offsetWidth, e.clientX - ox))}px`
    el.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, e.clientY - oy))}px`
  }, { signal })

  document.addEventListener('mouseup', () => {
    if (dragging) { dragging = false; document.body.style.userSelect = '' }
  }, { signal })

  return ac
}

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

function updateFrameImage(idx: number): void {
  const grid = document.getElementById('jfs-fe-grid')
  if (!grid) return
  const f = _frames[idx]
  if (!f?.jpegUrl) return
  const card = grid.querySelector<HTMLElement>(`.jfs-fe-card[data-idx="${idx}"]`)
  if (!card) return
  const placeholder = card.querySelector<HTMLElement>('.jfs-fe-loading, .jfs-fe-err-ph')
  const existing = placeholder ?? card.querySelector<HTMLImageElement>('img[data-img-idx]')
  if (!existing) return
  const img = document.createElement('img')
  img.src = f.jpegUrl
  img.alt = formatTime(f.posMs)
  img.dataset.imgIdx = String(idx)
  existing.replaceWith(img)
  // Error handled by delegated capture listener in wireGridHandlers
}

// Wire all grid-level delegated event listeners — called ONCE from showGridPage().
// renderGrid() only rebuilds innerHTML; listeners survive across grid rebuilds.
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

  // Desktop selection: mousedown is sole handler — no duplicate click toggle
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
    updateCount()
    e.preventDefault()
  }, { passive: false })

  grid.addEventListener('mouseover', (e: MouseEvent) => {
    if (!_dragMode) return
    const card = (e.target as HTMLElement).closest<HTMLElement>('.jfs-fe-card')
    if (!card) return
    const idx = parseInt(card.dataset.idx ?? '')
    if (isNaN(idx) || !_frames[idx] || _frames[idx].selected === _dragSelectValue) return
    _frames[idx].selected = _dragSelectValue
    card.classList.toggle('sel', _dragSelectValue)
    const cb = card.querySelector<HTMLInputElement>('.jfs-fe-cb')
    if (cb) cb.checked = _dragSelectValue
    updateCount()
  })

  // Touch: long-press (400ms) activates drag-select; touchmove drags + auto-scrolls near edges
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
      updateCount()
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
      _suppressNextMousedown = true
      setTimeout(() => { _suppressNextMousedown = false }, 500)
    }
    _dragMode = false
  }
  grid.addEventListener('touchend', endTouch, { passive: true })
  grid.addEventListener('touchcancel', endTouch, { passive: true })

  // Checkbox change (delegated — survives innerHTML rebuild)
  grid.addEventListener('change', (e) => {
    const cb = e.target as HTMLInputElement
    if (!cb.classList.contains('jfs-fe-cb')) return
    e.stopPropagation()
    const idx = parseInt(cb.dataset.idx ?? '')
    if (!isNaN(idx) && _frames[idx]) {
      _frames[idx].selected = cb.checked
      grid.querySelector<HTMLElement>(`.jfs-fe-card[data-idx="${idx}"]`)?.classList.toggle('sel', _frames[idx].selected)
      updateCount()
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

  // Image load errors (delegated via capture — error doesn't bubble)
  grid.addEventListener('error', (e) => {
    const img = e.target as HTMLImageElement
    if (!img.dataset.imgIdx) return
    const idx = parseInt(img.dataset.imgIdx)
    if (!isNaN(idx) && _frames[idx]) {
      _frames[idx].loadError = true
      const errDiv = document.createElement('div')
      errDiv.className = 'jfs-fe-err-ph'
      errDiv.textContent = t('frameExport.loadError')
      img.replaceWith(errDiv)
    }
  }, true)
}

function renderGrid(): void {
  const grid = document.getElementById('jfs-fe-grid')
  if (!grid) return

  grid.innerHTML = _frames
    .map((f, i) => {
      if (f.removed) return ''
      const badge = f.isJunk ? `<span class="jfs-fe-badge">${f.junkReason || '垃圾帧'}</span>` : ''
      const cardClass = `jfs-fe-card${f.selected ? ' sel' : ''}${f.isJunk ? ' junk' : ''}`
      let imgOrErr: string
      if (f.loadError) {
        imgOrErr = `<div class="jfs-fe-err-ph">${t('frameExport.loadError')}</div>`
      } else if (!f.jpegUrl) {
        imgOrErr = `<div class="jfs-fe-loading"><div class="jfs-fe-load-bar"></div></div>`
      } else {
        imgOrErr = `<img src="${f.jpegUrl}" alt="${formatTime(f.posMs)}" data-img-idx="${i}" />`
      }
      return `
        <div class="${cardClass}" data-idx="${i}" style="cursor:pointer">
          ${badge}
          ${imgOrErr}
          <div class="jfs-fe-card-acts">
            <button class="jfs-fe-card-act jfs-fe-view-btn" data-idx="${i}" title="查看大图">${ICON_VIEW}</button>
            <button class="jfs-fe-card-act jfs-fe-dl-btn" data-idx="${i}" title="下载原图">${ICON_DOWNLOAD}</button>
            <button class="jfs-fe-card-act jfs-fe-rm-btn" data-idx="${i}" title="移除此帧">${ICON_TRASH}</button>
          </div>
          <div class="jfs-fe-card-foot">
            <input type="checkbox" ${f.selected ? 'checked' : ''} data-idx="${i}" class="jfs-fe-cb" style="cursor:pointer" />
            ${formatTime(f.posMs)} <span class="jfs-fe-frnum">#${msToFrameIdx(f.posMs)}</span>
          </div>
        </div>`
    })
    .join('')

  updateCount()
  updateExpandButtons()
}

function updateCount(): void {
  const el = document.getElementById('jfs-fe-count')
  if (!el) return
  if (_prefetchTotal > 0 && _prefetchDone < _prefetchTotal) {
    el.innerHTML = `<span class="jfs-fe-muted">${t('frameExport.loading')} ${_prefetchDone}/${_prefetchTotal}</span>`
    const pct = _prefetchDone / _prefetchTotal * 100
    document.querySelectorAll<HTMLElement>('.jfs-fe-load-bar').forEach(bar => { bar.style.width = `${pct}%` })
    return
  }
  document.querySelectorAll<HTMLElement>('.jfs-fe-load-bar').forEach(bar => { bar.style.width = '100%' })
  const visible = _frames.filter(f => !f.removed)
  const selected = visible.filter(f => f.selected).length
  const allSel = selected === visible.length
  const removedCount = _frames.filter(f => f.removed).length
  const isMobile = window.innerWidth < 600
  const restoreBtn = removedCount > 0
    ? `<button id="jfs-fe-restore" class="jfs-fe-btn" style="font-size:11px;padding:2px 7px;margin-left:4px;background:rgba(239,68,68,0.75)">还原 ${removedCount} 帧</button>`
    : ''
  el.innerHTML = `${isMobile ? '' : t('frameExport.selected') + ' '}${selected}/${visible.length}
    <button id="jfs-fe-select-all" class="jfs-fe-btn g" style="font-size:11px;padding:2px 7px;margin-left:4px">${allSel ? t('frameExport.deselectAll') : t('frameExport.selectAll')}</button>${restoreBtn}`
  document.getElementById('jfs-fe-select-all')?.addEventListener('click', () => {
    const shouldSelectAll = !visible.every(f => f.selected)
    visible.forEach(f => { f.selected = shouldSelectAll })
    renderGrid()
  })
  document.getElementById('jfs-fe-restore')?.addEventListener('click', () => {
    _frames.forEach(f => { if (f.removed) { f.removed = false; f.selected = true } })
    renderGrid()
  })
}

function updateExpandButtons(): void {
  const prevBtn = document.getElementById('jfs-fe-prev')
  const nextBtn = document.getElementById('jfs-fe-next')
  const dur = _videoEl?.duration ?? 0
  const maxMs = (isFinite(dur) && dur > 0) ? dur * 1000 : 0
  if (prevBtn) {
    if (_minPosMs <= 0) {
      prevBtn.setAttribute('disabled', ''); prevBtn.textContent = t('frameExport.atStart')
    } else {
      prevBtn.removeAttribute('disabled'); prevBtn.textContent = t('frameExport.loadPrev')
    }
  }
  if (nextBtn) {
    if (maxMs > 0 && _maxPosMs >= maxMs - frameInterval()) {
      nextBtn.setAttribute('disabled', ''); nextBtn.textContent = t('frameExport.atEnd')
    } else {
      nextBtn.removeAttribute('disabled'); nextBtn.textContent = t('frameExport.loadNext')
    }
  }
}

// ── Crop Popover ─────────────────────────────────────────────────────────────

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

  let draft: CropRect = _settings.cropRect ? { ..._settings.cropRect } : { x: 0, y: 0, w: 1, h: 1 }
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
    let targetPx = 0, resizeMode = _settings.resizeMode
    if (_settings.resizeMode === 'height' && _settings.customHeight > 0) {
      targetPx = _settings.customHeight
    } else if (_settings.customWidth > 0) {
      targetPx = _settings.customWidth; resizeMode = 'width'
    } else if (_settings.resolutionPreset !== 'original') {
      const pm: Record<string, number> = { '1080p': 1080, '720p': 720, '480p': 480, '360p': 360 }
      targetPx = pm[_settings.resolutionPreset] ?? 0; resizeMode = 'width'
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

  function applyDrag(clientX: number, clientY: number): void {
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
    applyDrag(e.clientX, e.clientY); e.preventDefault()
  }, { passive: false })

  canvas.addEventListener('pointerup', () => { activeHandle = null; handleStart = null })

  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault()
    const t = e.touches[0]
    const r = canvas.getBoundingClientRect()
    const pos = {
      x: Math.max(0, Math.min(canvas.width,  (t.clientX - r.left) * canvas.width  / r.width)),
      y: Math.max(0, Math.min(canvas.height, (t.clientY - r.top)  * canvas.height / r.height)),
    }
    const type = hitTest(pos.x, pos.y, draft, canvas.width, canvas.height)
    activeHandle = type
    handleStart = { mx: pos.x, my: pos.y, draft0: { ...draft } }
    if (type === 'draw') draft = { x: pos.x / canvas.width, y: pos.y / canvas.height, w: 0.01, h: 0.01 }
  }, { passive: false })

  canvas.addEventListener('touchmove', (e) => {
    e.preventDefault()
    const t = e.touches[0]
    applyDrag(t.clientX, t.clientY)
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
    const changed = JSON.stringify(newCrop) !== JSON.stringify(_settings.cropRect)
    _settings.cropRect = newCrop
    if (changed && (_settings.customWidth > 0 || _settings.customHeight > 0)) {
      const vw = _videoEl?.videoWidth || 1
      const vh = _videoEl?.videoHeight || 1
      if (_settings.resizeMode === 'width' && _settings.customWidth > 0) {
        const hRatio = newCrop ? (newCrop.h * vh) / (newCrop.w * vw) : vh / vw
        _settings.customHeight = Math.round(_settings.customWidth * hRatio)
        showToast('已根据裁切比例自动调整高度')
      } else if (_settings.resizeMode === 'height' && _settings.customHeight > 0) {
        const wRatio = newCrop ? (newCrop.w * vw) / (newCrop.h * vh) : vw / vh
        _settings.customWidth = Math.round(_settings.customHeight * wRatio)
        showToast('已根据裁切比例自动调整宽度')
      }
    }
    saveSettings(_settings)
    overlayEl.remove()
    refreshParamsUI(); wireParamsPanel()
  })

  loadFrame(curIdx)
}

// ── Generate / Progress / Result ────────────────────────────────────────────

async function submitGenerate(): Promise<void> {
  const selected = _frames.filter(f => f.selected && !f.removed)
  if (selected.length < 2) { alert('至少需要选择 2 帧'); return }
  if (selected.length > 240 && !confirm(`选中 ${selected.length} 帧，文件可能较大。继续？`)) return

  const format = _exportType === 'animate' ? _settings.animateFormat : _settings.stitchFormat
  const body = {
    itemId: _itemId,
    itemTitle: document.title.replace(/\s*[-|]\s*Jellyfin\s*$/i, '').trim() || 'export',
    type: _exportType,
    frames: selected.map(f => ({ positionMs: Math.round(f.posMs) })),
    params: {
      format,
      resizeMode: _settings.resizeMode,
      customWidth: _settings.customWidth || null,
      customHeight: _settings.customHeight || null,
      resolutionPreset: _settings.resolutionPreset,
      speed: _settings.speed,
      loopCount: _settings.loopCount,
      cropX: _settings.cropRect?.x ?? 0,
      cropY: _settings.cropRect?.y ?? 0,
      cropW: _settings.cropRect?.w ?? 0,
      cropH: _settings.cropRect?.h ?? 0,
      quality: _exportType === 'animate' ? _settings.animateQuality : _settings.stitchQuality,
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

export function showProgressPage(taskId: string): void {
  _activeTaskId = taskId
  if (!_modalRoot) return
  Object.assign(_modalRoot.style, { bottom: '12px', left: '50%', transform: 'translateX(-50%)' })

  let _minimized = false

  _modalRoot.innerHTML = `
    <div class="jfs-fe-osd" style="min-width:480px;max-width:640px;margin:0 auto;height:auto">
      <div class="jfs-fe-row sep-b">
        <span class="jfs-fe-title">生成中</span>
        <span id="jfs-fe-prog-mini-pct" class="jfs-fe-muted" style="display:none;font-size:11px;margin-left:6px"></span>
        <div class="jfs-fe-spacer"></div>
        <button id="jfs-fe-minimize" class="jfs-fe-btn g" style="padding:2px 8px;font-size:15px;line-height:1" title="最小化">−</button>
        <button id="jfs-fe-cancel" class="jfs-fe-btn">取消</button>
      </div>
      <div id="jfs-fe-prog-body" style="padding:16px 16px 20px">
        <div class="jfs-fe-progress">
          <div id="jfs-fe-progress-bar" class="jfs-fe-bar" style="width:0%"></div>
          <span class="jfs-fe-progress-label" id="jfs-fe-progress-text">0%</span>
        </div>
      </div>
    </div>
  `

  document.getElementById('jfs-fe-minimize')?.addEventListener('click', () => {
    _minimized = !_minimized
    const body    = document.getElementById('jfs-fe-prog-body')
    const miniPct = document.getElementById('jfs-fe-prog-mini-pct')
    const minBtn  = document.getElementById('jfs-fe-minimize')
    if (body)    body.style.display    = _minimized ? 'none' : ''
    if (miniPct) miniPct.style.display = _minimized ? '' : 'none'
    if (minBtn)  minBtn.textContent    = _minimized ? '□' : '−'
  })

  document.getElementById('jfs-fe-cancel')?.addEventListener('click', () => {
    fetch(
      `${getBaseUrl()}/JellyfinSuite/FrameExport/Cancel/${taskId}?api_key=${encodeURIComponent(getToken())}`,
      { method: 'POST' }
    ).catch(() => {})
    closeModal()
  })

  const evSrc = new EventSource(
    `${getBaseUrl()}/JellyfinSuite/FrameExport/Progress?taskId=${encodeURIComponent(taskId)}&api_key=${encodeURIComponent(getToken())}`
  )
  let retries = 0

  evSrc.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data) as TaskProgressEvent
      const bar     = document.getElementById('jfs-fe-progress-bar')
      const text    = document.getElementById('jfs-fe-progress-text')
      const miniPct = document.getElementById('jfs-fe-prog-mini-pct')
      if (bar)     bar.style.width  = `${data.percent}%`
      if (text)    text.textContent = `${Math.round(data.percent)}%`
      if (miniPct) miniPct.textContent = `${Math.round(data.percent)}%`
      if (data.status === 'complete' && data.resultUrl) {
        evSrc.close(); showResultPage(data.resultUrl, data.fileSize ?? 0)
      } else if (data.status === 'error') {
        evSrc.close()
        if (bar) { bar.style.width = '100%'; bar.style.background = 'rgba(239,68,68,0.8)' }
        if (text) text.textContent = data.error ? data.error.substring(0, 40) : '生成失败'
        const cancelBtn = document.getElementById('jfs-fe-cancel')
        if (cancelBtn) cancelBtn.textContent = '关闭'
      }
    } catch { /* ignore */ }
  }

  evSrc.onerror = () => {
    if (retries++ < 3) return
    evSrc.close()
    const text = document.getElementById('jfs-fe-progress-text')
    if (text) text.textContent = '连接中断，请重试'
  }
}

export function showResultPage(resultUrl: string, fileSize: number): void {
  if (!_modalRoot) return
  Object.assign(_modalRoot.style, { bottom: '12px', left: '50%', transform: 'translateX(-50%)' })

  const fullUrl = resultUrl.startsWith('http')
    ? resultUrl
    : `${getBaseUrl()}${resultUrl}?api_key=${encodeURIComponent(getToken())}`
  const sizeStr = fileSize > 1024 * 1024
    ? `${(fileSize / 1024 / 1024).toFixed(1)} MB`
    : `${(fileSize / 1024).toFixed(0)} KB`
  let _rotation = 0

  function updatePreview(): void {
    const img = document.getElementById('jfs-fe-result-img') as HTMLImageElement | null
    if (img) img.style.transform = `rotate(${_rotation}deg)`
    const deg = document.getElementById('jfs-fe-rot-val')
    if (deg) deg.textContent = `${_rotation}°`
  }

  _modalRoot.innerHTML = `
    <div class="jfs-fe-osd" style="max-width:640px;margin:0 auto;height:auto">
      <div class="jfs-fe-row sep-b">
        <button id="jfs-fe-back" class="jfs-fe-btn g" style="flex:0 0 auto">← 返回</button>
        <div style="flex:1"></div>
        <span class="jfs-fe-title">预览 · ${sizeStr}</span>
        <div style="flex:1"></div>
        <button id="jfs-fe-close2" class="jfs-fe-btn g" style="flex:0 0 auto;padding:2px 8px;font-size:16px">✕</button>
      </div>
      <div style="overflow:auto;display:flex;align-items:center;justify-content:center;padding:12px;background:rgba(0,0,0,0.3)">
        <img id="jfs-fe-result-img" src="${fullUrl}"
             style="max-width:100%;max-height:36vh;object-fit:contain;border-radius:6px;box-shadow:0 4px 20px rgba(0,0,0,0.5);transition:transform 0.15s"
             alt="result" />
      </div>
      <div class="jfs-fe-row sep-t" style="flex-wrap:wrap;gap:6px">
        <button id="jfs-fe-rot-l5" class="jfs-fe-btn g">${ICON_CCW} 5°</button>
        <button id="jfs-fe-rot-l1" class="jfs-fe-btn g">${ICON_CCW} 1°</button>
        <span id="jfs-fe-rot-val" class="jfs-fe-muted" style="min-width:28px;text-align:center">0°</span>
        <button id="jfs-fe-rot-r1" class="jfs-fe-btn g">1° ${ICON_CW}</button>
        <button id="jfs-fe-rot-r5" class="jfs-fe-btn g">5° ${ICON_CW}</button>
        <div class="jfs-fe-spacer"></div>
        <button id="jfs-fe-download" class="jfs-fe-btn p">下载</button>
        <button id="jfs-fe-delete" class="jfs-fe-btn">删除</button>
      </div>
    </div>
  `

  document.getElementById('jfs-fe-back')?.addEventListener('click', () => {
    showGridPage(); renderGrid()
  })
  document.getElementById('jfs-fe-close2')?.addEventListener('click', closeModal)
  document.getElementById('jfs-fe-delete')?.addEventListener('click', () => {
    fetch(
      `${getBaseUrl()}/JellyfinSuite/FrameExport/Result/${_activeTaskId}?api_key=${encodeURIComponent(getToken())}`,
      { method: 'DELETE' }
    ).catch(() => {})
    showGridPage(); renderGrid()
  })
  document.getElementById('jfs-fe-download')?.addEventListener('click', () => {
    const ext = resultUrl.split('.').pop() ?? 'bin'
    const prefix = _exportType === 'animate' ? 'jellyfin-animate' : 'jellyfin-stitch'
    const dlTitle = document.title.replace(/\s*[-|]\s*Jellyfin\s*$/i, '').trim() || 'export'
    const sel = _frames.filter(f => f.selected)
    const ts1 = formatTime(sel[0]?.posMs ?? 0).replace(/[:.]/g, '-')
    const ts2 = formatTime(sel[sel.length - 1]?.posMs ?? 0).replace(/[:.]/g, '-')
    const a = document.createElement('a')
    a.href = fullUrl
    a.download = `${prefix}-${dlTitle}-${ts1}-to-${ts2}.${ext}`
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
  })
  document.getElementById('jfs-fe-rot-l5')?.addEventListener('click', () => { _rotation -= 5; updatePreview() })
  document.getElementById('jfs-fe-rot-l1')?.addEventListener('click', () => { _rotation -= 1; updatePreview() })
  document.getElementById('jfs-fe-rot-r1')?.addEventListener('click', () => { _rotation += 1; updatePreview() })
  document.getElementById('jfs-fe-rot-r5')?.addEventListener('click', () => { _rotation += 5; updatePreview() })
}
