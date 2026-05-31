export interface EnhancerStatus {
  autoInjectEnabled: boolean
}

export interface GestureConfig {
  trickplayEnabled: boolean
  seekSeconds: number  // 0.5 – 30
  speedRate: number    // 1.25 – 4.0
}

export async function getEnhancerStatus(): Promise<EnhancerStatus> {
  if (!window.ApiClient) throw new Error('ApiClient unavailable')
  const url = window.ApiClient.getUrl('JellyfinSuite/PlayerEnhancer/Status')
  const data = await window.ApiClient.ajax({ url, type: 'GET', dataType: 'json' })
  return data as EnhancerStatus
}

export async function injectEnhancer(): Promise<void> {
  if (!window.ApiClient) throw new Error('ApiClient unavailable')
  const url = window.ApiClient.getUrl('JellyfinSuite/PlayerEnhancer/Inject')
  await window.ApiClient.ajax({ url, type: 'POST' })
}

export async function removeEnhancer(): Promise<void> {
  if (!window.ApiClient) throw new Error('ApiClient unavailable')
  const url = window.ApiClient.getUrl('JellyfinSuite/PlayerEnhancer/Inject')
  await window.ApiClient.ajax({ url, type: 'DELETE' })
}

export async function getGestureConfig(): Promise<GestureConfig> {
  if (!window.ApiClient) throw new Error('ApiClient unavailable')
  const url = window.ApiClient.getUrl('JellyfinSuite/PlayerEnhancer/Config')
  const data = await window.ApiClient.ajax({ url, type: 'GET', dataType: 'json' })
  return data as GestureConfig
}

export async function setGestureConfig(cfg: GestureConfig): Promise<void> {
  if (!window.ApiClient) throw new Error('ApiClient unavailable')
  const url = window.ApiClient.getUrl('JellyfinSuite/PlayerEnhancer/Config')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (window.ApiClient.ajax as any)({ url, type: 'PATCH', data: JSON.stringify(cfg), contentType: 'application/json' })
}
