import { defineConfig } from 'vite'
import { aliveUIVite } from '@alivecss/aliveui/vite'

export default defineConfig({
  plugins: [
    aliveUIVite({ content: ['./src/**/*.{ts,tsx,css}'] }),
  ],
  build: {
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: () => 'jellyfin-suite-enhancer.js',
    },
    outDir: '../../src/JellyfinSuite.Plugin/Web',
    emptyOutDir: false,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
})
