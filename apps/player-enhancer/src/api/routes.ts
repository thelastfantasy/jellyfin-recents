import { getApiBaseUrl, getAccessToken } from '../lib/utils'

const base = () => getApiBaseUrl()
const token = () => encodeURIComponent(getAccessToken())

export const jf = {
  item:            (id: string, fields?: string) => `${base()}/Items/${encodeURIComponent(id)}?api_key=${token()}${fields ? `&Fields=${fields}` : ''}`,
}

export const suite = {
  seekPreview: {
    frame:       (id: string, posMs: number) => `${base()}/JellyfinSuite/SeekPreview/${encodeURIComponent(id)}?positionMs=${posMs}&api_key=${token()}`,
    frameInfo:   (id: string, posMs: number) => `${base()}/JellyfinSuite/SeekPreview/${encodeURIComponent(id)}/frame-info?positionMs=${posMs}&api_key=${token()}`,
    readyStream: (id: string, posMs: number) => `${base()}/JellyfinSuite/SeekPreview/${encodeURIComponent(id)}/ready-stream?positionMs=${posMs}&api_key=${token()}`,
  },

  frameInfoStream: (id: string, ms: number) => `${base()}/JellyfinSuite/${encodeURIComponent(id)}/FrameInfoStream?currentTimeMs=${ms}&api_key=${token()}`,

  frameExport: {
    jpeg: (id: string, fiIdx: number, posMs: number, width: number) =>
      fiIdx >= 0
        ? `${base()}/JellyfinSuite/FrameExport/${encodeURIComponent(id)}?frameIdx=${fiIdx}&width=${width}&api_key=${token()}`
        : `${base()}/JellyfinSuite/FrameExport/${encodeURIComponent(id)}?positionMs=${Math.round(posMs)}&width=${width}&api_key=${token()}`,

    prefetchReady: (id: string, width: number, fiIdx: number[]) =>
      `${base()}/JellyfinSuite/FrameExport/PrefetchReady/${encodeURIComponent(id)}?width=${width}&fiIdx=${encodeURIComponent(fiIdx.join(','))}&api_key=${token()}`,

    generate:     () => `${base()}/JellyfinSuite/FrameExport/Generate?api_key=${token()}`,
    taskProgress: (taskId: string) => `${base()}/JellyfinSuite/FrameExport/TaskProgress?taskId=${encodeURIComponent(taskId)}&api_key=${token()}`,
    cancel:       (taskId: string) => `${base()}/JellyfinSuite/FrameExport/Cancel/${encodeURIComponent(taskId)}?api_key=${token()}`,
    result:       (taskId: string) => `${base()}/JellyfinSuite/FrameExport/Result/${encodeURIComponent(taskId)}?api_key=${token()}`,
  },

  playerEnhancer: {
    config: () => `${base()}/JellyfinSuite/PlayerEnhancer/Config?api_key=${token()}`,
  },
}
