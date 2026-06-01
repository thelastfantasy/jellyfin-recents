import type { components } from '@jfs/api-types'

type GenerateRequest = components['schemas']['GenerateRequest']
type GenerateResponse = components['schemas']['GenerateResponse']
type PrefetchRequest  = components['schemas']['PrefetchRequest']

function getBaseUrl(): string {
  const ac = (window as any).ApiClient
  return ac?.serverAddress?.() ?? ac?._serverAddress ?? ''
}

function getToken(): string {
  const ac = (window as any).ApiClient
  return (typeof ac?.accessToken === 'function' ? ac.accessToken() : ac?._accessToken) ?? ''
}

export function frameUrl(itemId: string, fiIdx: number, posMs: number, width: number): string {
  const base  = getBaseUrl()
  const token = getToken()
  if (fiIdx >= 0) {
    return `${base}/JellyfinSuite/FrameExport/${itemId}?frameIdx=${fiIdx}&width=${width}&api_key=${encodeURIComponent(token)}`
  }
  return `${base}/JellyfinSuite/FrameExport/${itemId}?positionMs=${Math.round(posMs)}&width=${width}&api_key=${encodeURIComponent(token)}`
}

export async function fetchVideoFps(itemId: string): Promise<{ num: number; den: number }> {
  try {
    const res = await fetch(
      `${getBaseUrl()}/Items/${itemId}?Fields=MediaStreams&api_key=${encodeURIComponent(getToken())}`
    )
    if (!res.ok) return { num: 24, den: 1 }
    const data = await res.json() as {
      MediaStreams?: Array<{ Type?: string; RealFrameRate?: number; AverageFrameRate?: number }>
    }
    const vid = data.MediaStreams?.find(s => s.Type === 'Video')
    const fps = vid?.RealFrameRate ?? vid?.AverageFrameRate ?? 24
    return snapFpsToRational(fps)
  } catch {
    return { num: 24, den: 1 }
  }
}

export function snapFpsToRational(fps: number): { num: number; den: number } {
  const table: Array<[number, number, number]> = [
    [23.976, 24000, 1001], [24, 24, 1], [25, 25, 1],
    [29.97, 30000, 1001], [30, 30, 1],
    [47.952, 48000, 1001], [48, 48, 1],
    [50, 50, 1],
    [59.94, 60000, 1001], [60, 60, 1],
    [119.88, 120000, 1001], [120, 120, 1],
  ]
  for (const [f, n, d] of table) {
    if (Math.abs(fps - f) < 0.05) return { num: n, den: d }
  }
  return { num: Math.round(fps * 1000), den: 1000 }
}

export async function fetchFrameIndex(itemId: string): Promise<{
  frames: Array<{ ms: number; isKey: boolean }>
  fps: { num: number; den: number }
} | null> {
  try {
    const res = await fetch(
      `${getBaseUrl()}/JellyfinSuite/${itemId}/FrameInfo?api_key=${encodeURIComponent(getToken())}`
    )
    if (!res.ok) return null
    const data = await res.json() as {
      frames: Array<{ ms: number; isKey: boolean }>
      fps: { num: number; den: number }
    }
    if (!data.frames?.length) return null
    return data
  } catch {
    return null
  }
}

export async function prefetch(
  itemId: string,
  items: Array<{ fiIdx: number; posMs: number }>,
  width: number,
): Promise<void> {
  const base  = getBaseUrl()
  const token = getToken()
  const useIdx = items.every(it => it.fiIdx >= 0)
  const body: PrefetchRequest = useIdx
    ? { frameIndices: items.map(it => it.fiIdx), width } as any
    : { positions: items.map(it => Math.round(it.posMs)), width }
  try {
    await fetch(
      `${base}/JellyfinSuite/FrameExport/Prefetch/${itemId}?api_key=${encodeURIComponent(token)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    )
  } catch { /* proceed even if prefetch fails */ }
}

export function openPrefetchStream(
  itemId: string,
  width: number,
): EventSource {
  const base  = getBaseUrl()
  const token = getToken()
  return new EventSource(
    `${base}/JellyfinSuite/FrameExport/PrefetchReady/${itemId}?width=${width}&api_key=${encodeURIComponent(token)}`
  )
}

export async function fetchFrameBlob(url: string): Promise<{ blob: Blob; ptsMs: number | null }> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const ptsHeader = res.headers.get('X-Frame-Pts-Ms')
  const ptsMs = ptsHeader ? parseInt(ptsHeader) : null
  const blob = await res.blob()
  return { blob, ptsMs: ptsMs !== null && !isNaN(ptsMs) && ptsMs >= 0 ? ptsMs : null }
}

export async function generateExport(body: GenerateRequest): Promise<string> {
  const res = await fetch(
    `${getBaseUrl()}/JellyfinSuite/FrameExport/Generate?api_key=${encodeURIComponent(getToken())}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  )
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const { taskId } = await res.json() as GenerateResponse
  if (!taskId) throw new Error('no taskId')
  return taskId
}

export function openProgressStream(taskId: string): EventSource {
  const base  = getBaseUrl()
  const token = getToken()
  return new EventSource(
    `${base}/JellyfinSuite/FrameExport/Progress?taskId=${encodeURIComponent(taskId)}&api_key=${encodeURIComponent(token)}`
  )
}

export async function cancelExport(taskId: string): Promise<void> {
  await fetch(
    `${getBaseUrl()}/JellyfinSuite/FrameExport/Cancel/${taskId}?api_key=${encodeURIComponent(getToken())}`,
    { method: 'POST' }
  ).catch(() => {})
}

export async function deleteResult(taskId: string): Promise<void> {
  await fetch(
    `${getBaseUrl()}/JellyfinSuite/FrameExport/Result/${taskId}?api_key=${encodeURIComponent(getToken())}`,
    { method: 'DELETE' }
  ).catch(() => {})
}

export function buildResultUrl(itemId: string, resultUrl: string): string {
  const base  = getBaseUrl()
  const token = getToken()
  void itemId
  return resultUrl.startsWith('http')
    ? resultUrl
    : `${base}${resultUrl}?api_key=${encodeURIComponent(token)}`
}
