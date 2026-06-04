import type { FrameInfoEntry } from '../core/state'

import { fetchApi } from '../lib/fetchApi'
import { getAccessToken, getApiBaseUrl } from '../lib/utils'
import { suite } from './routes'

export function frameUrl(itemId: string, fiIdx: number, posMs: number, width: number): string {
  return suite.frameExport.jpeg(itemId, fiIdx, posMs, width)
}

export type FrameBatchCallback = (frames: FrameInfoEntry[]) => void

export type FpsCallback = (fps: { num: number; den: number }) => void

export function openFrameInfoStream(itemId: string, currentTimeMs: number,
  onBatch: FrameBatchCallback, onDone: FpsCallback, onError: () => void,
): EventSource {
  const evSrc = new EventSource(suite.frameInfoStream(itemId, currentTimeMs))
  evSrc.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data)
      if (Array.isArray(data)) onBatch(data)
      else if (data?.fps) { onDone(data.fps); evSrc.close() }
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
