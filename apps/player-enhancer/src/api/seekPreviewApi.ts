import { suite } from './routes'

export function fetchFrameStartMs(itemId: string, posMs: number): Promise<number | null> {
  return fetch(suite.seekPreview.frameInfo(itemId, posMs), { signal: AbortSignal.timeout(5000) })
    .then(res => res.ok ? res.json() as { frameStartMs?: number } : null)
    .then(data => typeof data?.frameStartMs === 'number' ? data.frameStartMs : null)
    .catch(() => null)
}

export function openSeekPreviewStream(itemId: string, posMs: number): EventSource {
  return new EventSource(suite.seekPreview.readyStream(itemId, posMs))
}

export function warmSeekPreviewCache(itemId: string, posMs: number): void {
  void fetch(suite.seekPreview.frame(itemId, posMs) + '&prefetch=true')
}
