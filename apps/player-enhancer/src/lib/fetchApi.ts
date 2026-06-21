import { getAccessToken } from './utils'

export function apiUrl(url: string): string {
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}api_key=${encodeURIComponent(getAccessToken())}`
}

export function fetchApi(url: string, init?: RequestInit): Promise<Response> {
  return fetch(apiUrl(url), init)
}
