// Auto-maintained TypeScript types matching C# FrameExportDto.cs
// All field names are camelCase (matching [JsonPropertyName] attributes on C# DTOs).
// When adding/renaming C# DTO properties, update here in sync.

// ── POST /FrameExport/Prefetch/{itemId} ──────────────────────────────────────

export interface PrefetchRequest {
  positions: number[]
  width: number
}

// ── POST /FrameExport/Generate ───────────────────────────────────────────────

export interface GenerateRequest {
  itemId: string
  itemTitle: string
  type: 'animate' | 'stitch'
  frames: FrameReference[]
  params: ExportParams
}

export interface FrameReference {
  positionMs: number
}

export interface ExportParams {
  format: string
  resizeMode: 'width' | 'height'
  customWidth: number | null
  customHeight: number | null
  resolutionPreset: string
  fps: number
  loopCount: number
}

export interface GenerateResponse {
  taskId: string
}

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
