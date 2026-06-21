// Manually maintained types for SSE events and metadata not covered by the OpenAPI spec.
// REST request/response types come from types/jellyfin-suite-api.ts (auto-generated).

// ── GET /FrameExport/Progress (SSE) ─────────────────────────────────────────

export interface TaskProgressEvent {
  taskId: string
  status: 'running' | 'complete' | 'error' | 'fallback' | 'cancelled'
  phase: string
  current: number
  total: number
  percent: number
  resultUrl?: string
  fileSize?: number
  error?: string
}

// ── Frame quality metadata ───────────────────────────────────────────────────

export interface FrameQualityMeta {
  positionMs: number
  brightnessVar: number
  laplacianVar: number
  frameDiff: number
  isJunk: boolean
  junkReason?: string
}

// ── GET /FrameExport/Health ──────────────────────────────────────────────────

export interface HealthResponse {
  available: boolean
  activeTasks: number
}
