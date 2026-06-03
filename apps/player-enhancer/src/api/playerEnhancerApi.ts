import { getAccessToken, getApiBaseUrl } from '../lib/utils'

export interface PlayerEnhancerConfig {
  trickplayEnabled?: boolean
  seekSeconds?: number
  speedRate?: number
}

export async function fetchEnhancerConfig(): Promise<PlayerEnhancerConfig | null> {
  let token = getAccessToken()
  for (let i = 0; i < 10 && !token; i++) {
    await new Promise<void>(r => setTimeout(r, 500))
    token = getAccessToken()
  }
  if (!token) return null
  try {
    const res = await fetch(`${getApiBaseUrl()}/JellyfinSuite/PlayerEnhancer/Config?api_key=${encodeURIComponent(token)}`)
    if (!res.ok) return null
    return await res.json() as PlayerEnhancerConfig
  } catch {
    return null
  }
}
