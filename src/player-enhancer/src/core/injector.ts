import { h, Fragment, render } from 'preact'
import { signal } from '@preact/signals'
import { useCallback } from 'preact/hooks'
import { injectStyles } from '../styles/styles'
import { useGestures, setSeekSeconds } from '../hooks/useGestures'
import { useLongPress } from '../hooks/useLongPress'
import { useTrickplay } from '../hooks/useTrickplay'
import { setTrickplayEnabled } from '../services/trickplay'
import { OsdOverlay } from '../components/OsdOverlay'
import { Toast } from '../components/Toast'
import { OsdButtons } from '../components/OsdButtons'
import { TrickplayThumb } from '../components/TrickplayThumb'
import { t } from '../lib/i18n'
import { ICON_BACK10, ICON_BACK1, ICON_FORWARD1, ICON_FORWARD10 } from '../lib/icons'

const ROOT_ID = 'jfs-enhancer-root'

let _currentVideoEl: HTMLVideoElement | null = null
let _cachedItemId = ''
let _pendingItemId = ''
let _speedRate = 2.0

const sVideoEl          = signal<HTMLVideoElement | null>(null)
const sTrickplayEnabled = signal(true)

// ── Preact root ────────────────────────────────────────────────────────────────

function PlayerRoot() {
  const videoEl     = sVideoEl.value
  const trickEnabled = sTrickplayEnabled.value
  const getRate     = useCallback(() => _speedRate, [])
  useGestures(videoEl, getItemId)
  useLongPress(videoEl, getRate)
  useTrickplay(videoEl, getItemId, trickEnabled)
  return null
}

function AppRoot() {
  return h(Fragment, null,
    h(OsdOverlay, null),
    h(Toast, null),
    h(TrickplayThumb, null),
    h(PlayerRoot, null),
  )
}

// ── Item ID resolution ─────────────────────────────────────────────────────────

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
    ? extractItemIdFromVideoSrc(_currentVideoEl.currentSrc || _currentVideoEl.src)
    : ''

  if (_pendingItemId) {
    if (videoId === _pendingItemId) {
      _pendingItemId = ''
    } else {
      return _pendingItemId
    }
  }

  return videoId
    || extractItemIdFromUrl(window.location.href)
    || extractItemIdFromUrl(window.location.hash)
    || _cachedItemId
}

// ── OSD button injection via Preact ────────────────────────────────────────────

function injectOsdButtons(osdButtons: HTMLElement, videoEl: HTMLVideoElement): void {
  if (osdButtons.querySelector('.jfs-enhancer-framestep-wrap')) return

  const isFirefoxMobile = navigator.userAgent.includes('Firefox')
    && navigator.userAgent.includes('Android')
    && !navigator.userAgent.includes('Chrome')

  if (isFirefoxMobile) {
    // Firefox Android: only frame step buttons (screenshot is broken)
    const wrap = document.createElement('div')
    render(
      h('div', { class: 'jfs-enhancer-framestep-wrap', style: 'display:inline-flex;align-items:center;' },
        h('button', { class: 'jfs-enhancer-btn', title: t('framestepper.back10'), onClick: () => import('../services/framestepper').then(m => m.stepFrames(videoEl, -10, getItemId())) },
          h('span', { dangerouslySetInnerHTML: { __html: ICON_BACK10 } }),
        ),
        h('button', { class: 'jfs-enhancer-btn', title: t('framestepper.back1'), onClick: () => import('../services/framestepper').then(m => m.stepFrames(videoEl, -1, getItemId())) },
          h('span', { dangerouslySetInnerHTML: { __html: ICON_BACK1 } }),
        ),
        h('button', { class: 'jfs-enhancer-btn', title: t('framestepper.forward1'), onClick: () => import('../services/framestepper').then(m => m.stepFrames(videoEl, 1, getItemId())) },
          h('span', { dangerouslySetInnerHTML: { __html: ICON_FORWARD1 } }),
        ),
        h('button', { class: 'jfs-enhancer-btn', title: t('framestepper.forward10'), onClick: () => import('../services/framestepper').then(m => m.stepFrames(videoEl, 10, getItemId())) },
          h('span', { dangerouslySetInnerHTML: { __html: ICON_FORWARD10 } }),
        ),
      ),
      wrap
    )
    const dirLtr = osdButtons.querySelector<HTMLElement>('div[dir="ltr"]')
    if (dirLtr) dirLtr.after(wrap)
    else osdButtons.append(wrap)
    return
  }

  // Full OSD buttons via Preact
  const wrap = document.createElement('div')
  wrap.style.display = 'inline-flex'
  wrap.style.alignItems = 'center'

  const handleFrameExport = () => {
    const itemId = getItemId()
    if (!itemId || !_currentVideoEl) return
    import('./frame-export').then(m => m.openFrameExportModal(_currentVideoEl!, itemId))
  }

  render(
    h(OsdButtons, {
      videoEl,
      getItemId,
      onOpenFrameExport: handleFrameExport,
    }),
    wrap
  )

  const dirLtr = osdButtons.querySelector<HTMLElement>('div[dir="ltr"]')
  if (dirLtr) {
    dirLtr.after(wrap)
  } else {
    osdButtons.append(wrap)
  }
}

// ── Config loading ─────────────────────────────────────────────────────────────

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
    if (typeof cfg.trickplayEnabled === 'boolean') {
      sTrickplayEnabled.value = cfg.trickplayEnabled
      setTrickplayEnabled(cfg.trickplayEnabled)
    }
    if (typeof cfg.seekSeconds === 'number' && cfg.seekSeconds > 0) {
      setSeekSeconds(cfg.seekSeconds)
    }
    if (typeof cfg.speedRate === 'number' && cfg.speedRate >= 1.25) {
      _speedRate = cfg.speedRate
    }
  } catch {
    // keep defaults
  }
}

// ── Public init ────────────────────────────────────────────────────────────────

export function initInjector(): void {
  injectStyles()

  // Mount the persistent Preact app root (OSD overlays + gesture hooks)
  const appRootEl = document.createElement('div')
  document.body.appendChild(appRootEl)
  render(h(AppRoot, null), appRootEl)

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
    sTrickplayEnabled.value = enabled
    setTrickplayEnabled(enabled)
  })

  // Intercept pushState to capture item ID before URL changes
  const _origPushState = history.pushState.bind(history)
  history.pushState = function (data: unknown, unused: string, url?: string | URL | null) {
    const id = extractItemIdFromUrl(window.location.href)
    if (id) _cachedItemId = id
    return _origPushState(data, unused, url)
  }

  const observer = new MutationObserver(() => tryInject())
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
    _pendingItemId = extractItemIdFromUrl(window.location.href)
      || extractItemIdFromUrl(window.location.hash)
      || ''
    sVideoEl.value = videoEl
  }

  if (!document.getElementById(ROOT_ID)) {
    const root = document.createElement('div')
    root.id = ROOT_ID
    container.appendChild(root)
  }

  const osdButtons = document.querySelector<HTMLElement>(
    '.osdControls .buttons.focuscontainer-x'
  )
  if (osdButtons) {
    injectOsdButtons(osdButtons, videoEl)
  }
}

