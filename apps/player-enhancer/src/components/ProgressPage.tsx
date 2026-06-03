import { useState, useEffect } from 'react'
import { useAtomValue } from 'jotai'
import { useMutation } from '@tanstack/react-query'
import { progressTaskIdAtom } from '../core/state'
import { openProgressStream, cancelExportMutation } from '../api/frameExportApi'
import type { TaskProgressEvent } from '../types/api'
import { sProgressPercent, sProgressVisible } from '../components/OsdButtons'
import { t } from '../lib/i18n'

export function ProgressPage({ onClose, onMinimize, onResult }: {
  onClose:     () => void
  onMinimize:  () => void
  onResult:    (resultUrl: string, fileSize: number) => void
}) {
  const taskId = useAtomValue(progressTaskIdAtom)
  const [percent, setPercent] = useState(0)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const cancelMut = useMutation(cancelExportMutation())

  function clearIndicator() {
    sProgressVisible.value = false
  }

  useEffect(() => {
    let retries = 0
    const eventSource = openProgressStream(taskId)

    eventSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as TaskProgressEvent
        const roundedPct = Math.round(data.percent)
        setPercent(data.percent)
        sProgressPercent.value = roundedPct
        if (data.status === 'complete' && data.resultUrl) {
          eventSource.close(); clearIndicator(); onResult(data.resultUrl, data.fileSize ?? 0)
        } else if (data.status === 'error') {
          eventSource.close(); clearIndicator(); setErrorMsg(data.error ?? t('progress.failed'))
        } else if (data.status === 'cancelled') {
          eventSource.close(); clearIndicator(); onClose()
        }
      } catch { /* ignore */ }
    }

    eventSource.onerror = () => {
      if (retries++ < 3) return
      eventSource.close(); clearIndicator(); setErrorMsg(t('progress.disconnected'))
    }

    return () => { eventSource.close() }
    // onClose / onResult are stable module-level functions
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId])

  function handleMinimize() {
    sProgressPercent.value = Math.round(percent)
    sProgressVisible.value = true
    onMinimize()
  }

  function handleCancel() {
    clearIndicator()
    cancelMut.mutate(taskId)
    onClose()
  }

  return (
    <div className="jfs-fe-osd" style={{ minWidth: '480px', maxWidth: '640px', margin: '0 auto', height: 'auto' }}>
      <div className="jfs-fe-row sep-b">
        <span className="jfs-fe-title">{t('progress.generating')}</span>
        <div className="jfs-fe-spacer" />
        <button className="jfs-fe-btn g" style={{ padding: '2px 8px', fontSize: '15px', lineHeight: '1' }} title={t('progress.minimize')} onClick={handleMinimize}>−</button>
        <button className="jfs-fe-btn" onClick={handleCancel}>{errorMsg ? t('progress.close') : t('progress.cancel')}</button>
      </div>
      <div style={{ padding: '16px 16px 20px' }}>
        <div className="jfs-fe-progress">
          <div
            className="jfs-fe-bar"
            style={{ width: `${errorMsg ? 100 : percent}%`, background: errorMsg ? 'rgba(239,68,68,0.8)' : undefined }}
          />
          <span className="jfs-fe-progress-label">
            {errorMsg ? errorMsg.substring(0, 40) : `${Math.round(percent)}%`}
          </span>
        </div>
      </div>
    </div>
  )
}
