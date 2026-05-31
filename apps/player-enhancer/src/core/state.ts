import { signal } from '@preact/signals'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CropRect { x: number; y: number; w: number; h: number }
export interface FpsFrac  { num: number; den: number }

export interface ExportSettings {
  animateFormat:      'gif' | 'webp'
  stitchFormat:       'png' | 'webp'
  resizeMode:         'width' | 'height'
  customWidth:        number
  customHeight:       number
  resolutionPreset:   string
  useCustomResolution: boolean
  speed:              number
  loopCount:          number
  cropRect:           CropRect | null
  animateQuality:     number
  stitchQuality:      number
}

export interface FrameEntry {
  posMs:        number
  fiIdx:        number          // 0-based index into frameIndex; -1 if unavailable
  selected:     boolean
  jpegUrl:      string
  isJunk:       boolean
  junkReason:   string | null
  loadError?:   boolean
  removed?:     boolean
  actualPtsMs?: number          // normalized PTS from X-Frame-Pts-Ms header
  blobUrl?:     string          // browser blob URL (excluded from savedState)
}

export interface SavedModalState {
  itemId:         string
  frames:         FrameEntry[]
  exportType:     'animate' | 'stitch'
  minPosMs:       number
  maxPosMs:       number
  fpsFrac:        FpsFrac
  lastClickedIdx: number
  fiMinIdx:       number
  fiMaxIdx:       number
}

// ── Settings ──────────────────────────────────────────────────────────────────

export const DEFAULT_SETTINGS: ExportSettings = {
  animateFormat:       'gif',
  stitchFormat:        'png',
  resizeMode:          'width',
  customWidth:         0,
  customHeight:        0,
  resolutionPreset:    'original',
  useCustomResolution: false,
  speed:               1.0,
  loopCount:           0,
  cropRect:            null,
  animateQuality:      0.75,
  stitchQuality:       0.75,
}

function loadSettingsOnce(): ExportSettings {
  try {
    const raw = localStorage.getItem('jfs-frameexport-settings')
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch { /* ignore */ }
  return { ...DEFAULT_SETTINGS }
}

export function saveSettings(s: ExportSettings): void {
  try { localStorage.setItem('jfs-frameexport-settings', JSON.stringify(s)) } catch { /* ignore */ }
}

export function updateSettings(patch: Partial<ExportSettings>): void {
  const next = { ...sSettings.value, ...patch }
  saveSettings(next)
  sSettings.value = next
}

// ── Signals ───────────────────────────────────────────────────────────────────

export const sPage           = signal<'grid' | 'progress' | 'result'>('grid')
export const sFrames         = signal<FrameEntry[]>([])
export const sExportType     = signal<'animate' | 'stitch'>('animate')
export const sParamsOpen     = signal(false)
export const sPrefetchTotal  = signal(0)
export const sPrefetchDone   = signal(0)
export const sSettings       = signal<ExportSettings>(loadSettingsOnce())
export const sProgressTaskId = signal('')
export const sResultUrl      = signal('')
export const sFileSize       = signal(0)
export const sLightboxIdx    = signal<number | null>(null)
export const sCropOpen       = signal(false)

// ── Module-level mutable state ────────────────────────────────────────────────

export let _modalRoot:      HTMLDivElement | null = null
export let _dragController: AbortController | null = null
export let _domObserver:    MutationObserver | null = null
export let _videoEl:        HTMLVideoElement | null = null
export let _itemId  = ''
export let _activeTaskId = ''

export function set_modalRoot(v: HTMLDivElement | null)       { _modalRoot = v }
export function set_dragController(v: AbortController | null) { _dragController = v }
export function set_domObserver(v: MutationObserver | null)   { _domObserver = v }
export function set_videoEl(v: HTMLVideoElement | null)       { _videoEl = v }
export function set_itemId(v: string)                         { _itemId = v }
export function set_activeTaskId(v: string)                   { _activeTaskId = v }

export let _frames:         FrameEntry[] = []
export let _minPosMs        = 0
export let _maxPosMs        = 0
export let _fpsFrac:        FpsFrac = { num: 24, den: 1 }
export let _lastClickedIdx  = -1
export let _dragMode        = false
export let _dragSelectValue = false
export let _longPressTimer: ReturnType<typeof setTimeout> | null = null
export let _longPressCard:  HTMLElement | null = null
export let _suppressNextMousedown = false
export let _autoScrollRaf:  number | null = null
export let _lastTouchX      = 0
export let _lastTouchY      = 0

export function set_frames(v: FrameEntry[])                    { _frames = v }
export function set_minPosMs(v: number)                        { _minPosMs = v }
export function set_maxPosMs(v: number)                        { _maxPosMs = v }
export function set_fpsFrac(v: FpsFrac)                        { _fpsFrac = v }
export function set_lastClickedIdx(v: number)                  { _lastClickedIdx = v }
export function set_dragMode(v: boolean)                       { _dragMode = v }
export function set_dragSelectValue(v: boolean)                { _dragSelectValue = v }
export function set_longPressTimer(v: ReturnType<typeof setTimeout> | null) { _longPressTimer = v }
export function set_longPressCard(v: HTMLElement | null)       { _longPressCard = v }
export function set_suppressNextMousedown(v: boolean)          { _suppressNextMousedown = v }
export function set_autoScrollRaf(v: number | null)            { _autoScrollRaf = v }
export function set_lastTouchXY(x: number, y: number)          { _lastTouchX = x; _lastTouchY = y }

// Frame index from Rust daemon
export let _frameIndex: Array<{ ms: number; isKey: boolean }> | null = null
export let _fiMinIdx = 0
export let _fiMaxIdx = -1

export function set_frameIndex(v: Array<{ ms: number; isKey: boolean }> | null) { _frameIndex = v }
export function set_fiMinIdx(v: number)  { _fiMinIdx = v }
export function set_fiMaxIdx(v: number)  { _fiMaxIdx = v }

export let _savedState: SavedModalState | null = null
export function set_savedState(v: SavedModalState | null) { _savedState = v }

// ── Derived helpers ───────────────────────────────────────────────────────────

export function renderGrid(): void {
  _frames = [..._frames]
  sFrames.value = _frames
}

export function frameInterval(): number {
  return _fpsFrac.den * 1000 / _fpsFrac.num
}

export function frameToMs(idx: number): number {
  return Math.ceil(idx * _fpsFrac.den * 1000 / _fpsFrac.num)
}

export function samplePositionsInRange(startMs: number, endMs: number): number[] {
  const startIdx = Math.ceil(startMs * _fpsFrac.num / (_fpsFrac.den * 1000))
  const endIdx   = Math.floor(endMs   * _fpsFrac.num / (_fpsFrac.den * 1000))
  const positions: number[] = []
  for (let i = startIdx; i <= endIdx; i++) {
    positions.push(frameToMs(i))
  }
  return positions
}
