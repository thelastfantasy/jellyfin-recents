import { useEffect } from 'preact/hooks'
import { sLightboxIdx, _frames, _itemId } from '../state'
import { frameUrl } from '../api/frameExportApi'
import { formatTime } from '../utils'

const ICON_PREV = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`
const ICON_NEXT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`

export function Lightbox() {
  const idx = sLightboxIdx.value

  useEffect(() => {
    if (idx === null) return
    const handler = (ev: KeyboardEvent) => {
      ev.stopPropagation()
      if (ev.key === 'Escape')                                      sLightboxIdx.value = null
      else if (ev.key === 'ArrowLeft'  && idx > 0)                  sLightboxIdx.value = idx - 1
      else if (ev.key === 'ArrowRight' && idx < _frames.length - 1) sLightboxIdx.value = idx + 1
    }
    document.addEventListener('keydown', handler, { capture: true })
    return () => document.removeEventListener('keydown', handler, { capture: true })
  }, [idx])

  if (idx === null) return null
  const f = _frames[idx]
  if (!f) return null

  const close   = () => { sLightboxIdx.value = null }
  const hasPrev = idx > 0
  const hasNext = idx < _frames.length - 1

  return (
    <div class="jfs-fe-lb" onClick={e => { if (e.target === e.currentTarget) close() }}>
      <button
        class="jfs-fe-lb-nav jfs-fe-lb-prev"
        title="上一帧（←）"
        disabled={!hasPrev}
        onClick={e => { e.stopPropagation(); if (hasPrev) sLightboxIdx.value = idx - 1 }}
        dangerouslySetInnerHTML={{ __html: ICON_PREV }}
      />
      <img src={frameUrl(_itemId, f.fiIdx, f.posMs, 0)} alt={formatTime(f.posMs)} />
      <button
        class="jfs-fe-lb-nav jfs-fe-lb-next"
        title="下一帧（→）"
        disabled={!hasNext}
        onClick={e => { e.stopPropagation(); if (hasNext) sLightboxIdx.value = idx + 1 }}
        dangerouslySetInnerHTML={{ __html: ICON_NEXT }}
      />
      <button class="jfs-fe-lb-close" title="关闭" onClick={close}>✕</button>
      <div class="jfs-fe-lb-info">{idx + 1} / {_frames.length} · {formatTime(f.posMs)}</div>
    </div>
  )
}
