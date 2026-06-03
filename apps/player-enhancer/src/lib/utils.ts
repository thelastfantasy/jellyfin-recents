export function formatTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  const frac = String(Math.round(ms % 1000)).padStart(3, '0')
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${frac}`
}

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

export function getApiBaseUrl(): string {
  const ac = window.ApiClient
  return ac?.serverAddress?.() ?? ac?._serverAddress ?? ''
}

export function getAccessToken(): string {
  const ac = window.ApiClient
  return (typeof ac?.accessToken === 'function' ? ac.accessToken() : ac?._accessToken) ?? ''
}

export function cleanItemTitle(): string {
  return document.title.replace(/\s*[-|]\s*Jellyfin\s*$/i, '').trim()
}

export function triggerDownload(url: string, filename: string): void {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}
