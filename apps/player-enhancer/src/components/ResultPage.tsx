import { useState } from 'react'
import { useAtomValue } from 'jotai'
import { useMutation } from '@tanstack/react-query'
import { sExportType, _frames, _activeTaskId, resultUrlAtom, fileSizeAtom } from '../core/state'
import { buildResultUrl, deleteResultMutation } from '../api/frameExportApi'
import { formatTime, cleanItemTitle, triggerDownload } from '../lib/utils'
import { t } from '../lib/i18n'

const ICON_CCW = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>`
const ICON_CW  = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`

export function ResultPage({ onBack, onClose }: {
  onBack:  () => void
  onClose: () => void
}) {
  const resultUrl = useAtomValue(resultUrlAtom)
  const fileSize  = useAtomValue(fileSizeAtom)
  const [rotation, setRotation] = useState(0)

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
    const prefix = sExportType.value === 'animate' ? 'jellyfin-animate' : 'jellyfin-stitch'
    const title  = cleanItemTitle() || 'export'
    const selectedFrames = _frames.filter(f => f.selected)
    const startTimestamp = formatTime(selectedFrames[0]?.posMs ?? 0).replace(/[:.]/g, '-')
    const endTimestamp   = formatTime(selectedFrames[selectedFrames.length - 1]?.posMs ?? 0).replace(/[:.]/g, '-')
    triggerDownload(fullUrl, `${prefix}-${title}-${startTimestamp}-to-${endTimestamp}.${extension}`)
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
        <button className="jfs-fe-btn"   onClick={handleDelete}>{t('result.delete')}</button>
      </div>
    </div>
  )
}
