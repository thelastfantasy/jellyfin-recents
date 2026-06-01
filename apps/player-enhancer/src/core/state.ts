import { atom, getDefaultStore } from 'jotai'

// ── Types ────────────────────────────────────────────────────────────────────

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
  fiIdx:        number
  selected:     boolean
  jpegUrl:      string
  isJunk:       boolean
  junkReason:   string | null
  loadError?:   boolean
  removed?:     boolean
  actualPtsMs?: number
  blobUrl?:     string
  skeleton?:    boolean
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

// ── Persistent settings ──────────────────────────────────────────────────────

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

// ── Jotai atoms ──────────────────────────────────────────────────────────────

const _settingsAtom          = atom(loadSettingsOnce())
const _pageAtom              = atom<'grid' | 'progress' | 'result'>('grid')
const _framesAtom            = atom<FrameEntry[]>([])
const _exportTypeAtom        = atom<'animate' | 'stitch'>('animate')
const _paramsOpenAtom        = atom(false)
const _prefetchTotalAtom     = atom(0)
const _prefetchDoneAtom      = atom(0)
const _progressTaskIdAtom    = atom('')
const _resultUrlAtom         = atom('')
const _fileSizeAtom          = atom(0)
const _lightboxIdxAtom       = atom<number | null>(null)
const _cropOpenAtom          = atom(false)
const _videoElAtom           = atom<HTMLVideoElement | null>(null)
const _itemIdAtom            = atom('')
const _activeTaskIdAtom      = atom('')
const _minPosMsAtom          = atom(0)
const _maxPosMsAtom          = atom(0)
const _fpsFracAtom           = atom<FpsFrac>({ num: 24, den: 1 })
const _lastClickedIdxAtom    = atom(-1)
const _dragModeAtom          = atom(false)
const _dragSelectValueAtom   = atom(false)
const _suppressNextMousedownAtom = atom(false)
const _frameIndexAtom        = atom<Array<{ ms: number; isKey: boolean }> | null>(null)
const _fiMinIdxAtom          = atom(0)
const _fiMaxIdxAtom          = atom(-1)
const _savedStateAtom        = atom<SavedModalState | null>(null)

// ── React hook-friendly atom exports ─────────────────────────────────────────
export const pageAtom         = _pageAtom
export const framesAtom       = _framesAtom
export const exportTypeAtom   = _exportTypeAtom
export const prefetchTotalAtom = _prefetchTotalAtom
export const prefetchDoneAtom = _prefetchDoneAtom
export const progressTaskIdAtom = _progressTaskIdAtom
export const resultUrlAtom    = _resultUrlAtom
export const fileSizeAtom     = _fileSizeAtom
export const lightboxIdxAtom  = _lightboxIdxAtom
export const cropOpenAtom     = _cropOpenAtom
export const videoElAtom      = _videoElAtom
export const itemIdAtom       = _itemIdAtom
export const minPosMsAtom     = _minPosMsAtom
export const maxPosMsAtom     = _maxPosMsAtom
export const fpsFracAtom      = _fpsFracAtom
export const lastClickedIdxAtom = _lastClickedIdxAtom
export const dragModeAtom     = _dragModeAtom
export const dragSelectValueAtom = _dragSelectValueAtom
export const suppressNextMousedownAtom = _suppressNextMousedownAtom
export const frameIndexAtom   = _frameIndexAtom
export const fiMinIdxAtom     = _fiMinIdxAtom
export const fiMaxIdxAtom     = _fiMaxIdxAtom
export const savedStateAtom   = _savedStateAtom
export const settingsAtom     = _settingsAtom
export const paramsOpenAtom   = _paramsOpenAtom

// ── Backward-compatible .value proxies for imperative code ────────────────────
const store = getDefaultStore()

function ref<T>(a: ReturnType<typeof atom<T>>) {
  return {
    get value(): T { return store.get(a) },
    set value(v: T) { store.set(a, v as any) },
    peek(): T { return store.get(a) },
  }
}

export const sSettings          = ref(_settingsAtom)
export const sPage              = ref(_pageAtom)
export const sFrames            = ref(_framesAtom)
export const sExportType        = ref(_exportTypeAtom)
export const sParamsOpen        = ref(_paramsOpenAtom)
export const sPrefetchTotal     = ref(_prefetchTotalAtom)
export const sPrefetchDone      = ref(_prefetchDoneAtom)
export const sProgressTaskId    = ref(_progressTaskIdAtom)
export const sResultUrl         = ref(_resultUrlAtom)
export const sFileSize          = ref(_fileSizeAtom)
export const sLightboxIdx       = ref(_lightboxIdxAtom)
export const sCropOpen          = ref(_cropOpenAtom)
export const s_videoEl          = ref(_videoElAtom)
export const s_itemId           = ref(_itemIdAtom)
export const s_activeTaskId     = ref(_activeTaskIdAtom)
export const s_minPosMs         = ref(_minPosMsAtom)
export const s_maxPosMs         = ref(_maxPosMsAtom)
export const s_fpsFrac          = ref(_fpsFracAtom)
export const s_lastClickedIdx   = ref(_lastClickedIdxAtom)
export const s_dragMode         = ref(_dragModeAtom)
export const s_dragSelectValue  = ref(_dragSelectValueAtom)
export const s_suppressNextMousedown = ref(_suppressNextMousedownAtom)
export const s_frameIndex       = ref(_frameIndexAtom)
export const s_fiMinIdx         = ref(_fiMinIdxAtom)
export const s_fiMaxIdx         = ref(_fiMaxIdxAtom)
export const s_savedState       = ref(_savedStateAtom)

// ── Module-level mutable vars (imperative code continues to use these) ────────

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

export let _frameIndex: Array<{ ms: number; isKey: boolean }> | null = null
export let _fiMinIdx = 0
export let _fiMaxIdx = -1

export function set_frameIndex(v: Array<{ ms: number; isKey: boolean }> | null) { _frameIndex = v }
export function set_fiMinIdx(v: number)  { _fiMinIdx = v }
export function set_fiMaxIdx(v: number)  { _fiMaxIdx = v }

export let _savedState: SavedModalState | null = null
export function set_savedState(v: SavedModalState | null) { _savedState = v }

// ── Derived helpers ──────────────────────────────────────────────────────────

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

export function updateSettings(patch: Partial<ExportSettings>): void {
  const next = { ...store.get(_settingsAtom), ...patch }
  saveSettings(next)
  store.set(_settingsAtom, next)
}
