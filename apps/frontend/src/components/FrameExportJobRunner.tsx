import { useEffect, useState } from 'react'
import { updateTask } from '../state/frameExportJobStore'

interface Props {
  taskId: string
}

declare const window: Window & { ApiClient?: { accessToken(): string } }

export function FrameExportJobRunner({ taskId }: Props) {
  const [done, setDone] = useState(false)

  useEffect(() => {
    if (done) return

    const token = window.ApiClient?.accessToken()
    const qs = token ? `&api_key=${encodeURIComponent(token)}` : ''
    const es = new EventSource(`/JellyfinSuite/FrameExport/Progress?taskId=${encodeURIComponent(taskId)}${qs}`)

    es.onmessage = (event: MessageEvent) => {
      try {
        const d = JSON.parse(event.data as string)
        if (d.status === 'complete') {
          updateTask(taskId, {
            status: 'complete',
            percent: 100,
            resultUrl: d.resultUrl ?? undefined,
            fileSize: d.fileSize ?? undefined,
          })
          setDone(true)
          es.close()
        } else if (d.status === 'error') {
          updateTask(taskId, { status: 'error', error: d.error ?? 'Error' })
          setDone(true)
          es.close()
        } else if (d.status === 'cancelled') {
          updateTask(taskId, { status: 'cancelled' })
          setDone(true)
          es.close()
        } else {
          updateTask(taskId, { percent: d.percent ?? 0 })
        }
      } catch { /* ignore parse errors */ }
    }

    es.onerror = () => {
      es.close()
      setDone(true)
    }

    return () => es.close()
  }, [taskId, done])

  return null
}
