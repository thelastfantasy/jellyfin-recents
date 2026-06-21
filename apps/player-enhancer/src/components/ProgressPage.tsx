import { useMutation } from '@tanstack/react-query'
import { useAtomValue } from 'jotai'
import { useEffect,useState } from 'react'

import { cancelExportMutation, getGenerationLog,openProgressStream } from '../api/frameExportApi'
import { sProgressPercent, sProgressVisible } from '../components/OsdButtons'
import { exportTypeAtom, progressTaskIdAtom } from '../core/state'
import { t } from '../lib/i18n'
import { cleanItemTitle, triggerDownload } from '../lib/utils'
import type { TaskProgressEvent } from '../types/api'

export function ProgressPage({ onClose, onMinimize, onResult }: {
  onClose:     () => void
  onMinimize:  () => void
  onResult:    (resultUrl: string, fileSize: number) => void
}) {
  const taskId = useAtomValue(progressTaskIdAtom)
  const exportType = useAtomValue(exportTypeAtom)
  const [percent, setPercent] = useState(0)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const cancelMut = useMutation(cancelExportMutation())

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

  function clearIndicator() { sProgressVisible.value = false }

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

  // 全景图（stitch）失败时也可能用到了 DL 模型/GPU EP，诊断价值不低于成功时——动图没有这个日志
  // （后端 generation-log 只在 stitch 路径写），所以只在 stitch 失败时显示。
  async function handleDownloadLog() {
    try {
      const log = await getGenerationLog(taskId)
      const blob = new Blob([JSON.stringify(log, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const title = cleanItemTitle() || 'export'
      triggerDownload(url, `${title}-${taskId.slice(0, 6)}-log.json`)
      URL.revokeObjectURL(url)
    } catch { /* generation log unavailable for this failure — silently ignore */ }
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
        {errorMsg && exportType === 'stitch' && (
          <div className="jfs-fe-row" style={{ justifyContent: 'center', marginTop: '10px' }}>
            <button className="jfs-fe-btn g" onClick={handleDownloadLog}>{t('result.downloadLog')}</button>
          </div>
        )}
      </div>
    </div>
  )
}
