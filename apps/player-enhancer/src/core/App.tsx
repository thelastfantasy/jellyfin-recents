import { useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useAtomValue } from 'jotai'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useGestures } from '../hooks/useGestures'
import { useLongPress } from '../hooks/useLongPress'
import { useTrickplay } from '../hooks/useTrickplay'
import { useFrameInfoPreload } from '../hooks/useFrameInfoPreload'
import { OsdOverlay } from '../components/OsdOverlay'
import { Toast } from '../components/Toast'
import { OsdButtons } from '../components/OsdButtons'
import { TrickplayThumb } from '../components/TrickplayThumb'
import { FrameExportModalApp } from '../components/FrameExportModal'
import { openFrameExportModal } from './state'
import { sVideoElAtom, sOsdTargetAtom, sTrickplayEnabledAtom } from './injector'
import { getCurrentVideoEl, getSpeedRate, getItemId } from './video-tracker'

const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: 10 * 60 * 1000, staleTime: Infinity } } })

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
