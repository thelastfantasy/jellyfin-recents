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
    generationLog: (taskId: string) => `${base()}/JellyfinSuite/FrameExport/Result/${encodeURIComponent(taskId)}/generation-log.json`,
  },

  playerEnhancer: {
    config: () => `${base()}/JellyfinSuite/PlayerEnhancer/Config`,
  },

  stitch: {
    devices:    () => `${base()}/JellyfinSuite/Stitch/Devices`,
    models:     () => `${base()}/JellyfinSuite/Stitch/Models`,
    ortVersions: () => `${base()}/JellyfinSuite/Stitch/OrtVersions`,

    modelDownload: () => `${base()}/JellyfinSuite/Stitch/Models/Download`,
    modelDownloadProgress: (family: string, version: string) =>
      `${base()}/JellyfinSuite/Stitch/Models/DownloadProgress?family=${encodeURIComponent(family)}&version=${encodeURIComponent(version)}`,
    modelDelete: (family: string, version: string) =>
      `${base()}/JellyfinSuite/Stitch/Models/${encodeURIComponent(family)}/${encodeURIComponent(version)}`,

    ortVersionDownload: () => `${base()}/JellyfinSuite/Stitch/OrtVersions/Download`,
    ortVersionDownloadProgress: (version: string) =>
      `${base()}/JellyfinSuite/Stitch/OrtVersions/DownloadProgress?version=${encodeURIComponent(version)}`,
    ortVersionActivate: () => `${base()}/JellyfinSuite/Stitch/OrtVersions/Activate`,

    upscale:        () => `${base()}/JellyfinSuite/Stitch/Upscale`,
    upscaleStatus:  (jobId: string) => `${base()}/JellyfinSuite/Stitch/Upscale/${encodeURIComponent(jobId)}`,
    upscaleCancel:  (jobId: string) => `${base()}/JellyfinSuite/Stitch/Upscale/${encodeURIComponent(jobId)}/Cancel`,
    upscaleLog:     (jobId: string) => `${base()}/JellyfinSuite/Stitch/Upscale/${encodeURIComponent(jobId)}/Log`,
  },
}
