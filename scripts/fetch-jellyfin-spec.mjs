#!/usr/bin/env node
/**
 * Downloads the official Jellyfin OpenAPI spec from a running server.
 * Only needed once (or when Jellyfin version upgrades).
 *
 * Usage:
 *   node scripts/fetch-jellyfin-spec.mjs [--url=http://localhost:8600]
 */

import { writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const __dir = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dir, '..')
const outPath = resolve(root, 'packages/api-types/openapi-jellyfin.json')

const urlArg = process.argv.find(a => a.startsWith('--url='))
const base = urlArg ? urlArg.slice(6) : 'http://localhost:8600'
const specUrl = `${base}/api-docs/openapi.json`

console.log(`Fetching official Jellyfin spec from ${specUrl} …`)
const res = await fetch(specUrl)
if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${specUrl}`)
const spec = await res.json()

console.log(`Got spec: openapi ${spec.openapi}, ${Object.keys(spec.paths ?? {}).length} paths`)
writeFileSync(outPath, JSON.stringify(spec, null, 2))
console.log(`Written ${outPath}`)
console.log()
console.log('Next: this file is a one-time snapshot. Update it only when Jellyfin version changes.')
console.log('Merge with plugin spec is not yet automated — the frontend uses openapi.json (plugin only).')
