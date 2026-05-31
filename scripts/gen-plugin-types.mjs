#!/usr/bin/env node
/**
 * Fetches Jellyfin's OpenAPI spec, strips it down to JellyfinSuite paths only
 * (preserving referenced schemas + de-duplicating operationIds), then generates
 * TypeScript types via openapi-typescript's programmatic API.
 *
 * Usage: node scripts/gen-plugin-types.mjs [--url=http://localhost:8600]
 */

import openapiTS, { astToString } from 'openapi-typescript'
import { writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve, join } from 'path'

const __dir = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dir, '..')

// Parse args
const urlArg = process.argv.find(a => a.startsWith('--url='))
const base = urlArg ? urlArg.slice(6) : 'http://localhost:8600'
const specUrl = `${base}/api-docs/openapi.json`

// Fetch spec
console.log(`Fetching spec from ${specUrl} …`)
const res = await fetch(specUrl)
if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${specUrl}`)
const spec = await res.json()

// Keep only JellyfinSuite paths
const filteredPaths = Object.fromEntries(
  Object.entries(spec.paths ?? {}).filter(([p]) => p.includes('/JellyfinSuite/'))
)

// Collect all $ref schema names referenced by the filtered paths (transitive)
function collectRefs(obj, refs = new Set()) {
  if (!obj || typeof obj !== 'object') return refs
  if (Array.isArray(obj)) { obj.forEach(v => collectRefs(v, refs)); return refs }
  for (const [k, v] of Object.entries(obj)) {
    if (k === '$ref' && typeof v === 'string') {
      refs.add(v.replace('#/components/schemas/', ''))
    } else {
      collectRefs(v, refs)
    }
  }
  return refs
}

function resolveTransitive(refs, allSchemas) {
  let prev = 0
  while (refs.size !== prev) {
    prev = refs.size
    for (const name of [...refs]) {
      if (allSchemas[name]) collectRefs(allSchemas[name], refs)
    }
  }
  return refs
}

const allSchemas = spec.components?.schemas ?? {}
const usedRefs = resolveTransitive(collectRefs(filteredPaths), allSchemas)
const filteredSchemas = Object.fromEntries(
  Object.entries(allSchemas).filter(([k]) => usedRefs.has(k))
)

// De-duplicate operationIds (same name across different controllers → TS errors)
const seenIds = {}
for (const pathObj of Object.values(filteredPaths)) {
  for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
    const op = pathObj[method]
    if (!op?.operationId) continue
    const orig = op.operationId
    seenIds[orig] = (seenIds[orig] ?? 0) + 1
    if (seenIds[orig] > 1) op.operationId = `${orig}${seenIds[orig]}`
  }
}

const filteredSpec = {
  ...spec,
  paths: filteredPaths,
  components: { ...(spec.components ?? {}), schemas: filteredSchemas },
}

console.log(`Filtered: ${Object.keys(filteredPaths).length} paths, ${Object.keys(filteredSchemas).length} schemas`)

// Generate via programmatic API (avoids npx/shell issues on Windows)
const targets = [
  join(root, 'packages/api-types/src/jellyfin-api.ts'),
]

const ast = await openapiTS(filteredSpec)
const output = astToString(ast)

for (const outPath of targets) {
  console.log(`Writing ${outPath} …`)
  writeFileSync(outPath, output)
}

console.log('✅ Done')
