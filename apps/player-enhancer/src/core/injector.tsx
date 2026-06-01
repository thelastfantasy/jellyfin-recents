import { useCallback, useMemo } from 'react'
import { createRoot } from 'react-dom/client'
import { createPortal } from 'react-dom'
import { atom, getDefaultStore, useAtomValue } from 'jotai'
import { useGestures, setSeekSeconds } from '../hooks/useGestures'
import { useLongPress } from '../hooks/useLongPress'
import { useTrickplay } from '../hooks/useTrickplay'
import { setTrickplayEnabled } from '../services/trickplay'
import { OsdOverlay } from '../components/OsdOverlay'
import { Toast } from '../components/Toast'
import { OsdButtons } from '../components/OsdButtons'
import { TrickplayThumb } from '../components/TrickplayThumb'
import { openFrameExportModal, FrameExportModalApp } from './frame-export'

const ROOT_ID = 'jfs-enhancer-root'
const jstore = getDefaultStore()

let _currentVideoEl: HTMLVideoElement | null = null
let _cachedItemId = ''
let _pendingItemId = ''
let _speedRate = 2.0

const _sVideoEl = atom<HTMLVideoElement | null>(null)
export const sVideoElAtom = _sVideoEl
const _sTrickplayEnabled = atom(true)
const _sOsdTarget = atom<HTMLElement | null>(null)

function $val<T>(a: ReturnType<typeof atom<T>>) {
  return {
    get value(): T { return jstore.get(a) },
    set value(v: T) { jstore.set(a, v as any) },
  }
}
const sVideoEl = $val(_sVideoEl)
const sTrickplayEnabled = $val(_sTrickplayEnabled)

// ── PlayerRoot ────────────────────────────────────────────────────────────────

function PlayerRoot() {
  const videoEl = useAtomValue(_sVideoEl)
  const trickEnabled = useAtomValue(_sTrickplayEnabled)
  const getRate = useCallback(() => _speedRate, [])
  useGestures(videoEl, getItemId)
  useLongPress(videoEl, getRate)
  useTrickplay(videoEl, getItemId, trickEnabled)
  return null
}

function AppRoot() {
  const osdTarget = useAtomValue(_sOsdTarget)
  const videoEl = useAtomValue(_sVideoEl)
  const handleOpenFrameExport = useMemo(() => () => {
    const id = getItemId()
    if (id && _currentVideoEl) openFrameExportModal(_currentVideoEl, id)
  }, [])

  return (
    <>
      <OsdOverlay />
      <Toast />
      <TrickplayThumb />
      <FrameExportModalApp />
      {osdTarget && videoEl && createPortal(
        <div style={{ display: 'inline-flex', alignItems: 'center' }}>
          <OsdButtons
            videoEl={videoEl}
            getItemId={getItemId}
            onOpenFrameExport={handleOpenFrameExport}
          />
        </div>,
        osdTarget,
      )}
      <PlayerRoot />
    </>
  )
}

// ── Item ID resolution ───────────────────────────────────────────────────────

function extractItemIdFromSearch(search: string): string {
  return new URLSearchParams(search).get('id') ?? ''
}
function extractItemIdFromUrl(url: string): string {
  const qIndex = url.indexOf('?')
  if (qIndex < 0) return ''
  return extractItemIdFromSearch(url.slice(qIndex + 1))
}
function extractItemIdFromVideoSrc(src: string): string {
  const m = src.match(/\/Videos\/([0-9a-f-]{32,36})\//i)
  return m?.[1] ?? ''
}
function getItemId(): string {
  const videoId = _currentVideoEl
    ? extractItemIdFromVideoSrc(_currentVideoEl.currentSrc || _currentVideoEl.src) : ''
  if (_pendingItemId) {
    if (videoId === _pendingItemId) { _pendingItemId = '' } else { return _pendingItemId }
  }
  return videoId || extractItemIdFromUrl(window.location.href) || extractItemIdFromUrl(window.location.hash) || _cachedItemId
}

// ── OSD portal anchor management ──────────────────────────────────────────────

function updateOsdTarget(): void {
  const osdButtons = document.querySelector<HTMLElement>('.osdControls .buttons.focuscontainer-x')
  const dirLtr = osdButtons?.querySelector<HTMLElement>('div[dir="ltr"]')
  if (dirLtr) {
    const existing = document.getElementById('jfs-osd-portal-anchor')
    if (!existing) {
      const anchor = document.createElement('div')
      anchor.id = 'jfs-osd-portal-anchor'
      anchor.style.display = 'inline-flex'
      dirLtr.after(anchor)
    }
    const anchor = document.getElementById('jfs-osd-portal-anchor')
    if (anchor && jstore.get(_sOsdTarget) !== anchor) {
      jstore.set(_sOsdTarget, anchor as HTMLElement)
    }
  }
}

// ── Config loading ───────────────────────────────────────────────────────────

async function loadGestureConfig(): Promise<void> {
  let ac = (window as any).ApiClient
  let token: string = (typeof ac?.accessToken === 'function' ? ac.accessToken() : ac?._accessToken) ?? ''
  for (let i = 0; i < 10 && !token; i++) {
    await new Promise<void>(r => setTimeout(r, 500))
    ac = (window as any).ApiClient
    token = (typeof ac?.accessToken === 'function' ? ac.accessToken() : ac?._accessToken) ?? ''
  }
  if (!token) return
  try {
    const res = await fetch(`/JellyfinSuite/PlayerEnhancer/Config?api_key=${encodeURIComponent(token)}`)
    if (!res.ok) return
    const cfg = await res.json() as { trickplayEnabled?: boolean; seekSeconds?: number; speedRate?: number }
    if (typeof cfg.trickplayEnabled === 'boolean') { sTrickplayEnabled.value = cfg.trickplayEnabled; setTrickplayEnabled(cfg.trickplayEnabled) }
    if (typeof cfg.seekSeconds === 'number' && cfg.seekSeconds > 0) setSeekSeconds(cfg.seekSeconds)
    if (typeof cfg.speedRate === 'number' && cfg.speedRate >= 1.25) _speedRate = cfg.speedRate
  } catch { /* defaults */ }
}

// ── Public init ──────────────────────────────────────────────────────────────

let _initDone = false

export function initInjector(): void {
  if (_initDone) return
  _initDone = true

  import('../styles/styles').then(m => m.injectStyles())
  const appRootEl = document.createElement('div')
  document.body.appendChild(appRootEl)
  createRoot(appRootEl).render(<AppRoot />)
  loadGestureConfig()

  window.addEventListener('jfs:seekSecondsChanged', (e: Event) => {
    const { seconds } = (e as CustomEvent<{ seconds: number }>).detail
    if (typeof seconds === 'number' && seconds > 0) setSeekSeconds(seconds)
  })
  window.addEventListener('jfs:speedRateChanged', (e: Event) => {
    const { rate } = (e as CustomEvent<{ rate: number }>).detail
    if (typeof rate === 'number' && rate >= 1.25) _speedRate = rate
  })
  window.addEventListener('jfs:trickplayEnabledChanged', (e: Event) => {
    const { enabled } = (e as CustomEvent<{ enabled: boolean }>).detail
    if (typeof enabled !== 'boolean') return
    sTrickplayEnabled.value = enabled; setTrickplayEnabled(enabled)
  })

  const _origPushState = history.pushState.bind(history)
  history.pushState = function (data: unknown, unused: string, url?: string | URL | null) {
    const id = extractItemIdFromUrl(window.location.href)
    if (id) _cachedItemId = id
    return _origPushState(data, unused, url)
  }

  let _obsLastCall = 0
  const observer = new MutationObserver(() => {
    const now = performance.now()
    if (now - _obsLastCall < 50) return
    _obsLastCall = now
    tryInject()
  })
  observer.observe(document.body, { childList: true, subtree: true })
  tryInject()
}

function tryInject(): void {
  const container = document.querySelector('.videoPlayerContainer')
  if (!container) return
  const videoEl = container.querySelector<HTMLVideoElement>('video.htmlvideoplayer')
  if (!videoEl) return

  if (videoEl !== _currentVideoEl) {
    if (_currentVideoEl) _currentVideoEl.style.filter = ''
    _currentVideoEl = videoEl
    _pendingItemId = extractItemIdFromUrl(window.location.href) || extractItemIdFromUrl(window.location.hash) || ''
    sVideoEl.value = videoEl
  }

  if (!document.getElementById(ROOT_ID)) {
    const root = document.createElement('div')
    root.id = ROOT_ID
    container.appendChild(root)
  }

  if (!document.getElementById('jfs-osd-portal-anchor')) {
    updateOsdTarget()
  }
}
