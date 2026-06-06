import { atom, getDefaultStore } from 'jotai'

// ── Types ────────────────────────────────────────────────────────────────────

export interface CropRect { x: number; y: number; w: number; h: number }

export interface FpsFrac  { num: number; den: number }

export interface DimSetting { value: number; mode: 'userInput' | 'autoAdjust' }

export interface ExportSettings {
  animateFormat:      'gif' | 'webp'
  stitchFormat:       'png' | 'webp'
  width:              DimSetting
  height:             DimSetting
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
  fiIdx:         number
  selected:     boolean
  jpegUrl:      string
  isJunk:       boolean
  junkReason:   string | null
  loadError?:   boolean
  removed?:     boolean
  actualPtsMs?: number
}

/** 单帧的帧索引信息，由 FrameInfoStream SSE 流构建。
 *  _frameIndex !== null 即代表该项目的帧索引已完整加载（fps 信号已收到）。 */
export interface FrameInfoEntry {
  ms:         number
  isKey:      boolean
  frameIndex: number
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
  width:               { value: 0, mode: 'autoAdjust' },
  height:              { value: 0, mode: 'autoAdjust' },
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
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw), cropRect: null }
  } catch { /* ignore */ }
  return { ...DEFAULT_SETTINGS }
}

export function saveSettings(s: ExportSettings): void {
  try {
    const { cropRect: _, ...rest } = s
    localStorage.setItem('jfs-frameexport-settings', JSON.stringify(rest))
  } catch { /* ignore */ }
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
const _lastClickedIdxAtom    = atom(-1)
const _dragModeAtom          = atom(false)
const _dragSelectValueAtom   = atom(false)
const _suppressNextMousedownAtom = atom(false)
const _savedStateAtom        = atom<SavedModalState | null>(null)
const _modalPhaseAtom        = atom<'skeleton' | 'loading'>('skeleton')
const _modalMinimizedAtom     = atom(false)

export const modalMinimizedAtom = _modalMinimizedAtom

export const sModalMinimized   = ref(_modalMinimizedAtom)

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

export const lastClickedIdxAtom = _lastClickedIdxAtom

export const dragModeAtom     = _dragModeAtom

export const dragSelectValueAtom = _dragSelectValueAtom

export const suppressNextMousedownAtom = _suppressNextMousedownAtom

export const savedStateAtom   = _savedStateAtom

export const settingsAtom     = _settingsAtom

export const paramsOpenAtom   = _paramsOpenAtom

export const modalPhaseAtom   = _modalPhaseAtom

// ── Backward-compatible .value proxies for imperative code ────────────────────
const store = getDefaultStore()

function ref<T>(a: ReturnType<typeof atom<T>>) {
  return {
    get value(): T { return store.get(a) },
    set value(v: T) { store.set(a, v) },
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

export const sVideoEl          = ref(_videoElAtom)

export const sItemId           = ref(_itemIdAtom)

export const sActiveTaskId     = ref(_activeTaskIdAtom)

export const sMinPosMs         = ref(_minPosMsAtom)

export const sMaxPosMs         = ref(_maxPosMsAtom)

export const sLastClickedIdx   = ref(_lastClickedIdxAtom)

export const sDragMode         = ref(_dragModeAtom)

export const sDragSelectValue  = ref(_dragSelectValueAtom)

export const sSuppressNextMousedown = ref(_suppressNextMousedownAtom)

export const sSavedState       = ref(_savedStateAtom)

export const sModalPhase         = ref(_modalPhaseAtom)

// ── Module-level mutable vars (imperative code continues to use these) ────────

export let _videoEl:        HTMLVideoElement | null = null

export let _itemId  = ''

export let _itemTitle = ''

export let _activeTaskId = ''

export function setVideoEl(v: HTMLVideoElement | null)       { _videoEl = v }

export function setItemId(v: string)                         { _itemId = v }

export function setItemTitle(v: string)                      { _itemTitle = v }

export function setActiveTaskId(v: string)                   { _activeTaskId = v }

export let _frames:         FrameEntry[] = []

export let _minPosMs        = 1

export let _maxPosMs        = 0

export let _lastClickedIdx  = -1

export let _dragMode        = false

export let _dragSelectValue = false

export let _suppressNextMousedown = false

export function setFrames(v: FrameEntry[]) { _frames = v; sFrames.value = v }

export function setMinPosMs(v: number)                        { _minPosMs = v }

export function setMaxPosMs(v: number)                        { _maxPosMs = v }

export function setLastClickedIdx(v: number)                  { _lastClickedIdx = v }

export function setDragMode(v: boolean)                       { _dragMode = v }

export function setDragSelectValue(v: boolean)                { _dragSelectValue = v }

export function setSuppressNextMousedown(v: boolean)          { _suppressNextMousedown = v }

export interface FrameInfoState {
  index:         FrameInfoEntry[] | null
  indexComplete: boolean
  minIdx:        number
  maxIdx:        number
  fpsFrac:       FpsFrac
}

export const _fi: FrameInfoState = { index: null, indexComplete: false, minIdx: 1, maxIdx: -1, fpsFrac: { num: 24, den: 1 } }

export function setFrameIndex(v: FrameInfoEntry[] | null) { _fi.index         = v }

export function setFiIndexComplete(v: boolean)            { _fi.indexComplete = v }

export function setFiMinIdx(v: number)                    { _fi.minIdx  = v }

export function setFiMaxIdx(v: number)                    { _fi.maxIdx  = v }

export function setFpsFrac(v: FpsFrac)                    { _fi.fpsFrac = v }

export let _savedState: SavedModalState | null = null

export function setSavedState(v: SavedModalState | null) { _savedState = v }

// ── Derived helpers ──────────────────────────────────────────────────────────

export function frameInterval(): number {
  return _fi.fpsFrac.den * 1000 / _fi.fpsFrac.num
}

export function frameToMs(idx: number): number {
  return Math.ceil(idx * _fi.fpsFrac.den * 1000 / _fi.fpsFrac.num)
}

export function samplePositionsInRange(startMs: number, endMs: number): number[] {
  const startIdx = Math.ceil(startMs * _fi.fpsFrac.num / (_fi.fpsFrac.den * 1000))
  const endIdx   = Math.floor(endMs   * _fi.fpsFrac.num / (_fi.fpsFrac.den * 1000))
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

// ── Modal open/close ────────────────────────────────────────────────────────

export const _feOpen = atom<{ videoEl: HTMLVideoElement; itemId: string } | null>(null)

export function openFrameExportModal(videoEl: HTMLVideoElement, itemId: string): void {
  store.set(modalMinimizedAtom, false)
  sPage.value = 'grid'
  store.set(_feOpen, { videoEl, itemId })
}
