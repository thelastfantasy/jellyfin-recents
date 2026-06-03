import { queryOptions } from '@tanstack/react-query'
import { getAccessToken } from '../lib/utils'
import { suite } from './routes'

export interface PlayerEnhancerConfig {
  trickplayEnabled?: boolean
  seekSeconds?: number
  speedRate?: number
}

export const enhancerConfigQuery = queryOptions({
  queryKey: ['playerEnhancerConfig'],
  queryFn: async () => {
    let token = getAccessToken()
    for (let i = 0; i < 10 && !token; i++) {
      await new Promise<void>(r => setTimeout(r, 500))
      token = getAccessToken()
    }
    if (!token) return null
    const res = await fetch(suite.playerEnhancer.config())
    if (!res.ok) return null
    return await res.json() as PlayerEnhancerConfig
  },
  staleTime: 60 * 60 * 1000,
})
