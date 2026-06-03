import { jf } from './routes'

export async function fetchItemName(itemId: string): Promise<string | null> {
  try {
    const res = await fetch(jf.item(itemId), { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return null
    const data = await res.json() as { Name?: string }
    return data.Name ?? null
  } catch {
    return null
  }
}

export async function fetchVideoFps(itemId: string): Promise<{ num: number; den: number }> {
  try {
    const res = await fetch(jf.item(itemId, 'MediaStreams'))
    if (!res.ok) return { num: 24, den: 1 }
    const data = await res.json() as {
      MediaStreams?: Array<{ Type?: string; RealFrameRate?: number; AverageFrameRate?: number }>
    }
    const vid = data.MediaStreams?.find(s => s.Type === 'Video')
    return snapFps(vid?.RealFrameRate ?? vid?.AverageFrameRate ?? 24)
  } catch {
    return { num: 24, den: 1 }
  }
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
