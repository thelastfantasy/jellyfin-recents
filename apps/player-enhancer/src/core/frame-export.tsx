import { useRef, useEffect, useCallback, useState } from 'react'
import { createPortal } from 'react-dom'
import { atom, getDefaultStore, useAtomValue, useSetAtom } from 'jotai'
import { setGesturesSuspended } from '../hooks/useGestures'
import {
  sPage, sExportType, sResultUrl, sFileSize, sLightboxIdx,
  sSettings, pageAtom, sModalPhase, modalPhaseAtom,
  sPrefetchTotal, sPrefetchDone, sProgressTaskId,
} from './state'
import { useFrameExport } from '../hooks/useFrameExport'
import { t } from '../lib/i18n'
import { GridPage }     from '../components/GridPage'
import { ProgressPage } from '../components/ProgressPage'
import { ResultPage }   from '../components/ResultPage'
import { Lightbox }     from '../components/Lightbox'
import { CropPopover }  from '../components/CropPopover'

const jstore = getDefaultStore()

// ── FrameExport modal atom ───────────────────────────────────────────────────

export const _feOpen = atom<{ videoEl: HTMLVideoElement; itemId: string } | null>(null)

export function openFrameExportModal(videoEl: HTMLVideoElement, itemId: string): void {
  const root = document.querySelector<HTMLElement>('[data-jfs-modal-root]')
  if (root) root.style.display = ''
  sPage.value = 'grid'
  jstore.set(_feOpen, { videoEl, itemId })
}

// ── Modal container ─────────────────────────────────────────────────────────

function FrameExportModalApp() {
  const feInfo = useAtomValue(_feOpen)
  if (!feInfo) return null
  return <FrameExportModalInner videoEl={feInfo.videoEl} itemId={feInfo.itemId} />
}

function FrameExportModalInner({ videoEl, itemId }: { videoEl: HTMLVideoElement; itemId: string }) {
  const setFE = useSetAtom(_feOpen)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const dragRef = useRef<{ ox: number; oy: number; startX: number; startY: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const { loadInitialFrames, expandFrames, submitGenerate } = useFrameExport(videoEl, itemId)

  // ESC handler
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'Escape') return; e.stopPropagation()
    if (sLightboxIdx.value !== null) sLightboxIdx.value = null
    else handleClose()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function handleClose() {
    setGesturesSuspended(false)
    document.body.classList.remove('jfs-fe-open')
    sLightboxIdx.value = null
    sModalPhase.value = 'skeleton'
    setFE(null)
  }

  // Video disconnect guard
  useEffect(() => {
    const obs = new MutationObserver(() => { if (!videoEl?.isConnected) handleClose() })
    obs.observe(document.body, { childList: true, subtree: true })
    return () => obs.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Drag
  const onDragStart = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button,select,input,label,a,.jfs-fe-pbar,[id$="tbar"]')) return
    const rect = rootRef.current?.getBoundingClientRect()
    if (!rect) return
    dragRef.current = { ox: e.clientX - rect.left, oy: e.clientY - rect.top, startX: rect.left, startY: rect.top }
    setPos({ x: rect.left, y: rect.top })
    document.body.style.userSelect = 'none'
    e.preventDefault()
  }, [])

  useEffect(() => {
    if (!pos) return
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) return
      const el = rootRef.current
      if (!el) return
      setPos({ x: Math.max(0, Math.min(window.innerWidth - el.offsetWidth, e.clientX - dragRef.current.ox)), y: Math.max(0, Math.min(window.innerHeight - 40, e.clientY - dragRef.current.oy)) })
    }
    const onUp = () => { dragRef.current = null; document.body.style.userSelect = '' }
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [pos])

  const page = useAtomValue(pageAtom)
  const ps = pos

  return createPortal(
    <div ref={rootRef} tabIndex={-1} onKeyDown={onKeyDown} onMouseDown={onDragStart}
      data-jfs-modal-root="true"
      style={{
        position: 'fixed', zIndex: 99999, display: 'flex', flexDirection: 'column',
        width: 'min(92vw, 960px)', fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
        pointerEvents: 'auto',
        ...(ps ? { left: ps.x, top: ps.y, bottom: 'auto', marginLeft: 0 } : { bottom: 12, left: '50%', marginLeft: 'calc(-1 * min(46vw, 480px))' }),
      }}>
      {page === 'grid' && <GridPage onClose={handleClose} onExpand={dir => expandFrames(dir)} onGenerate={() => submitGenerate()} />}
      {page === 'progress' && <ProgressPage onClose={handleClose} onResult={(url, size) => { sResultUrl.value = url; sFileSize.value = size; sPage.value = 'result' }} />}
      {page === 'result' && <ResultPage onClose={handleClose} onBack={() => { sPage.value = 'grid' }} />}
      <Lightbox />
      <CropPopover />
    </div>,
    document.body,
  )
}

export { FrameExportModalApp }

// Re-export for backward compat (used by FrameGrid retry)
export { updateFrameImage } from '../hooks/useFrameExport'
