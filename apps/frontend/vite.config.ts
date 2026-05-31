import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'
import { resolve } from 'path'
import type { Plugin, OutputAsset, OutputChunk } from 'rollup'

/** 将 CSS 资产内联注入到 IIFE bundle 头部 */
function inlineCssPlugin(): Plugin {
  return {
    name: 'inline-css',
    generateBundle(_, bundle) {
      const cssAsset = Object.values(bundle).find(
        (c): c is OutputAsset => c.type === 'asset' && c.fileName.endsWith('.css'),
      )
      if (!cssAsset) return

      const jsChunk = Object.values(bundle).find(
        (c): c is OutputChunk => c.type === 'chunk',
      )
      if (!jsChunk) return

      const css = (cssAsset.source as string).replace(/\n/g, ' ').trim()
      const inject = `;(function(){var s=document.createElement('style');s.textContent=${JSON.stringify(css)};document.head.appendChild(s);}());`
      jsChunk.code = inject + jsChunk.code
      delete bundle[cssAsset.fileName]
    },
  }
}

export default defineConfig({
  plugins: [preact()],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/main.tsx'),
      name: 'JellyfinSuite',
      formats: ['iife'],
      fileName: () => 'jellyfin-suite.js',
    },
    outDir: resolve(__dirname, '../JellyfinSuite.Plugin/Web'),
    emptyOutDir: false,
    rollupOptions: {
      output: {
        plugins: [inlineCssPlugin()],
      },
    },
  },
  server: {
    proxy: {
      '/Users': { target: process.env.VITE_JELLYFIN_URL || 'http://localhost:8600', changeOrigin: true },
      '/Items': { target: process.env.VITE_JELLYFIN_URL || 'http://localhost:8600', changeOrigin: true },
      '/System': { target: process.env.VITE_JELLYFIN_URL || 'http://localhost:8600', changeOrigin: true },
      '/JellyfinSuite': { target: process.env.VITE_JELLYFIN_URL || 'http://localhost:8600', changeOrigin: true },
    },
  },
})
