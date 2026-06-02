import { useEffect } from 'react'
import { useAtomValue } from 'jotai'
import { sLightboxIdx, _frames, _itemId, lightboxIdxAtom } from '../core/state'
import { frameUrl } from '../api/frameExportApi'

const ICON_PREV = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`
const ICON_NEXT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`

export function Lightbox() {
  const idx = useAtomValue(lightboxIdxAtom)
  const frame = idx !== null ? _frames[idx] : null

  useEffect(() => {
    if (idx === null || !frame?.jpegUrl) return
    const handler = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') sLightboxIdx.value = null
      else if (ev.key === 'ArrowLeft' && idx > 0) sLightboxIdx.value = idx - 1
      else if (ev.key === 'ArrowRight' && idx < _frames.length - 1) sLightboxIdx.value = idx + 1
    }
    document.addEventListener('keydown', handler, { capture: true })
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handler, { capture: true })
      document.body.style.overflow = ''
    }
  }, [idx, frame?.jpegUrl])

  if (idx === null || !frame?.jpegUrl) return null

  const fullUrl = frameUrl(_itemId, frame.fiIdx, frame.posMs, 0)

  return (
    <div className="jfs-fe-lb" onClick={() => { sLightboxIdx.value = null }}>
      <button className="jfs-fe-lb-close" onClick={e => { e.stopPropagation(); sLightboxIdx.value = null }}>✕</button>
      {_frames.length > 1 && (
        <>
          <button className="jfs-fe-cp-nav jfs-fe-cp-nav-l" disabled={idx <= 0}
            onClick={e => { e.stopPropagation(); sLightboxIdx.value = idx - 1 }}
            dangerouslySetInnerHTML={{ __html: ICON_PREV }} />
          <button className="jfs-fe-cp-nav jfs-fe-cp-nav-r" disabled={idx >= _frames.length - 1}
            onClick={e => { e.stopPropagation(); sLightboxIdx.value = idx + 1 }}
            dangerouslySetInnerHTML={{ __html: ICON_NEXT }} />
        </>
      )}
      <img src={fullUrl} style={{ maxWidth: '92vw', maxHeight: '92vh', objectFit: 'contain', borderRadius: '4px', pointerEvents: 'auto' }}
        onClick={e => e.stopPropagation()} />
    </div>
  )
}
