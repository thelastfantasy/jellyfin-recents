import { queryOptions } from '@tanstack/react-query'

import { fetchApi } from '../lib/fetchApi'
import { jf } from './routes'

export const itemNameQuery = (itemId: string) =>
  queryOptions({
    queryKey: ['itemName', itemId],
    queryFn: async () => {
      const res = await fetchApi(jf.item(itemId), { signal: AbortSignal.timeout(3000) })
      if (!res.ok) return null
      const data = await res.json() as { Name?: string }
      return data.Name ?? null
    },
    staleTime: 10 * 60 * 1000,
  })

// Legacy: imperative version used by non-React code (screenshot.ts)
export async function fetchItemName(itemId: string): Promise<string | null> {
  try {
    const res = await fetchApi(jf.item(itemId), { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return null
    const data = await res.json() as { Name?: string }
    return data.Name ?? null
  } catch { return null }
}
