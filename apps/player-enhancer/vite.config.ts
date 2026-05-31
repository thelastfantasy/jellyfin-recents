import { defineConfig } from 'vite'
import { aliveUIVite } from '@alivecss/aliveui/vite'
import { resolve } from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@jfs/api-types': resolve(__dirname, '../../packages/api-types/src/jellyfin-api.ts'),
      '@jfs/i18n': resolve(__dirname, '../../packages/i18n/src/index.ts'),
    },
  },
  esbuild: {
    jsxImportSource: 'preact',
  },
  plugins: [
    aliveUIVite({ content: ['./src/**/*.{ts,tsx,css}'] }),
  ],
  build: {
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: () => 'jellyfin-suite-enhancer.js',
    },
    outDir: '../../packages/JellyfinSuite.Plugin/Web',
    emptyOutDir: false,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
})
