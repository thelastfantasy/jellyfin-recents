import { useState, useEffect, useRef } from 'react'
import { useAtomValue } from 'jotai'
import { sProgressTaskId, progressTaskIdAtom } from '../core/state'
import { setGesturesSuspended } from '../hooks/useGestures'
import { openProgressStream, cancelExport } from '../api/frameExportApi'
import type { TaskProgressEvent } from '../types/api'
import { sProgressPercent, sProgressVisible } from '../components/OsdButtons'
import { t } from '../lib/i18n'

export function ProgressPage({ onClose, onResult }: {
  onClose:  () => void
  onResult: (resultUrl: string, fileSize: number) => void
}) {
  const taskId = useAtomValue(progressTaskIdAtom)
  const [pct, setPct]         = useState(0)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const modalRootRef          = useRef<HTMLElement | null>(null)

  useEffect(() => {
    modalRootRef.current = document.querySelector<HTMLElement>('[data-jfs-modal-root]')
  }, [])

  function hideIndicator() {
    sProgressVisible.value = false
    if (modalRootRef.current) modalRootRef.current.style.display = ''
  }

  useEffect(() => {
    let retries = 0
    const evSrc = openProgressStream(taskId)

    evSrc.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as TaskProgressEvent
        const roundedPct = Math.round(data.percent)
        setPct(data.percent)
        sProgressPercent.value = roundedPct
        if (data.status === 'complete' && data.resultUrl) {
          evSrc.close(); hideIndicator(); onResult(data.resultUrl, data.fileSize ?? 0)
        } else if (data.status === 'error') {
          evSrc.close(); hideIndicator(); setErrorMsg(data.error ?? t('progress.failed'))
        } else if (data.status === 'cancelled') {
          evSrc.close(); hideIndicator(); onClose()
        }
      } catch { /* ignore */ }
    }

    evSrc.onerror = () => {
      if (retries++ < 3) return
      evSrc.close(); hideIndicator(); setErrorMsg(t('progress.disconnected'))
    }

    return () => { evSrc.close() }
    // onClose / onResult are stable module-level functions
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId])

  function handleMinimize() {
    const root = modalRootRef.current
    if (!root) return
    root.style.display = 'none'
    setGesturesSuspended(false)

    sProgressPercent.value = Math.round(pct)
    sProgressVisible.value = true
  }

  function handleCancel() {
    cancelExport(taskId)
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
            style={{ width: `${errorMsg ? 100 : pct}%`, background: errorMsg ? 'rgba(239,68,68,0.8)' : undefined }}
          />
          <span className="jfs-fe-progress-label">
            {errorMsg ? errorMsg.substring(0, 40) : `${Math.round(pct)}%`}
          </span>
        </div>
      </div>
    </div>
  )
}
