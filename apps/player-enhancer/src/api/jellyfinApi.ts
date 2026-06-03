import { queryOptions } from '@tanstack/react-query'
import { jf } from './routes'

export const itemNameQuery = (itemId: string) =>
  queryOptions({
    queryKey: ['itemName', itemId],
    queryFn: async () => {
      const res = await fetch(jf.item(itemId), { signal: AbortSignal.timeout(3000) })
      if (!res.ok) return null
      const data = await res.json() as { Name?: string }
      return data.Name ?? null
    },
    staleTime: 10 * 60 * 1000,
  })

export const videoFpsQuery = (itemId: string) =>
  queryOptions({
    queryKey: ['videoFps', itemId],
    queryFn: async () => {
      const res = await fetch(jf.item(itemId, 'MediaStreams'))
      if (!res.ok) return { num: 24, den: 1 }
      const data = await res.json() as {
        MediaStreams?: Array<{ Type?: string; RealFrameRate?: number; AverageFrameRate?: number }>
      }
      const vid = data.MediaStreams?.find(s => s.Type === 'Video')
      return snapFps(vid?.RealFrameRate ?? vid?.AverageFrameRate ?? 24)
    },
    staleTime: 10 * 60 * 1000,
  })

// Legacy: imperative version used by non-React code (screenshot.ts)
export async function fetchItemName(itemId: string): Promise<string | null> {
  try {
    const res = await fetch(jf.item(itemId), { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return null
    const data = await res.json() as { Name?: string }
    return data.Name ?? null
  } catch { return null }
}

function snapFps(fps: number): { num: number; den: number } {
  const table: Array<[number, number, number]> = [
    [23.976, 24000, 1001], [24, 24, 1], [25, 25, 1],
    [29.97, 30000, 1001], [30, 30, 1],
    [47.952, 48000, 1001], [48, 48, 1],
    [50, 50, 1],
    [59.94, 60000, 1001], [60, 60, 1],
    [119.88, 120000, 1001], [120, 120, 1],
  ]
  for (const [f, n, d] of table) if (Math.abs(fps - f) < 0.05) return { num: n, den: d }
  return { num: Math.round(fps * 1000), den: 1000 }
}
