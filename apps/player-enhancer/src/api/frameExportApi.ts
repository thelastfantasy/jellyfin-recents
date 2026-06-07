import type { FrameInfoEntry } from '../core/state'
import { apiUrl, fetchApi } from '../lib/fetchApi'
import { getAccessToken, getApiBaseUrl } from '../lib/utils'
import { suite } from './routes'

export function frameUrl(itemId: string, fiIdx: number, posMs: number, width: number): string {
  return suite.frameExport.jpeg(itemId, fiIdx, posMs, width)
}

export type FrameBatchCallback = (frames: FrameInfoEntry[]) => void

export type FpsCallback = (fps: { num: number; den: number }) => void

export function openFrameInfoStream(
  itemId: string,
  currentTimeMs: number,
  onBatch: FrameBatchCallback,
  onFps: FpsCallback,
  onDone: () => void,
  onError: () => void,
): EventSource {
  const evSrc = new EventSource(suite.frameInfoStream(itemId, currentTimeMs))
  evSrc.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data)
      if (Array.isArray(data)) onBatch(data)
      else if (data?.fps) onFps(data.fps)
      else if (data?.done === true) { onDone(); evSrc.close() }
    } catch { /* ignore */ }
  }
  evSrc.onerror = () => { evSrc.close(); onError() }
  return evSrc
}


export function openProgressStream(taskId: string): EventSource {
  return new EventSource(suite.frameExport.taskProgress(taskId))
}

export function buildResultUrl(_itemId: string, resultUrl: string): string {
  if (resultUrl.startsWith('http')) return resultUrl
  return `${getApiBaseUrl()}${resultUrl}?api_key=${encodeURIComponent(getAccessToken())}`
}

// ── Queries / Mutations ──────────────────────────────────────────────────────

export const generateExportMutation = () => ({
  mutationKey: ['generateExport'] as const,
  mutationFn: async (body: unknown) => {
    const res = await fetchApi(suite.frameExport.generate(), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as { taskId?: string }
    if (!data.taskId) throw new Error('no taskId')
    return data.taskId
  },
})

export const cancelExportMutation = () => ({
  mutationKey: ['cancelExport'] as const,
  mutationFn: async (taskId: string) => {
    await fetchApi(suite.frameExport.cancel(taskId), { method: 'POST' })
  },
})

export const deleteResultMutation = () => ({
  mutationKey: ['deleteResult'] as const,
  mutationFn: async (taskId: string) => {
    await fetchApi(suite.frameExport.result(taskId), { method: 'DELETE' })
  },
})

export type PrefetchRangeParams = (
  | { currentTimeMs: number; currentFrameIndex?: never }
  | { currentFrameIndex: number; currentTimeMs?: never }
) & {
  beforeSeconds?: number
  afterSeconds?: number
  includeCurrentFrame: boolean
  width: number
  prefetchSessionId: string
}

export function openPrefetchRangeStream(
  itemId: string,
  params: PrefetchRangeParams,
  onFrameReady: (fiIdx: number) => void,
  onDone: () => void,
  onError: () => void,
): AbortController {
  const abort = new AbortController()
  const url = apiUrl(suite.frameExport.prefetchReady(itemId))
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(params),
    signal: abort.signal,
  })
    .then(async (res) => {
      if (!res.ok || !res.body) { onError(); return }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            try {
              const data = JSON.parse(line.slice(6))
              if (data?.done) { onDone(); reader.cancel(); return }
              if (typeof data?.frameReady === 'number') onFrameReady(data.frameReady)
            } catch { /* ignore */ }
          }
        }
      } catch {
        onError()
      }
    })
    .catch((err: unknown) => {
      if ((err as { name?: string })?.name !== 'AbortError') onError()
    })
  return abort
}
