import { queryOptions } from '@tanstack/react-query'

import { apiUrl,fetchApi } from '../lib/fetchApi'
import { suite } from './routes'

export const frameStartMsQuery = (itemId: string, posMs: number) =>
  queryOptions({
    queryKey: ['frameStartMs', itemId, posMs],
    queryFn: () =>
      fetchApi(suite.seekPreview.frameInfo(itemId, posMs), { signal: AbortSignal.timeout(5000) })
        .then(res => {
          if (!res.ok) return null
          return res.json() as { frameStartMs?: number }
        })
        .then(data => (data && typeof data.frameStartMs === 'number') ? data.frameStartMs : null),
    staleTime: 60 * 1000,
  })

export function openSeekPreviewStream(itemId: string, posMs: number): EventSource {
  return new EventSource(apiUrl(suite.seekPreview.readyStream(itemId, posMs)))
}

export function warmSeekPreviewCache(itemId: string, posMs: number): void {
  void fetchApi(suite.seekPreview.frame(itemId, posMs) + '&prefetch=true')
}
