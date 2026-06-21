/**
 * Base URL resolver — injected at runtime by the consuming app.
 * Call setApiBase() once at startup (before any generated API functions).
 */
let _base = ''
let _apiKey = ''

export function setApiBase(base: string) {
  _base = base.replace(/\/$/, '')
}

export function setApiKey(key: string) {
  _apiKey = key
}

/**
 * Custom mutator used by orval-generated client functions.
 * Signature: apiFetch<T>(url: string, init?: RequestInit) — matches orval's fetch mutator contract.
 * Prepends the configured base URL and appends api_key to every request.
 * SSE endpoints should NOT use this — use sseUrl() to build the URL, then EventSource/fetch manually.
 */
export async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const sep = url.includes('?') ? '&' : '?'
  const fullUrl = `${_base}${url}${_apiKey ? `${sep}api_key=${encodeURIComponent(_apiKey)}` : ''}`
  const res = await fetch(fullUrl, init)
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
  if (res.status === 204) return undefined as T
  return res.json() as T
}

/**
 * Build a fully-qualified URL for an SSE endpoint (includes base + api_key).
 * Usage: new EventSource(sseUrl('/JellyfinSuite/.../FrameInfoStream', { currentTimeMs: 1234 }))
 */
export function sseUrl(path: string, params?: Record<string, string | number | boolean | undefined>): string {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined) qs.set(k, String(v))
  }
  if (_apiKey) qs.set('api_key', _apiKey)
  const query = qs.toString()
  return `${_base}${path}${query ? `?${query}` : ''}`
}
