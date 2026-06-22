import { Lightbox } from '@jfs/common-ui'
import { useCallback,useEffect, useRef, useState } from 'react'
import { MdGif } from 'react-icons/md'

import { deleteTask, listTasks, withAuth } from '../api/frameExportQueueApi'
import { useLocale } from '../i18n/context'
import type { ExportTaskEntry} from '../state/frameExportJobStore';
import { addTask,getTasks, removeTask, updateTask } from '../state/frameExportJobStore'
import { downloadBlob } from '../utils/download'
import { FrameExportJobRunner } from './FrameExportJobRunner'
import { Popover } from './Popover'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function extFromUrl(url: string): string {
  const seg = url.split('.').pop() ?? ''
  return seg.toUpperCase()
}

const MIME_EXT: Record<string, string> = {
  'image/gif': 'gif', 'image/webp': 'webp', 'image/png': 'png', 'video/mp4': 'mp4',
}

// The upscaled route (`/Stitch/Upscale/{jobId}/Result`) carries no file extension of its own —
// unlike the original FrameExport route, whose path segment is at least real (just not used by
// the server, see safeFileName below) — so derive both the displayed format badge and the
// video/image branch from the server-reported MIME type instead.
function extFromMime(mime: string): string {
  return (MIME_EXT[mime] ?? 'bin').toUpperCase()
}

// task.resultUrl's path segment is always the literal placeholder "output.{ext}" (the server
// route doesn't read it — the real filename comes back via the Content-Disposition header on
// the actual download), so build a per-item name from the title instead of trusting the URL.
// `suffix` mirrors UpscalePage.tsx's own `_upscale` convention so a saved-to-disk upscaled
// download reads as "the same export, just sharper" instead of colliding with (or being
// indistinguishable from) the original's filename.
function safeFileName(title: string, ext: string, suffix?: string): string {
  const clean = title.replace(/[\\/:*?"<>|]/g, '_').trim()
  return `${clean || 'export'}${suffix ? `_${suffix}` : ''}.${ext.toLowerCase()}`
}

// Hover-to-preview only makes sense where "hover" exists; touch devices play instead based on
// viewport visibility (see QueueVideoThumb) since there's no hover state to trigger off of.
const isTouchDevice = typeof window !== 'undefined' && window.matchMedia('(hover: none)').matches

// PC: hover plays, leaving resets to frame 0 so the resting "cover" is always the first frame
// rather than whatever frame playback happened to stop on. Touch: no hover concept, so instead
// play only while the thumb is fully (100%) scrolled into view, pause otherwise — avoids every
// queued clip in a long list auto-playing/decoding at once off-screen.
function QueueVideoThumb({ url }: { url: string }) {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    if (!isTouchDevice) return
    const video = videoRef.current
    if (!video) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.intersectionRatio >= 0.999) video.play().catch(() => {})
        else video.pause()
      },
      { threshold: 1.0 },
    )
    observer.observe(video)
    return () => observer.disconnect()
  }, [])

  return (
    <video
      ref={videoRef}
      src={url}
      className="jfs-queue-popover__thumb"
      muted
      playsInline
      loop
      preload="metadata"
      onMouseEnter={e => { if (!isTouchDevice) e.currentTarget.play().catch(() => {}) }}
      onMouseLeave={e => {
        if (isTouchDevice) return
        const v = e.currentTarget
        v.pause()
        v.currentTime = 0
      }}
    />
  )
}

// Renders one downloadable preview (original or upscaled, whichever the toggle above it has
// selected) — extracted so switching between the two doesn't need two near-duplicate JSX blocks.
function ResultVariant({ downloadLabel, url, itemTitle, fileSize, mimeType, filenameSuffix, onImageClick }: {
  downloadLabel: string
  url: string
  itemTitle: string
  fileSize?: number | null
  mimeType?: string | null
  filenameSuffix?: string
  onImageClick: (url: string) => void
}) {
  const authedUrl = withAuth(url)
  const ext = mimeType ? extFromMime(mimeType) : extFromUrl(url)
  const isVideo = mimeType ? mimeType.startsWith('video/') : url.endsWith('.mp4')
  const filename = safeFileName(itemTitle, ext, filenameSuffix)
  return (
    <div className="jfs-queue-popover__variant">
      <div className="jfs-queue-popover__variant-label">
        <span className="jfs-export-type-badge jfs-export-type-badge--fmt">{ext}</span>
        {fileSize != null && (
          <span className="jfs-export-type-badge jfs-export-type-badge--size">{formatSize(fileSize)}</span>
        )}
      </div>
      {isVideo ? (
        <QueueVideoThumb url={authedUrl} />
      ) : (
        <img
          src={authedUrl}
          alt={itemTitle}
          className="jfs-queue-popover__thumb"
          onClick={() => onImageClick(authedUrl)}
        />
      )}
      <button className="jfs-export-download-btn" onClick={() => { downloadBlob(authedUrl, filename).catch(() => {}) }}>
        {downloadLabel}
      </button>
    </div>
  )
}

export function FrameExportQueueWidget() {
  const { t } = useLocale()
  const [tasks, setTasks] = useState<ExportTaskEntry[]>(getTasks)
  const [open, setOpen] = useState(false)
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  const [lightboxTaskId, setLightboxTaskId] = useState<string | null>(null)
  // Which version a given (upscaled) task is currently showing — defaults to the upscaled result
  // since that's the one the user almost certainly came back to check on, with the toggle there
  // to flip back to the original for comparison.
  const [showOriginal, setShowOriginal] = useState<Record<string, boolean>>({})

  // Picks up tasks the server knows about but this page hasn't seen yet, and — for tasks already
  // complete — refreshes server-only fields (upscaled/upscaledResultUrl) that never arrive via the
  // local SSE progress stream. Deliberately leaves percent/status alone for already-known
  // running tasks so it doesn't fight with FrameExportJobRunner's live SSE updates.
  function syncFromServer() {
    listTasks().then(serverTasks => {
      const localIds = new Set(getTasks().map(e => e.taskId))
      for (const st of serverTasks) {
        const isNew = !localIds.has(st.taskId)
        if (isNew) addTask(st.taskId, st.itemId, st.itemTitle, st.type, st.createdAt || undefined)
        if (!isNew && st.status !== 'complete') continue

        updateTask(st.taskId, {
          status: (st.status === 'pending' || st.status === 'running') ? 'running'
            : st.status as ExportTaskEntry['status'],
          percent:   st.status === 'complete' ? 100 : 0,
          resultUrl: st.resultUrl ?? undefined,
          fileSize:  st.fileSize  ?? undefined,
          error:     st.error     ?? undefined,
          upscaled:  st.upscaled,
          upscaledResultUrl: st.upscaledResultUrl ?? undefined,
          upscaledFileSize:  st.upscaledFileSize  ?? undefined,
          upscaledMimeType:  st.upscaledMimeType  ?? undefined,
        })
      }
    })
  }

  useEffect(syncFromServer, [])

  // The upscale flow runs in a separate app/bundle (player-enhancer) with no shared JS state, so
  // there's no local event to react to when it finishes — re-pull from the server every time the
  // popover is opened instead, which is the only way this page learns about it at all.
  useEffect(() => { if (open) syncFromServer() }, [open])

  useEffect(() => {
    function handler() { setTasks(getTasks()) }
    window.addEventListener('jfs-export-tasks-changed', handler)
    return () => window.removeEventListener('jfs-export-tasks-changed', handler)
  }, [])

  const handleDelete = useCallback(async (task: ExportTaskEntry) => {
    await deleteTask(task.taskId).catch(() => {})
    removeTask(task.taskId)
  }, [])

  const badgeCount = tasks.filter(t => t.status === 'running' || t.status === 'error').length

  if (tasks.length === 0) return null

  const runningTasks = tasks.filter(t => t.status === 'running')

  return (
    <>
      {runningTasks.map(t => <FrameExportJobRunner key={t.taskId} taskId={t.taskId} />)}
      <button
        className="jfs-export-widget"
        onClick={() => setOpen(v => !v)}
        title={t.clipWorkshopQueue}
        aria-label={t.clipWorkshopQueue}
      >
        <MdGif size={26} />
        {badgeCount > 0 && (
          <span className="jfs-export-widget__badge">{badgeCount}</span>
        )}
      </button>

      <Popover open={open} onClose={() => setOpen(false)}>
        <div className="jfs-export-popover">
          <div className="jfs-queue-popover__header">
            <span>{t.clipWorkshopQueue}</span>
            <button className="jfs-queue-popover__header-close" onClick={() => setOpen(false)}>✕</button>
          </div>
          <div className="jfs-queue-popover__list">
            {[...tasks].sort((a, b) => b.addedAt - a.addedAt).map(task => (
              <div
                key={task.taskId}
                className={`jfs-queue-popover__item jfs-queue-popover__item--${
                  task.status === 'complete' ? 'done' : task.status
                }`}
              >
                <div className="jfs-queue-popover__item-header">
                  <span className="jfs-queue-popover__title" title={task.itemTitle}>
                    {task.itemTitle}
                  </span>
                  <button
                    className="jfs-queue-popover__delete"
                    onClick={() => handleDelete(task)}
                    title={t.exportQueueRemove}
                  >✕</button>
                </div>
                <div className="jfs-queue-popover__badges">
                  <span className="jfs-export-type-badge">{task.type.toUpperCase()}</span>
                  {/* Once there's an upscaled version too, each ResultVariant below carries its
                      own fmt/size label — showing them here as well would just duplicate it. */}
                  {task.resultUrl && !task.upscaledResultUrl && (
                    <>
                      <span className="jfs-export-type-badge jfs-export-type-badge--fmt">
                        {extFromUrl(task.resultUrl)}
                      </span>
                      {task.fileSize != null && (
                        <span className="jfs-export-type-badge jfs-export-type-badge--size">
                          {formatSize(task.fileSize)}
                        </span>
                      )}
                    </>
                  )}
                  {task.upscaled && (
                    <span className="jfs-export-type-badge jfs-export-type-badge--upscaled">
                      {t.exportQueueUpscaled}
                    </span>
                  )}
                </div>

                {task.status === 'running' && (
                  <div className="jfs-queue-popover__bar">
                    <div
                      className="jfs-queue-popover__bar-fill jfs-export-bar-fill"
                      style={{ width: `${Math.round(task.percent)}%` }}
                    />
                    <span className="jfs-queue-popover__bar-text">
                      {Math.round(task.percent)}%
                    </span>
                  </div>
                )}

                {task.status === 'error' && (
                  <div className="jfs-queue-popover__status-text jfs-queue-popover__status-text--error">
                    {task.error ?? 'Error'}
                  </div>
                )}

                {task.status === 'complete' && task.resultUrl && (() => {
                  const resultUrl = task.resultUrl
                  const upscaledResultUrl = task.upscaledResultUrl
                  const onImageClick = (u: string) => { setLightboxSrc(u); setLightboxTaskId(task.taskId) }
                  const viewingOriginal = !upscaledResultUrl || (showOriginal[task.taskId] ?? false)
                  const activeUrl = !viewingOriginal && upscaledResultUrl ? upscaledResultUrl : resultUrl
                  return (
                    <>
                      {upscaledResultUrl && (
                        <div className="jfs-queue-popover__variant-toggle">
                          <button
                            className={`jfs-export-type-badge jfs-export-type-badge--toggle${viewingOriginal ? ' active' : ''}`}
                            onClick={() => setShowOriginal(s => ({ ...s, [task.taskId]: true }))}
                          >{t.exportQueueOriginal}</button>
                          <button
                            className={`jfs-export-type-badge jfs-export-type-badge--toggle${!viewingOriginal ? ' active' : ''}`}
                            onClick={() => setShowOriginal(s => ({ ...s, [task.taskId]: false }))}
                          >{t.exportQueueUpscaledLabel}</button>
                        </div>
                      )}
                      <ResultVariant
                        downloadLabel={`${t.exportQueueDownload} · ${viewingOriginal ? t.exportQueueOriginal : t.exportQueueUpscaledLabel}`}
                        url={activeUrl}
                        itemTitle={task.itemTitle}
                        fileSize={viewingOriginal ? task.fileSize : task.upscaledFileSize}
                        mimeType={viewingOriginal ? undefined : task.upscaledMimeType}
                        filenameSuffix={viewingOriginal ? undefined : 'upscale'}
                        onImageClick={onImageClick}
                      />
                    </>
                  )
                })()}
              </div>
            ))}
          </div>
        </div>
      </Popover>

      {lightboxSrc && (
        <Lightbox
          src={lightboxSrc}
          alt="Export result"
          onClose={() => { setLightboxSrc(null); setLightboxTaskId(null) }}
          onDownload={() => lightboxSrc && downloadBlob(lightboxSrc, `export-${lightboxTaskId}.${lightboxSrc.split('.').pop()}`)}
          onDelete={lightboxTaskId ? () => {
            const task = tasks.find(t => t.taskId === lightboxTaskId)
            if (task) handleDelete(task)
            setLightboxSrc(null)
            setLightboxTaskId(null)
          } : undefined}
        />
      )}
    </>
  )
}
