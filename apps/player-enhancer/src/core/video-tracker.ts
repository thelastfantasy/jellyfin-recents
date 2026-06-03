let _currentVideoEl: HTMLVideoElement | null = null
let _cachedItemId = ''
let _pendingItemId = ''
let _speedRate = 2.0

export function getCurrentVideoEl(): HTMLVideoElement | null { return _currentVideoEl }
export function getSpeedRate(): number { return _speedRate }

export function setVideoEl(v: HTMLVideoElement | null, pendingId: string): void {
  _currentVideoEl = v
  _pendingItemId = pendingId
}

export function setSpeedRate(r: number): void {
  if (r >= 1.25) _speedRate = r
}

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

export function getItemId(): string {
  const videoId = _currentVideoEl
    ? extractItemIdFromVideoSrc(_currentVideoEl.currentSrc || _currentVideoEl.src) : ''
  if (_pendingItemId) {
    if (videoId === _pendingItemId) { _pendingItemId = '' } else { return _pendingItemId }
  }
  return videoId || extractItemIdFromUrl(window.location.href) || extractItemIdFromUrl(window.location.hash) || _cachedItemId
}

export function cacheItemIdFromUrl(url: string): void {
  const id = extractItemIdFromUrl(url)
  if (id) _cachedItemId = id
}

export function getPendingItemId(): string { return _pendingItemId }
