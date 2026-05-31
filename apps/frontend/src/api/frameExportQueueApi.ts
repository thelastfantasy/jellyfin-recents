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
