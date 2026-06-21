import { useEffect } from 'react'

import { closeTrickplayStream,initTrickplay } from '../services/trickplay'

export function useTrickplay(
  videoEl: HTMLVideoElement | null,
  getItemId: () => string,
  enabled: boolean,
): void {
  useEffect(() => {
    if (!videoEl || !enabled) return
    initTrickplay(getItemId, videoEl)
    return () => closeTrickplayStream()
  }, [videoEl, enabled, getItemId])
}
