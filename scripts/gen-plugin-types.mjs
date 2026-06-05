#!/usr/bin/env node
/**
 * Generates TypeScript types for JellyfinSuite plugin APIs.
 *
 * Usage:
 *   node scripts/gen-plugin-types.mjs --file=packages/api-types/openapi.json
 *   node scripts/gen-plugin-types.mjs [--url=http://localhost:8600]  (legacy: fetches from server)
 */

import openapiTS, { astToString } from 'openapi-typescript'
import { readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve, join } from 'path'

const __dir = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dir, '..')

const fileArg = process.argv.find(a => a.startsWith('--file='))
const urlArg = process.argv.find(a => a.startsWith('--url='))

let spec
if (fileArg) {
  const filePath = resolve(root, fileArg.slice(7))
  console.log(`Reading spec from ${filePath} …`)
  spec = JSON.parse(readFileSync(filePath, 'utf8'))
} else {
  const base = urlArg ? urlArg.slice(6) : 'http://localhost:8600'
  const specUrl = `${base}/api-docs/openapi.json`
  console.log(`Fetching spec from ${specUrl} …`)
  const res = await fetch(specUrl)
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${specUrl}`)
  spec = await res.json()

  // When fetching Swashbuckle's full spec, filter to JellyfinSuite paths only
  const filteredPaths = Object.fromEntries(
    Object.entries(spec.paths ?? {}).filter(([p]) => p.includes('/JellyfinSuite/'))
  )

  function collectRefs(obj, refs = new Set()) {
    if (!obj || typeof obj !== 'object') return refs
    if (Array.isArray(obj)) { obj.forEach(v => collectRefs(v, refs)); return refs }
    for (const [k, v] of Object.entries(obj)) {
      if (k === '$ref' && typeof v === 'string') refs.add(v.replace('#/components/schemas/', ''))
      else collectRefs(v, refs)
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

  // De-duplicate operationIds (Swashbuckle assigns same name to routes with same action name)
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

  spec = { ...spec, paths: filteredPaths, components: { ...(spec.components ?? {}), schemas: filteredSchemas } }
}

console.log(`Spec: ${Object.keys(spec.paths ?? {}).length} paths, ${Object.keys(spec.components?.schemas ?? {}).length} schemas`)

const outPath = join(root, 'packages/api-types/src/jellyfin-api.ts')
const ast = await openapiTS(spec)
const output = astToString(ast)
writeFileSync(outPath, output)
console.log(`Written ${outPath}`)
