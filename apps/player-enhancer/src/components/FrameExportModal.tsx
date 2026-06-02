import { useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { getDefaultStore, useAtomValue, useSetAtom } from 'jotai'
import { setGesturesSuspended } from '../hooks/useGestures'
import {
  sPage, sResultUrl, sFileSize, sLightboxIdx, sModalPhase,
  pageAtom, modalMinimizedAtom, _feOpen,
} from '../core/state'
import { useFrameExport } from '../hooks/useFrameExport'
import { GridPage }     from './GridPage'
import { ProgressPage } from './ProgressPage'
import { ResultPage }   from './ResultPage'
import { Lightbox }     from './Lightbox'
import { CropPopover }  from './CropPopover'

const jstore = getDefaultStore()

function FrameExportModalApp() {
  const feInfo = useAtomValue(_feOpen)
  const minimized = useAtomValue(modalMinimizedAtom)
  if (!feInfo) return null
  return <FrameExportModalInner videoEl={feInfo.videoEl} itemId={feInfo.itemId} minimized={minimized} />
}

function FrameExportModalInner({ videoEl, itemId, minimized }: {
  videoEl: HTMLVideoElement
  itemId: string
  minimized: boolean
}) {
  const setFE = useSetAtom(_feOpen)
  const rootRef = useRef<HTMLDivElement>(null)
  const { expandBack, expandForward, submitGenerate } = useFrameExport(videoEl, itemId)

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

  function handleMinimize() {
    setGesturesSuspended(false)
    document.body.classList.remove('jfs-fe-open')
    jstore.set(modalMinimizedAtom, true)
  }

  useEffect(() => {
    const obs = new MutationObserver(() => { if (!videoEl?.isConnected) handleClose() })
    obs.observe(document.body, { childList: true, subtree: true })
    return () => obs.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const page = useAtomValue(pageAtom)

  return createPortal(
    <div ref={rootRef} tabIndex={-1} onKeyDown={onKeyDown}
      style={{
        position: 'fixed', bottom: 12, left: '50%', zIndex: 99999,
        display: minimized ? 'none' : 'flex', flexDirection: 'column',
        width: 'min(92vw, 960px)', marginLeft: 'calc(-1 * min(46vw, 480px))',
        fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
        pointerEvents: 'auto',
      }}>
      {page === 'grid' && <GridPage onClose={handleClose} onExpandBack={expandBack} onExpandForward={expandForward} onGenerate={() => submitGenerate()} />}
      {page === 'progress' && <ProgressPage onClose={handleClose} onMinimize={handleMinimize} onResult={(url, size) => { sResultUrl.value = url; sFileSize.value = size; sPage.value = 'result' }} />}
      {page === 'result' && <ResultPage onClose={handleClose} onBack={() => { sPage.value = 'grid' }} />}
      <Lightbox />
      <CropPopover />
    </div>,
    document.body,
  )
}

export { FrameExportModalApp }
