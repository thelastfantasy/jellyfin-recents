import { useState, useEffect, useCallback } from 'preact/hooks'
import { MdGridView } from 'react-icons/md'
import { Popover } from './Popover'
import { getJobs, addJob, updateJob, removeJob, JobEntry } from '../state/posterJobStore'
import { cancelJob, getImageUrl, listJobs } from '../api/posterSheetApi'
import { useLocale } from '../i18n/context'
import { PosterJobRunner } from './PosterJobRunner'
import { Lightbox } from './Lightbox'
import { downloadBlob } from '../utils/download'

export function PosterQueueWidget() {
  const { t } = useLocale()
  const [jobs, setJobs] = useState<JobEntry[]>(getJobs)
  const [open, setOpen] = useState(false)
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  const [lightboxJobId, setLightboxJobId] = useState<string | null>(null)

  useEffect(() => {
    // Restore jobs from backend on mount (iframe re-enter after navigation)
    listJobs().then(serverJobs => {
      const localIds = new Set(getJobs().map(j => j.jobId))
      for (const sj of serverJobs) {
        if (localIds.has(sj.jobId)) continue
        addJob(sj.jobId, sj.itemId, sj.itemTitle, sj.createdAt || undefined)
        updateJob(sj.jobId, {
          status: sj.status === 'queued' ? 'running' : sj.status,
          progress: sj.progress,
          total: sj.total,
          error: sj.error ?? undefined,
        })
      }
    })
  }, [])

  useEffect(() => {
    function handler() { setJobs(getJobs()) }
    window.addEventListener('jfs-poster-jobs-changed', handler)
    return () => window.removeEventListener('jfs-poster-jobs-changed', handler)
  }, [])

  const handleDelete = useCallback(async (job: JobEntry) => {
    await cancelJob(job.jobId).catch(() => {})
    removeJob(job.jobId)
  }, [])

  // Badge: running + error jobs
  const badgeCount = jobs.filter(j => j.status === 'running' || j.status === 'error').length

  if (jobs.length === 0) return null

  const runningJobs = jobs.filter(j => j.status === 'running')

  return (
    <>
      {runningJobs.map(j => <PosterJobRunner key={j.jobId} jobId={j.jobId} />)}
      <button
        class="jfs-queue-widget"
        onClick={() => setOpen(v => !v)}
        title={t.posterQueue}
        aria-label={t.posterQueue}
      >
        <MdGridView size={22} />
        {badgeCount > 0 && (
          <span class="jfs-queue-widget__badge">{badgeCount}</span>
        )}
      </button>

      <Popover open={open} onClose={() => setOpen(false)}>
        <div class="jfs-queue-popover">
          <div class="jfs-queue-popover__header">
            <span>{t.posterQueue}</span>
            <button class="jfs-queue-popover__header-close" onClick={() => setOpen(false)}>✕</button>
          </div>
          <div class="jfs-queue-popover__list">
            {[...jobs].sort((a, b) => b.addedAt - a.addedAt).map(job => (
              <div key={job.jobId} class={`jfs-queue-popover__item jfs-queue-popover__item--${job.status}`}>
                <div class="jfs-queue-popover__item-header">
                  <span class="jfs-queue-popover__title" title={job.itemTitle}>{job.itemTitle}</span>
                  <button
                    class="jfs-queue-popover__delete"
                    onClick={() => handleDelete(job)}
                    title={t.posterQueueRemove}
                  >✕</button>
                </div>

                {job.status === 'running' && job.total > 0 && (
                  <div class="jfs-queue-popover__bar">
                    <div
                      class="jfs-queue-popover__bar-fill"
                      style={{ width: `${Math.round((job.progress / job.total) * 100)}%` }}
                    />
                    <span class="jfs-queue-popover__bar-text">
                      {Math.round((job.progress / job.total) * 100)}%
                    </span>
                  </div>
                )}

                {job.status === 'running' && job.total === 0 && (
                  <div class="jfs-queue-popover__status-text">Starting…</div>
                )}

                {job.status === 'error' && (
                  <div class="jfs-queue-popover__status-text jfs-queue-popover__status-text--error">
                    {job.error ?? 'Error'}
                  </div>
                )}

                {job.status === 'done' && (
                  <img
                    src={getImageUrl(job.jobId)}
                    alt={job.itemTitle}
                    class="jfs-queue-popover__thumb"
                    onClick={() => { setLightboxSrc(getImageUrl(job.jobId)); setLightboxJobId(job.jobId) }}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      </Popover>

      {lightboxSrc && (
        <Lightbox
          src={lightboxSrc}
          alt="Poster sheet"
          onClose={() => { setLightboxSrc(null); setLightboxJobId(null) }}
          onDownload={() => lightboxSrc && downloadBlob(lightboxSrc, `poster-sheet-${lightboxJobId}.jpg`)}
          onDelete={lightboxJobId ? () => {
            const job = jobs.find(j => j.jobId === lightboxJobId)
            if (job) handleDelete(job)
            setLightboxSrc(null)
            setLightboxJobId(null)
          } : undefined}
        />
      )}
    </>
  )
}
