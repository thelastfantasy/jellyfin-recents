import { QueryClientProvider } from '@tanstack/react-query'
import { useAtomValue } from 'jotai'
import { useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'

import { FrameExportModalApp } from '../components/FrameExportModal'
import { OsdButtons } from '../components/OsdButtons'
import { OsdOverlay } from '../components/OsdOverlay'
import { Toast } from '../components/Toast'
import { TrickplayThumb } from '../components/TrickplayThumb'
import { useFrameInfoPreload } from '../hooks/useFrameInfoPreload'
import { useGestures } from '../hooks/useGestures'
import { useLongPress } from '../hooks/useLongPress'
import { useTrickplay } from '../hooks/useTrickplay'
import { sOsdTargetAtom, sTrickplayEnabledAtom,sVideoElAtom } from './injector'
import { queryClient } from './queryClient'
import { openFrameExportModal } from './state'
import { getCurrentVideoEl, getItemId,getSpeedRate } from './video-tracker'

function PlayerRoot() {
  const videoEl = useAtomValue(sVideoElAtom)
  const trickEnabled = useAtomValue(sTrickplayEnabledAtom)
  const getRate = useCallback(() => getSpeedRate(), [])
  useGestures(videoEl, getItemId)
  useLongPress(videoEl, getRate)
  useTrickplay(videoEl, getItemId, trickEnabled)
  useFrameInfoPreload(videoEl, getItemId)
  return null
}

export function AppRoot() {
  const osdTarget = useAtomValue(sOsdTargetAtom)
  const videoEl = useAtomValue(sVideoElAtom)
  const handleOpenFrameExport = useMemo(() => () => {
    const id = getItemId()
    if (id && getCurrentVideoEl()) openFrameExportModal(getCurrentVideoEl()!, id)
  }, [])

  return (
    <QueryClientProvider client={queryClient}>
      <OsdOverlay />
      <Toast />
      <TrickplayThumb />
      <FrameExportModalApp />
      {osdTarget && videoEl && createPortal(
        <div style={{ display: 'inline-flex', alignItems: 'center' }}>
          <OsdButtons videoEl={videoEl} getItemId={getItemId} onOpenFrameExport={handleOpenFrameExport} />
        </div>,
        osdTarget,
      )}
      <PlayerRoot />
    </QueryClientProvider>
  )
}
