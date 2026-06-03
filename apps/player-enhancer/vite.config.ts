import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { aliveUIVite } from '@alivecss/aliveui/vite'
import { resolve } from 'path'

export default defineConfig({
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  resolve: {
    alias: {
      '@jfs/api-types': resolve(__dirname, '../../packages/api-types/src/jellyfin-api.ts'),
      '@jfs/i18n': resolve(__dirname, '../../packages/i18n/src/index.ts'),
    },
  },
  plugins: [
    react(),
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
    sourcemap: process.env.DEPLOY_MAP === '1' ? 'inline' as const : false,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
})
