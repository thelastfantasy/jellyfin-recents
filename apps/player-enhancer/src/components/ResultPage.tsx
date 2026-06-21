import { useMutation } from '@tanstack/react-query'
import { useAtomValue } from 'jotai'
import { useEffect, useState } from 'react'

import { buildResultUrl, deleteResultMutation, fetchDevices, getGenerationLog } from '../api/frameExportApi'
import { _activeTaskId, _frames, fileSizeAtom,resultUrlAtom, sExportType } from '../core/state'
import { t } from '../lib/i18n'
import { buildExportFileName, cleanItemTitle, triggerDownload } from '../lib/utils'

const ICON_CCW = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>`
const ICON_CW  = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`

export function ResultPage({ onBack, onClose, onUpscale }: {
  onBack:    () => void
  onClose:   () => void
  onUpscale: () => void
}) {
  const resultUrl = useAtomValue(resultUrlAtom)
  const fileSize  = useAtomValue(fileSizeAtom)
  const [rotation, setRotation] = useState(0)
  const [gpuFallback, setGpuFallback] = useState<string | null>(null)
  const isAnimation = sExportType.value === 'animate'
  // 动图提升画质需要 NVIDIA GPU（见 UpscaleService.StartJob 同名校验）；没有的话直接不显示按钮，
  // 比点进去再被拒绝体验更好。设备查询失败时 fail-open，仍交给后端兜底拒绝。
  const [hasNvidiaGpu, setHasNvidiaGpu] = useState(true)

  useEffect(() => {
    if (!isAnimation) return
    let cancelled = false
    fetchDevices()
      .then(devices => { if (!cancelled) setHasNvidiaGpu(devices.some(d => d.vendor === 'NVIDIA')) })
      .catch(() => { /* fetch failed — fail-open, backend still enforces this */ })
    return () => { cancelled = true }
  }, [isAnimation])

  const fullUrl = buildResultUrl('', resultUrl)
  const sizeStr = fileSize > 1024 * 1024
    ? `${(fileSize / 1024 / 1024).toFixed(1)} MB`
    : `${(fileSize / 1024).toFixed(0)} KB`
  const deleteMut = useMutation(deleteResultMutation())

  function handleDelete() {
    deleteMut.mutate(_activeTaskId)
    onBack()
  }

  function handleDownload() {
    const extension = resultUrl.split('.').pop() ?? 'bin'
    const selectedFrames = _frames.filter(f => f.selected)
    const name = buildExportFileName(sExportType.value, selectedFrames[0]?.posMs ?? 0, selectedFrames[selectedFrames.length - 1]?.posMs ?? 0)
    triggerDownload(fullUrl, `${name}.${extension}`)
  }

  async function handleDownloadLog() {
    try {
      const log = await getGenerationLog(_activeTaskId)
      if (log.fallbacks.length > 0) setGpuFallback(log.fallbacks[0].reason)
      const blob = new Blob([JSON.stringify(log, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const title = cleanItemTitle() || 'export'
      triggerDownload(url, `${title}-${_activeTaskId.slice(0, 6)}-log.json`)
      URL.revokeObjectURL(url)
    } catch {
      /* generation log unavailable — silently ignore, the result image download still works */
    }
  }

  return (
    <div className="jfs-fe-osd" style={{ maxWidth: '640px', margin: '0 auto', height: 'auto' }}>
      <div className="jfs-fe-row sep-b">
        <button className="jfs-fe-btn g" style={{ flex: '0 0 auto' }} onClick={onBack}>{t('result.back')}</button>
        <div style={{ flex: '1' }} />
        <span className="jfs-fe-title">{t('result.preview').replace('{size}', sizeStr)}</span>
        <div style={{ flex: '1' }} />
        <button className="jfs-fe-btn g" style={{ flex: '0 0 auto', padding: '2px 8px', fontSize: '16px' }} onClick={onClose}>✕</button>
      </div>
      <div style={{ overflow: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '12px', background: 'rgba(0,0,0,0.3)' }}>
        <img
          src={fullUrl}
          style={{
            maxWidth: '100%', maxHeight: '36vh', objectFit: 'contain', borderRadius: '6px',
            boxShadow: '0 4px 20px rgba(0,0,0,0.5)', transition: 'transform 0.15s',
            transform: `rotate(${rotation}deg)`,
          }}
          alt="result"
        />
      </div>
      <div className="jfs-fe-row sep-t" style={{ flexWrap: 'wrap', gap: '6px' }}>
        <button className="jfs-fe-btn g" onClick={() => setRotation(r => r - 5)} dangerouslySetInnerHTML={{ __html: ICON_CCW + ' 5°' }} />
        <button className="jfs-fe-btn g" onClick={() => setRotation(r => r - 1)} dangerouslySetInnerHTML={{ __html: ICON_CCW + ' 1°' }} />
        <span className="jfs-fe-muted" style={{ minWidth: '28px', textAlign: 'center' }}>{rotation}°</span>
        <button className="jfs-fe-btn g" onClick={() => setRotation(r => r + 1)} dangerouslySetInnerHTML={{ __html: '1° ' + ICON_CW }} />
        <button className="jfs-fe-btn g" onClick={() => setRotation(r => r + 5)} dangerouslySetInnerHTML={{ __html: '5° ' + ICON_CW }} />
        <div className="jfs-fe-spacer" />
        <button className="jfs-fe-btn p" onClick={handleDownload}>{t('result.download')}</button>
        {!(isAnimation && !hasNvidiaGpu) && (
          <button className="jfs-fe-btn" onClick={onUpscale}>{t('result.upscale')}</button>
        )}
        {sExportType.value !== 'animate' && (
          <button className="jfs-fe-btn" onClick={handleDownloadLog}>{t('result.downloadLog')}</button>
        )}
        <button className="jfs-fe-btn"   onClick={handleDelete}>{t('result.delete')}</button>
      </div>
      {gpuFallback && (
        <div className="jfs-fe-row sep-t jfs-fe-muted" style={{ color: 'var(--jf-warn, #e0a030)' }}>
          {t('result.gpuFallback')}: {gpuFallback}
        </div>
      )}
    </div>
  )
}
