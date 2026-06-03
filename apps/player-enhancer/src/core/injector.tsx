import { createRoot } from 'react-dom/client'
import { atom, getDefaultStore } from 'jotai'
import { setSeekSeconds } from '../hooks/useGestures'
import { setTrickplayEnabled } from '../services/trickplay'
import { enhancerConfigQuery } from '../api/playerEnhancerApi'
import { queryClient } from './queryClient'
import { AppRoot } from './App'
import { setVideoEl, setSpeedRate, cacheItemIdFromUrl, getCurrentVideoEl } from './video-tracker'

const ROOT_ID = 'jfs-enhancer-root'
const jstore = getDefaultStore()

const _sVideoEl = atom<HTMLVideoElement | null>(null)
const _sOsdTarget = atom<HTMLElement | null>(null)
const _sTrickplayEnabled = atom(true)

export const sVideoElAtom = _sVideoEl
export const sOsdTargetAtom = _sOsdTarget
export const sTrickplayEnabledAtom = _sTrickplayEnabled

function $val<T>(a: ReturnType<typeof atom<T>>) {
  return { get value(): T { return jstore.get(a) }, set value(v: T) { jstore.set(a, v) } }
}
const sVideoEl = $val(_sVideoEl)
const sTrickplayEnabled = $val(_sTrickplayEnabled)

// ── OSD portal ────────────────────────────────────────────────────────────────

function updateOsdTarget(): void {
  const osdButtons = document.querySelector<HTMLElement>('.osdControls .buttons.focuscontainer-x')
  const dirLtr = osdButtons?.querySelector<HTMLElement>('div[dir="ltr"]')
  if (!dirLtr) return
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

// ── Config ────────────────────────────────────────────────────────────────────

async function loadConfig(): Promise<void> {
  const cfg = await queryClient.fetchQuery(enhancerConfigQuery)
  if (!cfg) return
  if (typeof cfg.trickplayEnabled === 'boolean') { sTrickplayEnabled.value = cfg.trickplayEnabled; setTrickplayEnabled(cfg.trickplayEnabled) }
  if (typeof cfg.seekSeconds === 'number' && cfg.seekSeconds > 0) setSeekSeconds(cfg.seekSeconds)
  if (typeof cfg.speedRate === 'number' && cfg.speedRate >= 1.25) setSpeedRate(cfg.speedRate)
}

// ── Init ──────────────────────────────────────────────────────────────────────

let _initDone = false

export function initInjector(): void {
  if (_initDone) return
  _initDone = true

  import('../styles/styles').then(m => m.injectStyles())
  const appRootEl = document.createElement('div')
  document.body.appendChild(appRootEl)
  createRoot(appRootEl).render(<AppRoot />)
  loadConfig()

  window.addEventListener('jfs:seekSecondsChanged', (e: Event) => {
    const { seconds } = (e as CustomEvent<{ seconds: number }>).detail
    if (typeof seconds === 'number' && seconds > 0) setSeekSeconds(seconds)
  })
  window.addEventListener('jfs:speedRateChanged', (e: Event) => {
    const { rate } = (e as CustomEvent<{ rate: number }>).detail
    if (typeof rate === 'number' && rate >= 1.25) setSpeedRate(rate)
  })
  window.addEventListener('jfs:trickplayEnabledChanged', (e: Event) => {
    const { enabled } = (e as CustomEvent<{ enabled: boolean }>).detail
    if (typeof enabled !== 'boolean') return
    sTrickplayEnabled.value = enabled; setTrickplayEnabled(enabled)
  })

  const _origPushState = history.pushState.bind(history)
  history.pushState = function (data: unknown, unused: string, url?: string | URL | null) {
    cacheItemIdFromUrl(window.location.href)
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

  const prev = getCurrentVideoEl()
  if (videoEl !== prev) {
    if (prev) prev.style.filter = ''
    const href = window.location.href
    const pending = href.includes('?') ? new URLSearchParams(href.slice(href.indexOf('?'))).get('id') ?? '' : ''
    setVideoEl(videoEl, pending)
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
