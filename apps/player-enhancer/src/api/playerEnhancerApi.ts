import { queryOptions } from '@tanstack/react-query'

import { fetchApi } from '../lib/fetchApi'
import { suite } from './routes'

export interface PlayerEnhancerConfig {
  trickplayEnabled?: boolean
  seekSeconds?: number
  speedRate?: number
}

export const enhancerConfigQuery = queryOptions({
  queryKey: ['playerEnhancerConfig'],
  queryFn: async () => {
    const res = await fetchApi(suite.playerEnhancer.config())
    if (!res.ok) return null
    return await res.json() as PlayerEnhancerConfig
  },
  staleTime: 60 * 60 * 1000,
  retry: 5,  // ApiClient may not be ready at first call
})
