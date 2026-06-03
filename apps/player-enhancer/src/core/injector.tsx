import { atom, getDefaultStore } from 'jotai'
import { createRoot } from 'react-dom/client'

import { enhancerConfigQuery } from '../api/playerEnhancerApi'
import { setSeekSeconds } from '../hooks/useGestures'
import { setTrickplayEnabled } from '../services/trickplay'
import { AppRoot } from './App'
import { queryClient } from './queryClient'
import { cacheItemIdFromUrl, getCurrentVideoEl,setSpeedRate, setVideoEl } from './video-tracker'

const ROOT_ID = 'jfs-enhancer-root'
const jotaiStore = getDefaultStore()
const anchorId = 'jfs-osd-portal-anchor'

const _sVideoEl            = atom<HTMLVideoElement | null>(null)
const _sOsdTarget          = atom<HTMLElement | null>(null)
const _sTrickplayEnabled   = atom(true)

export const sVideoElAtom          = _sVideoEl

export const sOsdTargetAtom        = _sOsdTarget

export const sTrickplayEnabledAtom = _sTrickplayEnabled

function createRefProxy<AtomTargetType>(targetAtom: ReturnType<typeof atom<AtomTargetType>>) {
  return { get value(): AtomTargetType { return jotaiStore.get(targetAtom) }, set value(v: AtomTargetType) { jotaiStore.set(targetAtom, v) } }
}
const videoRef = createRefProxy(_sVideoEl)
const trickplayEnabledRef = createRefProxy(_sTrickplayEnabled)

// ── OSD portal ────────────────────────────────────────────────────────────────

function updateOsdTarget(): void {
  const buttonsRow = document.querySelector<HTMLElement>('.osdControls .buttons.focuscontainer-x')
  const ltrDiv = buttonsRow?.querySelector<HTMLElement>('div[dir="ltr"]')
  if (!ltrDiv) return
  if (!document.getElementById(anchorId)) {
    const anchor = document.createElement('div')
    anchor.id = anchorId
    anchor.style.display = 'inline-flex'
    ltrDiv.after(anchor)
  }
  const anchor = document.getElementById(anchorId)
  if (anchor && jotaiStore.get(_sOsdTarget) !== anchor) {
    jotaiStore.set(_sOsdTarget, anchor as HTMLElement)
  }
}

// ── Config ────────────────────────────────────────────────────────────────────

async function loadConfig(): Promise<void> {
  const config = await queryClient.fetchQuery(enhancerConfigQuery)
  if (!config) return
  if (typeof config.trickplayEnabled === 'boolean') { trickplayEnabledRef.value = config.trickplayEnabled; setTrickplayEnabled(config.trickplayEnabled) }
  if (typeof config.seekSeconds === 'number' && config.seekSeconds > 0) setSeekSeconds(config.seekSeconds)
  if (typeof config.speedRate === 'number' && config.speedRate >= 1.25) setSpeedRate(config.speedRate)
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

  window.addEventListener('jfs:seekSecondsChanged', (event: Event) => {
    const { seconds } = (event as CustomEvent<{ seconds: number }>).detail
    if (typeof seconds === 'number' && seconds > 0) setSeekSeconds(seconds)
  })
  window.addEventListener('jfs:speedRateChanged', (event: Event) => {
    const { rate } = (event as CustomEvent<{ rate: number }>).detail
    if (typeof rate === 'number' && rate >= 1.25) setSpeedRate(rate)
  })
  window.addEventListener('jfs:trickplayEnabledChanged', (event: Event) => {
    const { enabled } = (event as CustomEvent<{ enabled: boolean }>).detail
    if (typeof enabled !== 'boolean') return
    trickplayEnabledRef.value = enabled; setTrickplayEnabled(enabled)
  })

  const _origPushState = history.pushState.bind(history)
  history.pushState = function (data: unknown, unused: string, url?: string | URL | null) {
    cacheItemIdFromUrl(window.location.href)
    return _origPushState(data, unused, url)
  }

  let _lastObserverCall = 0
  const observer = new MutationObserver(() => {
    const now = performance.now()
    if (now - _lastObserverCall < 50) return
    _lastObserverCall = now
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

  const previousVideo = getCurrentVideoEl()
  if (videoEl !== previousVideo) {
    if (previousVideo) previousVideo.style.filter = ''
    const href = window.location.href
    const pending = href.includes('?') ? new URLSearchParams(href.slice(href.indexOf('?'))).get('id') ?? '' : ''
    setVideoEl(videoEl, pending)
    videoRef.value = videoEl
  }

  if (!document.getElementById(ROOT_ID)) {
    const root = document.createElement('div')
    root.id = ROOT_ID
    container.appendChild(root)
  }

  if (!document.getElementById(anchorId)) {
    updateOsdTarget()
  }
}
