import { defineConfig } from 'orval'

export default defineConfig({
  jellyfinPlugin: {
    input: {
      target: './openapi.json',
    },
    output: {
      mode: 'tags-split',
      target: './src/client',
      schemas: './src/model',
      client: 'fetch',
      override: {
        mutator: {
          path: './src/fetcher.ts',
          name: 'apiFetch',
        },
        operations: {
          jellyfinSuite_frameInfoStream: { mock: false },
          seekPreview_readyStream: { mock: false },
          frameExport_prefetchReady: { mock: false },
          frameExport_taskProgress: { mock: false },
          posterSheet_streamStatus: { mock: false },
        },
      },
    },
  },
})
