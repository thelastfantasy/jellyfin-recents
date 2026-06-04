import { useEffect, useRef } from 'react'

import { openFrameInfoStream } from '../api/frameExportApi'
import {
  _frameIndex,
  _itemId as _gItemId,
  setFpsFrac,
  setFrameIndex,
} from '../core/state'

const preloadState = {
  evSrc: null as EventSource | null,
  aborted: false,
  itemId: '',
}

export function cancelFrameInfoPreload(): void {
  if (preloadState.evSrc) {
    preloadState.aborted = true
    preloadState.evSrc.close()
    preloadState.evSrc = null
  }
  preloadState.itemId = ''
}

export function useFrameInfoPreload(videoEl: HTMLVideoElement | null, getItemId: () => string): void {
  const startedRef = useRef('')

  useEffect(() => {
    if (!videoEl) return
    const id = getItemId()
    if (!id || id === startedRef.current) return

    // Cleanup previous preload
    if (startedRef.current) {
      cancelFrameInfoPreload()
      if (_gItemId !== preloadState.itemId) setFrameIndex(null)
    }

    // 帧索引已对该 item 完整加载（_frameIndex !== null 即代表完整）→ 跳过请求
    if (_frameIndex !== null && preloadState.itemId === id) {
      startedRef.current = id
      return
    }

    startedRef.current = id
    preloadState.itemId = id
    preloadState.aborted = false

    const accumulated: Array<{ ms: number; isKey: boolean; frameIndex: number }> = []
    let done = false

    const evSrc = openFrameInfoStream(id, 0,
      batch => {
        if (preloadState.aborted || done) return
        accumulated.push(...batch)
      },
      fps => {
        if (preloadState.aborted || done) return
        done = true
        setFpsFrac(fps)
        accumulated.sort((a, b) => a.ms - b.ms)
        setFrameIndex(accumulated)
        preloadState.evSrc = null
        evSrc.close()
      },
      () => {
        if (preloadState.aborted || done) return
        preloadState.evSrc = null
      }
    )

    preloadState.evSrc = evSrc
    void evSrc

    return () => {
      if (preloadState.evSrc === evSrc) {
        preloadState.evSrc = null
      }
      evSrc.close()
    }
  }, [videoEl, getItemId])
}
