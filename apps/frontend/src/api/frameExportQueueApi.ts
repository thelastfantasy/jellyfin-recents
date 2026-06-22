const BASE = '/JellyfinSuite/FrameExport'

declare const window: Window & { ApiClient?: { accessToken(): string } }

function authHeaders(): Record<string, string> {
  const token = window.ApiClient?.accessToken()
  return token
    ? { 'Authorization': `MediaBrowser Token="${token}"`, 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json' }
}

async function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, headers: { ...authHeaders(), ...(init?.headers ?? {}) } })
}

export interface FrameExportTaskDto {
  taskId: string
  itemId: string
  itemTitle: string
  type: 'animate' | 'stitch'
  status: 'pending' | 'running' | 'complete' | 'error' | 'cancelled'
  resultUrl: string | null
  fileSize: number | null
  error: string | null
  createdAt: number
  upscaled: boolean
  upscaledResultUrl: string | null
  upscaledFileSize: number | null
  upscaledMimeType: string | null
}

export async function listTasks(): Promise<FrameExportTaskDto[]> {
  try {
    const res = await apiFetch(`${BASE}/Tasks`)
    if (!res.ok) return []
    const raw: any[] = await res.json()
    return raw.map(d => ({
      taskId:    d.taskId    ?? '',
      itemId:    d.itemId    ?? '',
      itemTitle: d.itemTitle ?? '',
      type:      (d.type   ?? 'animate') as FrameExportTaskDto['type'],
      status:    (d.status ?? 'running') as FrameExportTaskDto['status'],
      resultUrl: d.resultUrl ?? null,
      fileSize:  d.fileSize  ?? null,
      error:     d.error     ?? null,
      createdAt: d.createdAt ?? 0,
      upscaled:  d.upscaled  ?? false,
      upscaledResultUrl: d.upscaledResultUrl ?? null,
      upscaledFileSize:  d.upscaledFileSize  ?? null,
      upscaledMimeType:  d.upscaledMimeType  ?? null,
    }))
  } catch {
    return []
  }
}

export function withAuth(url: string): string {
  const token = window.ApiClient?.accessToken()
  return token ? `${url}?api_key=${encodeURIComponent(token)}` : url
}

export async function deleteTask(taskId: string): Promise<void> {
  await apiFetch(`${BASE}/Result/${taskId}`, { method: 'DELETE' })
}

export interface FallbackEventDto {
  type: string
  reason: string
  timestamp: string
}

export interface GenerationLogDto {
  algorithm: string
  modelFileName: string
  modelVersion: string
  ortVersion: string
  deviceName: string
  deviceType: string
  deviceId: string
  keypointMatchCount: number
  inferenceDurationMs: number
  totalDurationMs: number
  fallbacks: FallbackEventDto[]
}

/** Fetches the GenerationLog for a completed stitch task. Throws if not found/not a stitch task. */
export async function getGenerationLog(taskId: string): Promise<GenerationLogDto> {
  const res = await apiFetch(`${BASE}/Result/${taskId}/generation-log.json`)
  if (!res.ok) throw new Error(`generation-log fetch failed: ${res.status}`)
  return res.json() as Promise<GenerationLogDto>
}
