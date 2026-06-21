import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'url'
import path from 'path'

// Use forward slashes on all platforms — glob patterns require them.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..').replace(/\\/g, '/')

export default defineConfig({
  // root must be the repo root so that tests/frontend/ is inside vite's root
  // (files outside root get a /@fs/ prefix that Node workers cannot import).
  root: repoRoot,
  test: {
    globals: true,
    environment: 'jsdom',
    // Use absolute globs to avoid Windows drive-letter stripping in
    // vitest's root-relative path resolution.
    include: [
      `${repoRoot}/tests/frontend/**/*.test.ts`,
      `${repoRoot}/tests/frontend/**/*.test.tsx`,
    ],
  },
})
