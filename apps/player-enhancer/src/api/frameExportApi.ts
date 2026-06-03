import type { components } from '@jfs/api-types'
import { getApiBaseUrl, getAccessToken } from '../lib/utils'

type GenerateRequest = components['schemas']['GenerateRequest']
type GenerateResponse = components['schemas']['GenerateResponse']

export function frameUrl(itemId: string, fiIdx: number, posMs: number, width: number): string {
  const base  = getApiBaseUrl()
  const token = getAccessToken()
  if (fiIdx >= 0) {
    return `${base}/JellyfinSuite/FrameExport/${itemId}?frameIdx=${fiIdx}&width=${width}&api_key=${encodeURIComponent(token)}`
  }
  return `${base}/JellyfinSuite/FrameExport/${itemId}?positionMs=${Math.round(posMs)}&width=${width}&api_key=${encodeURIComponent(token)}`
}

export async function fetchVideoFps(itemId: string): Promise<{ num: number; den: number }> {
  try {
    const res = await fetch(
      `${getApiBaseUrl()}/Items/${itemId}?Fields=MediaStreams&api_key=${encodeURIComponent(getAccessToken())}`
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

export type FrameBatchCallback = (frames: Array<{ ms: number; isKey: boolean; frameIndex: number }>) => void
export type FpsCallback = (fps: { num: number; den: number }) => void

export function openFrameInfoStream(
  itemId: string,
  currentTimeMs: number,
  onBatch: FrameBatchCallback,
  onDone: FpsCallback,
  onError: () => void,
): EventSource {
  const base  = getApiBaseUrl()
  const token = getAccessToken()
  const url = `${base}/JellyfinSuite/${itemId}/FrameInfoStream?currentTimeMs=${currentTimeMs}&api_key=${encodeURIComponent(token)}`
  const evSrc = new EventSource(url)
  evSrc.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data)
      if (Array.isArray(data)) {
        onBatch(data)
      } else if (data?.fps) {
        onDone(data.fps)
        evSrc.close()
      }
    } catch { /* malformed event, ignore */ }
  }
  evSrc.onerror = () => {
    evSrc.close()
    onError()
  }
  return evSrc
}

export function openPrefetchStream(
  itemId: string,
  width: number,
  fiIdx: number[],
): EventSource {
  const base  = getApiBaseUrl()
  const token = getAccessToken()
  const idxParam = fiIdx.join(',')
  return new EventSource(
    `${base}/JellyfinSuite/FrameExport/PrefetchReady/${itemId}?width=${width}&fiIdx=${encodeURIComponent(idxParam)}&api_key=${encodeURIComponent(token)}`
  )
}

export async function generateExport(body: GenerateRequest): Promise<string> {
  const res = await fetch(
    `${getApiBaseUrl()}/JellyfinSuite/FrameExport/Generate?api_key=${encodeURIComponent(getAccessToken())}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  )
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const { taskId } = await res.json() as GenerateResponse
  if (!taskId) throw new Error('no taskId')
  return taskId
}

export function openProgressStream(taskId: string): EventSource {
  const base  = getApiBaseUrl()
  const token = getAccessToken()
  return new EventSource(
    `${base}/JellyfinSuite/FrameExport/TaskProgress?taskId=${encodeURIComponent(taskId)}&api_key=${encodeURIComponent(token)}`
  )
}

export async function cancelExport(taskId: string): Promise<void> {
  await fetch(
    `${getApiBaseUrl()}/JellyfinSuite/FrameExport/Cancel/${taskId}?api_key=${encodeURIComponent(getAccessToken())}`,
    { method: 'POST' }
  ).catch(() => {})
}

export async function deleteResult(taskId: string): Promise<void> {
  await fetch(
    `${getApiBaseUrl()}/JellyfinSuite/FrameExport/Result/${taskId}?api_key=${encodeURIComponent(getAccessToken())}`,
    { method: 'DELETE' }
  ).catch(() => {})
}

export function buildResultUrl(itemId: string, resultUrl: string): string {
  const base  = getApiBaseUrl()
  const token = getAccessToken()
  void itemId
  return resultUrl.startsWith('http')
    ? resultUrl
    : `${base}${resultUrl}?api_key=${encodeURIComponent(token)}`
}
