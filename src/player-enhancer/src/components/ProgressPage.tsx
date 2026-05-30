import { useState, useEffect, useRef } from 'preact/hooks'
import { sProgressTaskId } from '../state'
import { setGesturesSuspended } from '../gestures'
import { openProgressStream, cancelExport } from '../api/frameExportApi'
import type { TaskProgressEvent } from '../api-types'

export function ProgressPage({ onClose, onResult }: {
  onClose:  () => void
  onResult: (resultUrl: string, fileSize: number) => void
}) {
  const taskId = sProgressTaskId.value
  const [pct, setPct]         = useState(0)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const indicatorAcRef        = useRef<AbortController | null>(null)
  const modalRootRef          = useRef<HTMLElement | null>(null)

  useEffect(() => {
    modalRootRef.current = document.querySelector<HTMLElement>('[data-jfs-modal-root]')
  }, [])

  function hideIndicator() {
    indicatorAcRef.current?.abort()
    indicatorAcRef.current = null
    const ind = document.getElementById('jfs-enhancer-prog-indicator')
    if (ind) ind.style.display = 'none'
    if (modalRootRef.current) modalRootRef.current.style.display = ''
  }

  useEffect(() => {
    let retries = 0
    const evSrc = openProgressStream(taskId)

    evSrc.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as TaskProgressEvent
        setPct(data.percent)
        const ind = document.getElementById('jfs-enhancer-prog-indicator')
        if (ind && ind.style.display !== 'none') ind.textContent = `${Math.round(data.percent)}%`
        if (data.status === 'complete' && data.resultUrl) {
          evSrc.close(); hideIndicator(); onResult(data.resultUrl, data.fileSize ?? 0)
        } else if (data.status === 'error') {
          evSrc.close(); hideIndicator(); setErrorMsg(data.error ?? '生成失败')
        } else if (data.status === 'cancelled') {
          evSrc.close(); hideIndicator(); onClose()
        }
      } catch { /* ignore */ }
    }

    evSrc.onerror = () => {
      if (retries++ < 3) return
      evSrc.close(); hideIndicator(); setErrorMsg('连接中断，请重试')
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
    const ind = document.getElementById('jfs-enhancer-prog-indicator')
    if (ind) {
      ind.textContent = `${Math.round(pct)}%`
      ind.style.display = ''
      const ac = new AbortController()
      indicatorAcRef.current = ac
      ind.addEventListener('click', () => {
        ac.abort()
        indicatorAcRef.current = null
        ind.style.display = 'none'
        if (root) root.style.display = ''
        setGesturesSuspended(true)
      }, { signal: ac.signal })
    }
  }

  function handleCancel() {
    cancelExport(taskId)
    onClose()
  }

  return (
    <div class="jfs-fe-osd" style={{ minWidth: '480px', maxWidth: '640px', margin: '0 auto', height: 'auto' }}>
      <div class="jfs-fe-row sep-b">
        <span class="jfs-fe-title">生成中</span>
        <div class="jfs-fe-spacer" />
        <button class="jfs-fe-btn g" style={{ padding: '2px 8px', fontSize: '15px', lineHeight: '1' }} title="最小化到控制栏" onClick={handleMinimize}>−</button>
        <button class="jfs-fe-btn" onClick={handleCancel}>{errorMsg ? '关闭' : '取消'}</button>
      </div>
      <div style={{ padding: '16px 16px 20px' }}>
        <div class="jfs-fe-progress">
          <div
            class="jfs-fe-bar"
            style={{ width: `${errorMsg ? 100 : pct}%`, background: errorMsg ? 'rgba(239,68,68,0.8)' : undefined }}
          />
          <span class="jfs-fe-progress-label">
            {errorMsg ? errorMsg.substring(0, 40) : `${Math.round(pct)}%`}
          </span>
        </div>
      </div>
    </div>
  )
}
