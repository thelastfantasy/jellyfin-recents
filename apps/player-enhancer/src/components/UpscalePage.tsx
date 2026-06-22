import { useMutation } from '@tanstack/react-query'
import { useAtomValue } from 'jotai'
import { useEffect, useRef, useState } from 'react'

import type { UpscaleJobDto } from '@jfs/api-types'

import {
  buildResultUrl,
  cancelUpscaleMutation,
  downloadModelMutation,
  fetchDevices,
  fetchModels,
  fetchUpscaleStatus,
  getUpscaleLog,
  openModelDownloadProgressStream,
  startUpscaleMutation,
} from '../api/frameExportApi'
import { _activeTaskId, _frames, _upscaledTaskIds, exportTypeAtom, markTaskUpscaled, resultUrlAtom } from '../core/state'
import { t } from '../lib/i18n'
import { buildExportFileName, triggerDownload } from '../lib/utils'

type Phase = 'options' | 'downloading-model' | 'processing' | 'success' | 'error'

const MODEL_FAMILY = 'realesrgan'
const PREFS_KEY = 'jfs-upscale-prefs'

interface UpscalePrefs {
  scale: 1 | 2 | 4
  modelScale: 2 | 4
  modelStyle: 'photo' | 'anime'
  faceRestore: boolean
}

function loadPrefs(): UpscalePrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (!raw) return { scale: 2, modelScale: 4, modelStyle: 'photo', faceRestore: false }
    const parsed = JSON.parse(raw) as Partial<UpscalePrefs>
    return {
      scale: parsed.scale === 4 ? 4 : parsed.scale === 1 ? 1 : 2,
      modelScale: parsed.modelScale === 2 ? 2 : 4,
      modelStyle: parsed.modelStyle === 'anime' ? 'anime' : 'photo',
      faceRestore: parsed.faceRestore === true,
    }
  } catch {
    return { scale: 2, modelScale: 4, modelStyle: 'photo', faceRestore: false }
  }
}

// "Which model runs" and "what resolution comes out" are independent choices: photo has two
// genuinely distinct trained models (x2 and x4 — different weights, not a downscale of one
// another, see research.md §4), so the frontend lets the user pick a model directly. anime never
// had a native x2 release, so it always runs anime-x4 regardless of modelScale — the model
// selector is hidden for anime (see the JSX below) and UpscaleService.StartJob enforces this
// server-side too, in case a stale modelScale ever slips through.
function resolveModelVersion(modelStyle: 'photo' | 'anime', modelScale: 2 | 4): string {
  return `${modelStyle}-x${modelStyle === 'anime' ? 4 : modelScale}`
}

// 4K 任一边即视为"已是高分辨率"，对应 spec.md Edge Cases 中"如已是 4K 全景图"的示例阈值
const ALREADY_HIGH_RES_PX = 3840

export function UpscalePage({ onBack, onClose }: {
  onBack:  () => void
  onClose: () => void
}) {
  const resultUrl = useAtomValue(resultUrlAtom)
  const exportType = useAtomValue(exportTypeAtom)
  const isAnimation = exportType === 'animate'
  const initialPrefs = loadPrefs()
  const [phase, setPhase] = useState<Phase>('options')
  const [modelStyle, setModelStyle] = useState<'photo' | 'anime'>(initialPrefs.modelStyle)
  const [modelScale, setModelScale] = useState<2 | 4>(initialPrefs.modelScale)
  // The model that actually runs (anime is always x4 — see resolveModelVersion) caps how far
  // `scale` can ask to keep: clamp on every render so switching modelStyle/modelScale never leaves
  // a stale scale selection (e.g. "x4 output" surviving a switch from the x4 model to the x2 one).
  const effectiveModelScale = modelStyle === 'anime' ? 4 : modelScale
  const [scaleRaw, setScale] = useState<1 | 2 | 4>(isAnimation ? initialPrefs.scale : (initialPrefs.scale === 1 ? 2 : initialPrefs.scale))
  const scale = Math.min(scaleRaw, effectiveModelScale) as 1 | 2 | 4
  const [faceRestore, setFaceRestore] = useState(initialPrefs.faceRestore)
  const [job, setJob] = useState<UpscaleJobDto | null>(null)
  const [errorMsg, setErrorMsg] = useState('')
  const [showAfter, setShowAfter] = useState(true)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [modelDownloadPercent, setModelDownloadPercent] = useState(0)
  const [modelDownloadError, setModelDownloadError] = useState('')
  const modelEvtSourceRef = useRef<EventSource | null>(null)
  const [modelInstalled, setModelInstalled] = useState<boolean | null>(null)
  // 动图提升画质门槛：没有 NVIDIA GPU 就不放开（见 UpscaleService.StartJob 同名校验，这里只是
  // 提前在前端拦一道，避免用户填完参数点开始才被 400 拒绝）。设备查询失败时故意 fail-open——
  // 后端仍会做权威校验，前端这里只是省一次无意义的点击。
  const [animationBlocked, setAnimationBlocked] = useState(false)

  useEffect(() => {
    if (!isAnimation) return
    let cancelled = false
    fetchDevices()
      .then(devices => { if (!cancelled) setAnimationBlocked(!devices.some(d => d.vendor === 'NVIDIA')) })
      .catch(() => { /* fetch failed — fail-open, backend still enforces this */ })
    return () => { cancelled = true }
  }, [isAnimation])

  useEffect(() => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ scale, modelScale, modelStyle, faceRestore }))
  }, [scale, modelScale, modelStyle, faceRestore])

  useEffect(() => {
    let cancelled = false
    const version = resolveModelVersion(modelStyle, modelScale)
    fetchModels()
      .then(list => {
        if (cancelled) return
        setModelInstalled(list.models.some(m => m.family === MODEL_FAMILY && m.version === version && m.status === 'installed'))
      })
      .catch(() => { if (!cancelled) setModelInstalled(null) })
    return () => { cancelled = true }
  }, [modelStyle, modelScale])

  const startMut   = useMutation(startUpscaleMutation())
  const cancelMut  = useMutation(cancelUpscaleMutation())

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])
  useEffect(() => () => modelEvtSourceRef.current?.close(), [])

  function startPolling(jobId: string) {
    pollRef.current = setInterval(async () => {
      try {
        const status = await fetchUpscaleStatus(jobId)
        setJob(status)
        if (status.status === 'succeeded') {
          if (pollRef.current) clearInterval(pollRef.current)
          markTaskUpscaled(_activeTaskId)
          setPhase('success')
        } else if (status.status === 'failed') {
          if (pollRef.current) clearInterval(pollRef.current)
          setErrorMsg(status.error ?? '')
          setPhase('error')
        } else if (status.status === 'cancelled') {
          if (pollRef.current) clearInterval(pollRef.current)
          onBack()
        }
      } catch {
        /* transient poll failure — retry on next tick */
      }
    }, 800)
  }

  function doStart() {
    startMut.mutate(
      { resultPath: resultUrl, scale, modelScale, modelStyle, faceRestore },
      {
        onSuccess: (jobId) => { setPhase('processing'); startPolling(jobId) },
        onError:   (e) => { setErrorMsg(e instanceof Error ? e.message : String(e)); setPhase('error') },
      },
    )
  }

  async function handleStart() {
    const version = resolveModelVersion(modelStyle, modelScale)
    let installed: boolean
    try {
      const list = await fetchModels()
      installed = list.models.some(m => m.family === MODEL_FAMILY && m.version === version && m.status === 'installed')
    } catch {
      // Model-list check itself failed — fall through and let the start request go through
      // as-is; UpscaleService.cs has its own on-demand download fallback for this case, just
      // without a visible progress UI.
      doStart()
      return
    }

    if (installed) { doStart(); return }

    setPhase('downloading-model')
    setModelDownloadPercent(0)
    setModelDownloadError('')
    downloadModelMutation().mutationFn({ family: MODEL_FAMILY, version })
      .then(() => {
        const evtSource = openModelDownloadProgressStream(MODEL_FAMILY, version)
        modelEvtSourceRef.current = evtSource
        evtSource.onmessage = (e) => {
          try {
            const data = JSON.parse(e.data) as { percent?: number; status?: string; error?: string }
            if (typeof data.percent === 'number') setModelDownloadPercent(data.percent)
            if (data.status === 'installed') {
              evtSource.close()
              doStart()
            } else if (data.status === 'error') {
              evtSource.close()
              setModelDownloadError(data.error ?? 'download failed')
            }
          } catch { /* ignore malformed frame */ }
        }
        evtSource.onerror = () => {
          evtSource.close()
          setModelDownloadError('connection lost')
        }
      })
      .catch(async (err: unknown) => {
        // A 409 here means "already installed" or "download already in progress" (race with
        // another concurrent trigger) rather than a real failure — re-check before erroring.
        try {
          const list = await fetchModels()
          if (list.models.some(m => m.family === MODEL_FAMILY && m.version === version && m.status === 'installed')) {
            doStart()
            return
          }
        } catch { /* fall through to the error below */ }
        setModelDownloadError(err instanceof Error ? err.message : String(err))
      })
  }

  // Same naming scheme as ResultPage.tsx's own download button — an upscaled file should read as
  // "the same export, just sharper" rather than getting an unrelated name.
  function exportFileName(suffix?: string): string {
    const selectedFrames = _frames.filter(f => f.selected)
    return buildExportFileName(exportType, selectedFrames[0]?.posMs ?? 0, selectedFrames[selectedFrames.length - 1]?.posMs ?? 0, suffix)
  }

  function handleDownloadImage() {
    if (!job?.resultUrl) return
    // Output keeps the source's extension (UpscaleService.cs sets OutputExt from the original
    // file), but job.resultUrl is a route (`/JellyfinSuite/Stitch/Upscale/{jobId}/Result`) with no
    // extension of its own — derive it from the page-level resultUrl instead, same as
    // ResultPage.tsx's handleDownload does for the un-upscaled result.
    const extension = resultUrl.split('.').pop() ?? 'png'
    triggerDownload(buildResultUrl('', job.resultUrl), `${exportFileName('upscale')}.${extension}`)
  }

  // The un-upscaled original is otherwise only downloadable from ResultPage (one modal back) —
  // but going back there loses this component's `job` state (it's plain useState, not persisted),
  // so the upscaled result becomes unreachable without re-running the job. Offering the original
  // download right here means the user never has to leave this modal to get either version.
  function handleDownloadOriginal() {
    if (!job?.originalUrl) return
    const extension = resultUrl.split('.').pop() ?? 'png'
    triggerDownload(buildResultUrl('', job.originalUrl), `${exportFileName()}.${extension}`)
  }

  async function handleDownloadLog() {
    if (!job?.jobId) return
    try {
      const log = await getUpscaleLog(job.jobId)
      const blob = new Blob([JSON.stringify(log, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      triggerDownload(url, `${exportFileName(`upscale-${job.jobId.slice(0, 6)}-log`)}.json`)
      URL.revokeObjectURL(url)
    } catch { /* upscale log unavailable — silently ignore */ }
  }

  function handleCancel() {
    if (pollRef.current) clearInterval(pollRef.current)
    if (job?.jobId) cancelMut.mutate(job.jobId)
    onBack()
  }

  const percent = job?.percent ?? 0

  return (
    <div className="jfs-fe-osd" style={{ maxWidth: '820px', margin: '0 auto', height: 'auto' }}>
      <div className="jfs-fe-row sep-b">
        <button className="jfs-fe-btn g" style={{ flex: '0 0 auto' }} onClick={onBack}>{t('upscale.back')}</button>
        <div className="jfs-fe-spacer" />
        <span className="jfs-fe-title">{t('upscale.title')}</span>
        <div className="jfs-fe-spacer" />
        <button className="jfs-fe-btn g" style={{ flex: '0 0 auto', padding: '2px 8px', fontSize: '16px' }} onClick={onClose}>✕</button>
      </div>

      {phase === 'options' && isAnimation && animationBlocked && (
        <div className="jfs-fe-row" style={{ flexDirection: 'column', gap: '10px', padding: '20px 12px' }}>
          <span className="jfs-fe-muted">{t('upscale.animationNoNvidia')}</span>
          <button className="jfs-fe-btn" onClick={onBack}>{t('upscale.back')}</button>
        </div>
      )}

      {phase === 'options' && !(isAnimation && animationBlocked) && (
        <>
          <div className="jfs-fe-row" style={{ flexWrap: 'wrap', gap: '10px' }}>
            <div className="jfs-fe-pgroup">
              <div className="jfs-fe-pgroup-body">
                <select className="jfs-fe-sel" value={modelStyle} onChange={e => setModelStyle(e.target.value as 'photo' | 'anime')}>
                  <option value="photo">{t('upscale.stylePhoto')}</option>
                  <option value="anime">{t('upscale.styleAnime')}</option>
                </select>
              </div>
              <div className="jfs-fe-pgroup-label">{t('upscale.style')}</div>
            </div>
            {/* anime never had a native x2 release (research.md §4) — always runs x4, so there's
                nothing to choose and showing a one-option dropdown would just be confusing. */}
            {modelStyle === 'photo' && (
              <div className="jfs-fe-pgroup">
                <div className="jfs-fe-pgroup-body">
                  <select className="jfs-fe-sel" value={modelScale} onChange={e => setModelScale(Number(e.target.value) as 2 | 4)}>
                    <option value={2}>{t('upscale.scaleX2')}</option>
                    <option value={4}>{t('upscale.scaleX4')}</option>
                  </select>
                </div>
                <div className="jfs-fe-pgroup-label">{t('upscale.model')}</div>
              </div>
            )}
            <div className="jfs-fe-pgroup">
              <div className="jfs-fe-pgroup-body">
                <select className="jfs-fe-sel" value={scale} onChange={e => setScale(Number(e.target.value) as 1 | 2 | 4)}>
                  {isAnimation && <option value={1}>{t('upscale.scaleX1')}</option>}
                  {effectiveModelScale >= 2 && <option value={2}>{t('upscale.scaleX2')}</option>}
                  {effectiveModelScale >= 4 && <option value={4}>{t('upscale.scaleX4')}</option>}
                </select>
              </div>
              <div className="jfs-fe-pgroup-label">{t('upscale.scale')}</div>
            </div>
          </div>
          <div className="jfs-fe-row">
            <label className="jfs-fe-muted" style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
              <input type="checkbox" checked={faceRestore} onChange={e => setFaceRestore(e.target.checked)} />
              {t('upscale.faceRestore')}
            </label>
          </div>
          {modelInstalled === false && (
            <div className="jfs-fe-row jfs-fe-muted" style={{ color: 'var(--jf-warn, #e0a030)' }}>
              {t('upscale.firstUseHint')}
            </div>
          )}
          <div className="jfs-fe-row sep-t">
            <div className="jfs-fe-spacer" />
            <button className="jfs-fe-btn p" onClick={handleStart}>{t('upscale.start')}</button>
          </div>
        </>
      )}

      {phase === 'downloading-model' && (
        <div className="jfs-fe-row" style={{ flexDirection: 'column', gap: '10px', padding: '20px 12px' }}>
          <span className="jfs-fe-muted">{t('advanced.downloadFirst')}</span>
          {modelDownloadError ? (
            <>
              <span style={{ color: '#f87171' }}>{modelDownloadError}</span>
              <button className="jfs-fe-btn" onClick={() => { modelEvtSourceRef.current?.close(); setPhase('options') }}>{t('upscale.back')}</button>
            </>
          ) : (
            <div className="jfs-fe-progress">
              <div className="jfs-fe-bar" style={{ width: `${modelDownloadPercent}%` }} />
              <span className="jfs-fe-progress-label">{t('advanced.downloading')} {Math.round(modelDownloadPercent)}%</span>
            </div>
          )}
        </div>
      )}

      {phase === 'processing' && (
        <div className="jfs-fe-row" style={{ flexDirection: 'column', gap: '10px', padding: '20px 12px' }}>
          <span className="jfs-fe-muted">{t('upscale.processing')}</span>
          <div className="jfs-fe-progress">
            <div className="jfs-fe-bar" style={{ width: `${percent}%` }} />
            <span className="jfs-fe-progress-label">{Math.round(percent)}%</span>
          </div>
          <button className="jfs-fe-btn g" onClick={handleCancel}>{t('upscale.cancel')}</button>
        </div>
      )}

      {phase === 'success' && job && (() => {
        const previewUrl = (showAfter ? job.resultUrl : job.originalUrl) ?? ''
        const isVideo = previewUrl.endsWith('.mp4')
        return (
        <>
          <div style={{ overflow: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '12px', background: 'rgba(0,0,0,0.3)' }}>
            {isVideo ? (
              <video
                key={previewUrl}
                src={buildResultUrl('', previewUrl)}
                style={{ maxWidth: '100%', maxHeight: '36vh', objectFit: 'contain', borderRadius: '6px', boxShadow: '0 4px 20px rgba(0,0,0,0.5)' }}
                controls
                autoPlay
                loop
                muted
              />
            ) : (
              <img
                src={buildResultUrl('', previewUrl)}
                style={{ maxWidth: '100%', maxHeight: '36vh', objectFit: 'contain', borderRadius: '6px', boxShadow: '0 4px 20px rgba(0,0,0,0.5)' }}
                alt={showAfter ? t('upscale.after') : t('upscale.before')}
              />
            )}
          </div>
          <div className="jfs-fe-row" style={{ justifyContent: 'center', gap: '8px' }}>
            <button className={`jfs-fe-btn${showAfter ? '' : ' p'}`} onClick={() => setShowAfter(false)}>{t('upscale.before')}</button>
            <button className={`jfs-fe-btn${showAfter ? ' p' : ''}`} onClick={() => setShowAfter(true)}>{t('upscale.after')}</button>
          </div>
          {job.originalWidth && job.originalHeight && job.resultWidth && job.resultHeight && (
            <div className="jfs-fe-row sep-t jfs-fe-muted" style={{ justifyContent: 'center' }}>
              {t('upscale.dimensions')
                .replace('{ow}', String(job.originalWidth)).replace('{oh}', String(job.originalHeight))
                .replace('{rw}', String(job.resultWidth)).replace('{rh}', String(job.resultHeight))}
            </div>
          )}
          {job.originalWidth && job.originalHeight && Math.max(job.originalWidth, job.originalHeight) >= ALREADY_HIGH_RES_PX && (
            <div className="jfs-fe-row jfs-fe-muted" style={{ justifyContent: 'center', color: 'var(--jf-warn, #e0a030)' }}>
              {t('upscale.alreadyHighRes')}
            </div>
          )}
          {_upscaledTaskIds.has(_activeTaskId) && (
            <div className="jfs-fe-row jfs-fe-muted" style={{ justifyContent: 'center', color: 'var(--jf-warn, #e0a030)' }}>
              {t('upscale.alreadyUpscaled')}
            </div>
          )}
          {job.faceRestoreSkippedNoFace && (
            <div className="jfs-fe-row jfs-fe-muted" style={{ justifyContent: 'center', color: 'var(--jf-warn, #e0a030)' }}>
              {t('upscale.noFaceDetected')}
            </div>
          )}
          <div className="jfs-fe-row sep-t" style={{ gap: '8px' }}>
            <button className="jfs-fe-btn" onClick={handleDownloadLog}>{t('upscale.downloadLog')}</button>
            <div className="jfs-fe-spacer" />
            <button className="jfs-fe-btn" onClick={handleDownloadOriginal}>{t('upscale.downloadOriginal')}</button>
            <button className="jfs-fe-btn p" onClick={handleDownloadImage}>{t('upscale.download')}</button>
          </div>
        </>
        )
      })()}

      {phase === 'error' && (
        <div className="jfs-fe-row" style={{ flexDirection: 'column', gap: '10px', padding: '20px 12px' }}>
          <span style={{ color: '#f87171' }}>{t('upscale.failed').replace('{msg}', errorMsg)}</span>
          <div className="jfs-fe-row" style={{ gap: '8px' }}>
            <button className="jfs-fe-btn" onClick={onBack}>{t('upscale.back')}</button>
            {job?.jobId && <button className="jfs-fe-btn" onClick={handleDownloadLog}>{t('upscale.downloadLog')}</button>}
          </div>
        </div>
      )}
    </div>
  )
}
