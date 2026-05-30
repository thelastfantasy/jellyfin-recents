import { useState } from 'preact/hooks'
import { sResultUrl, sFileSize, sExportType, _frames, _activeTaskId } from '../state'
import { buildResultUrl, deleteResult } from '../api/frameExportApi'
import { formatTime } from '../utils'

const ICON_CCW = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>`
const ICON_CW  = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`

export function ResultPage({ onBack, onClose }: {
  onBack:  () => void
  onClose: () => void
}) {
  const resultUrl = sResultUrl.value
  const fileSize  = sFileSize.value
  const [rotation, setRotation] = useState(0)

  const fullUrl = buildResultUrl('', resultUrl)
  const sizeStr = fileSize > 1024 * 1024
    ? `${(fileSize / 1024 / 1024).toFixed(1)} MB`
    : `${(fileSize / 1024).toFixed(0)} KB`

  function handleDelete() {
    deleteResult(_activeTaskId)
    onBack()
  }

  function handleDownload() {
    const ext    = resultUrl.split('.').pop() ?? 'bin'
    const prefix = sExportType.value === 'animate' ? 'jellyfin-animate' : 'jellyfin-stitch'
    const title  = document.title.replace(/\s*[-|]\s*Jellyfin\s*$/i, '').trim() || 'export'
    const sel    = _frames.filter(f => f.selected)
    const ts1    = formatTime(sel[0]?.posMs ?? 0).replace(/[:.]/g, '-')
    const ts2    = formatTime(sel[sel.length - 1]?.posMs ?? 0).replace(/[:.]/g, '-')
    const a = document.createElement('a')
    a.href = fullUrl
    a.download = `${prefix}-${title}-${ts1}-to-${ts2}.${ext}`
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
  }

  return (
    <div class="jfs-fe-osd" style={{ maxWidth: '640px', margin: '0 auto', height: 'auto' }}>
      <div class="jfs-fe-row sep-b">
        <button class="jfs-fe-btn g" style={{ flex: '0 0 auto' }} onClick={onBack}>← 返回</button>
        <div style={{ flex: '1' }} />
        <span class="jfs-fe-title">预览 · {sizeStr}</span>
        <div style={{ flex: '1' }} />
        <button class="jfs-fe-btn g" style={{ flex: '0 0 auto', padding: '2px 8px', fontSize: '16px' }} onClick={onClose}>✕</button>
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
      <div class="jfs-fe-row sep-t" style={{ flexWrap: 'wrap', gap: '6px' }}>
        <button class="jfs-fe-btn g" onClick={() => setRotation(r => r - 5)} dangerouslySetInnerHTML={{ __html: ICON_CCW + ' 5°' }} />
        <button class="jfs-fe-btn g" onClick={() => setRotation(r => r - 1)} dangerouslySetInnerHTML={{ __html: ICON_CCW + ' 1°' }} />
        <span class="jfs-fe-muted" style={{ minWidth: '28px', textAlign: 'center' }}>{rotation}°</span>
        <button class="jfs-fe-btn g" onClick={() => setRotation(r => r + 1)} dangerouslySetInnerHTML={{ __html: '1° ' + ICON_CW }} />
        <button class="jfs-fe-btn g" onClick={() => setRotation(r => r + 5)} dangerouslySetInnerHTML={{ __html: '5° ' + ICON_CW }} />
        <div class="jfs-fe-spacer" />
        <button class="jfs-fe-btn p" onClick={handleDownload}>下载</button>
        <button class="jfs-fe-btn"   onClick={handleDelete}>删除</button>
      </div>
    </div>
  )
}
