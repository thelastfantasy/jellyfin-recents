import { getApiBaseUrl } from '../lib/utils'

const base = () => getApiBaseUrl()

export const jf = {
  item: (id: string, fields?: string) =>
    `${base()}/Items/${encodeURIComponent(id)}${fields ? `?Fields=${fields}` : ''}`,
}

export const suite = {
  seekPreview: {
    frame:       (id: string, posMs: number) => `${base()}/JellyfinSuite/SeekPreview/${encodeURIComponent(id)}?positionMs=${posMs}`,
    frameInfo:   (id: string, posMs: number) => `${base()}/JellyfinSuite/SeekPreview/${encodeURIComponent(id)}/frame-info?positionMs=${posMs}`,
    readyStream: (id: string, posMs: number) => `${base()}/JellyfinSuite/SeekPreview/${encodeURIComponent(id)}/ready-stream?positionMs=${posMs}`,
  },

  frameInfoStream: (id: string, ms: number) =>
    `${base()}/JellyfinSuite/${encodeURIComponent(id)}/FrameInfoStream?currentTimeMs=${ms}`,

  frameExport: {
    jpeg: (id: string, fiIdx: number, posMs: number, width: number) =>
      fiIdx >= 0
        ? `${base()}/JellyfinSuite/FrameExport/${encodeURIComponent(id)}?frameIdx=${fiIdx}&width=${width}`
        : `${base()}/JellyfinSuite/FrameExport/${encodeURIComponent(id)}?positionMs=${Math.round(posMs)}&width=${width}`,

    prefetchReady: (id: string) =>
      `${base()}/JellyfinSuite/FrameExport/PrefetchReady/${encodeURIComponent(id)}`,

    generate:     () => `${base()}/JellyfinSuite/FrameExport/Generate`,
    taskProgress: (taskId: string) => `${base()}/JellyfinSuite/FrameExport/TaskProgress?taskId=${encodeURIComponent(taskId)}`,
    cancel:       (taskId: string) => `${base()}/JellyfinSuite/FrameExport/Cancel/${encodeURIComponent(taskId)}`,
    result:       (taskId: string) => `${base()}/JellyfinSuite/FrameExport/Result/${encodeURIComponent(taskId)}`,
  },

  playerEnhancer: {
    config: () => `${base()}/JellyfinSuite/PlayerEnhancer/Config`,
  },
}
