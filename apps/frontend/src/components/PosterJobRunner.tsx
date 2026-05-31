import { useState, useEffect } from 'preact/hooks'
import { pollStatus, getImageUrl, JobStatusDto } from '../api/posterSheetApi'
import { updateJob } from '../state/posterJobStore'

interface Props {
  jobId: string
}

declare const window: Window & { ApiClient?: { accessToken(): string } }

export function PosterJobRunner({ jobId }: Props) {
  const [transport, setTransport] = useState<'sse' | 'poll'>('sse')
  const [done, setDone] = useState(false)

  useEffect(() => {
    if (done || transport !== 'sse') return

    const token = window.ApiClient?.accessToken()
    const qs = token ? `?api_key=${encodeURIComponent(token)}` : ''
    const es = new EventSource(`/JellyfinSuite/PosterSheet/${jobId}/stream${qs}`)

    es.onmessage = (event: MessageEvent) => {
      try {
        const s: JobStatusDto = JSON.parse(event.data as string)
        updateJob(jobId, {
          progress: s.progress,
          total: s.total,
          status:
            s.status === 'running' || s.status === 'queued'
              ? 'running'
              : (s.status as 'done' | 'error' | 'cancelled'),
        })
        if (s.status === 'done') {
          updateJob(jobId, { imageUrl: getImageUrl(jobId) })
          setDone(true)
          es.close()
        } else if (s.status === 'error') {
          updateJob(jobId, { error: s.error ?? undefined })
          setDone(true)
          es.close()
        } else if (s.status === 'cancelled') {
          setDone(true)
          es.close()
        }
      } catch { /* ignore parse errors */ }
    }

    es.onerror = () => {
      es.close()
      setTransport('poll')
    }

    return () => es.close()
  }, [jobId, done, transport])

  useEffect(() => {
    if (done || transport !== 'poll') return

    const interval = setInterval(async () => {
      try {
        const s = await pollStatus(jobId)
        updateJob(jobId, { progress: s.progress, total: s.total })
        if (s.status === 'done') {
          updateJob(jobId, { status: 'done', imageUrl: getImageUrl(jobId) })
          setDone(true)
        } else if (s.status === 'error') {
          updateJob(jobId, { status: 'error', error: s.error ?? undefined })
          setDone(true)
        } else if (s.status === 'cancelled') {
          setDone(true)
        }
      } catch { /* keep polling */ }
    }, 1000)

    return () => clearInterval(interval)
  }, [jobId, done, transport])

  return null
}
