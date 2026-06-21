import { queryOptions } from '@tanstack/react-query'

import type {
  FallbackEventDto,
  UpscaleJobDto,
  UpscaleJobLogDto,
  UpscaleStartRequestDto,
} from '@jfs/api-types'

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
  const res = await fetchApi(suite.frameExport.generationLog(taskId))
  if (!res.ok) throw new Error(`generation-log fetch failed: ${res.status}`)
  return res.json() as Promise<GenerationLogDto>
}

// ── Device / model / ORT version selection (spec 012 US2/US3/US6) ───────────

export interface ComputeDeviceDto {
  id: string
  displayName: string
  deviceType: 'GPU' | 'CPU'
  vendor: string
  vramMb: number | null
  isIntegrated: boolean
  isDefault: boolean
  computeCapability: string | null
  modelName: string | null
  devicePath: string | null
}

export interface ModelEntryDto {
  family: string
  displayName: string
  version: string
  fileName: string
  fileSizeBytes: number | null
  sha256: string | null
  downloadUrl: string | null
  releaseDate: string | null
  status: 'installed' | 'catalog'
  localPath: string | null
  lastUsedAt: string | null
  isLatest: boolean
}

export interface ModelListDto {
  models: ModelEntryDto[]
  catalogFetchedAt: string | null
  catalogStale: boolean
}

export interface OrtAssetDto {
  url: string
  sha256: string
  sizeBytes: number
}

export interface OrtVersionDto {
  version: string
  releaseDate: string | null
  isActive: boolean
  localDir: string | null
  installedAt: string | null
  assets: Record<string, OrtAssetDto> | null
  status: 'installed' | 'catalog'
}

export interface OrtVersionListDto {
  activeVersion: string | null
  versions: OrtVersionDto[]
  maxRetainedVersions: number
}

export async function fetchDevices(): Promise<ComputeDeviceDto[]> {
  const res = await fetchApi(suite.stitch.devices())
  if (!res.ok) throw new Error(`devices fetch failed: ${res.status}`)
  const data = await res.json() as { devices: ComputeDeviceDto[] }
  return data.devices
}

export const devicesQuery = () =>
  queryOptions({
    queryKey: ['stitchDevices'] as const,
    queryFn: fetchDevices,
    staleTime: 5 * 60 * 1000,
  })

export async function fetchModels(): Promise<ModelListDto> {
  const res = await fetchApi(suite.stitch.models())
  if (!res.ok) throw new Error(`models fetch failed: ${res.status}`)
  return res.json() as Promise<ModelListDto>
}

export const modelsQuery = () =>
  queryOptions({
    queryKey: ['stitchModels'] as const,
    queryFn: fetchModels,
    staleTime: 60 * 1000,
  })

export async function fetchOrtVersions(): Promise<OrtVersionListDto> {
  const res = await fetchApi(suite.stitch.ortVersions())
  if (!res.ok) throw new Error(`ort versions fetch failed: ${res.status}`)
  return res.json() as Promise<OrtVersionListDto>
}

export const ortVersionsQuery = () =>
  queryOptions({
    queryKey: ['stitchOrtVersions'] as const,
    queryFn: fetchOrtVersions,
    staleTime: 60 * 1000,
  })

export const downloadModelMutation = () => ({
  mutationKey: ['downloadModel'] as const,
  mutationFn: async (body: { family: string; version: string }) => {
    const res = await fetchApi(suite.stitch.modelDownload(), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  },
})

export function openModelDownloadProgressStream(family: string, version: string): EventSource {
  return new EventSource(suite.stitch.modelDownloadProgress(family, version))
}

export const deleteModelMutation = () => ({
  mutationKey: ['deleteModel'] as const,
  mutationFn: async ({ family, version }: { family: string; version: string }) => {
    const res = await fetchApi(suite.stitch.modelDelete(family, version), { method: 'DELETE' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  },
})

export const downloadOrtVersionMutation = () => ({
  mutationKey: ['downloadOrtVersion'] as const,
  mutationFn: async (body: { version: string }) => {
    const res = await fetchApi(suite.stitch.ortVersionDownload(), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  },
})

export function openOrtVersionDownloadProgressStream(version: string): EventSource {
  return new EventSource(suite.stitch.ortVersionDownloadProgress(version))
}

export const activateOrtVersionMutation = () => ({
  mutationKey: ['activateOrtVersion'] as const,
  mutationFn: async (body: { version: string }) => {
    const res = await fetchApi(suite.stitch.ortVersionActivate(), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  },
})

// ── Upscale (spec 012 US7) ───────────────────────────────────────────────────
// DTOs (UpscaleJobDto/UpscaleJobLogDto/UpscaleStartRequestDto) come from
// @jfs/api-types, generated from the C# DTOs via `mise run gen-types` — see JfsSpec.cs's
// AddStitchPaths. Narrower unions (e.g. modelStyle: 'photo' | 'anime') are kept on the function
// parameters below for compile-time safety; the generated types only know the wire shape is
// `string`, since JfsSpecGen doesn't model C#-side string-literal validation as OpenAPI enums.

export const startUpscaleMutation = () => ({
  mutationKey: ['startUpscale'] as const,
  mutationFn: async (body: { resultPath: string; scale: 1 | 2 | 4; modelScale: 2 | 4; modelStyle: 'photo' | 'anime'; faceRestore: boolean; deviceId?: string }) => {
    const reqBody: UpscaleStartRequestDto = body
    const res = await fetchApi(suite.stitch.upscale(), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reqBody),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as Partial<UpscaleJobDto>
    if (!data.jobId) throw new Error('no jobId')
    return data.jobId
  },
})

export async function fetchUpscaleStatus(jobId: string): Promise<UpscaleJobDto> {
  const res = await fetchApi(suite.stitch.upscaleStatus(jobId))
  if (!res.ok) throw new Error(`upscale status fetch failed: ${res.status}`)
  return res.json() as Promise<UpscaleJobDto>
}

export const cancelUpscaleMutation = () => ({
  mutationKey: ['cancelUpscale'] as const,
  mutationFn: async (jobId: string) => {
    await fetchApi(suite.stitch.upscaleCancel(jobId), { method: 'POST' })
  },
})

/** Fetches diagnostics (device actually used, GPU fallbacks) for an upscale job — available
 * regardless of source export type, since upscale always invokes ORT. */
export async function getUpscaleLog(jobId: string): Promise<UpscaleJobLogDto> {
  const res = await fetchApi(suite.stitch.upscaleLog(jobId))
  if (!res.ok) throw new Error(`upscale log fetch failed: ${res.status}`)
  return res.json() as Promise<UpscaleJobLogDto>
}

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
  onFrameFailed?: (fiIdx: number) => void,
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
              if (typeof data?.frameFailed === 'number') onFrameFailed?.(data.frameFailed)
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
