import type { components } from '@jfs/api-types'
import { suite } from './routes'
export { fetchVideoFps } from './jellyfinApi'

type GenerateRequest = components['schemas']['GenerateRequest']
type GenerateResponse = components['schemas']['GenerateResponse']

export function frameUrl(itemId: string, fiIdx: number, posMs: number, width: number): string {
  return suite.frameExport.jpeg(itemId, fiIdx, posMs, width)
}

export type FrameBatchCallback = (frames: Array<{ ms: number; isKey: boolean; frameIndex: number }>) => void
export type FpsCallback = (fps: { num: number; den: number }) => void

export function openFrameInfoStream(
  itemId: string, currentTimeMs: number,
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

export function openPrefetchStream(itemId: string, width: number, fiIdx: number[]): EventSource {
  return new EventSource(suite.frameExport.prefetchReady(itemId, width, fiIdx))
}

export async function generateExport(body: GenerateRequest): Promise<string> {
  const res = await fetch(suite.frameExport.generate(), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const { taskId } = await res.json() as GenerateResponse
  if (!taskId) throw new Error('no taskId')
  return taskId
}

export function openProgressStream(taskId: string): EventSource {
  return new EventSource(suite.frameExport.taskProgress(taskId))
}

export async function cancelExport(taskId: string): Promise<void> {
  await fetch(suite.frameExport.cancel(taskId), { method: 'POST' }).catch(() => {})
}

export async function deleteResult(taskId: string): Promise<void> {
  await fetch(suite.frameExport.result(taskId), { method: 'DELETE' }).catch(() => {})
}

import { getApiBaseUrl, getAccessToken } from '../lib/utils'

export function buildResultUrl(_itemId: string, resultUrl: string): string {
  if (resultUrl.startsWith('http')) return resultUrl
  return `${getApiBaseUrl()}${resultUrl}?api_key=${encodeURIComponent(getAccessToken())}`
}
