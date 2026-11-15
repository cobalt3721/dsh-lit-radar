/**
 * Dev harness: exercises the real retrieval path under plain Node, without DSH.
 * Run from the package root: node test/scan.mjs [--once] [--sources=crossref,arxiv]
 */

import { readFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  effectiveKeywords,
  formatDigest,
  formatStatus,
  loadStore,
  resolveSettings,
  saveStore,
  scan,
} from '../radar.js'

const stateDir = fileURLToPath(new URL('./.state', import.meta.url))
await rm(stateDir, { recursive: true, force: true })

const sources = process.argv.find(arg => arg.startsWith('--sources='))?.slice('--sources='.length).split(',')
const settings = resolveSettings({ stateDir, days: 7, limit: 8, perKeyword: 8, ...(sources ? { sources } : {}) })
settings.keywords = JSON.parse(
  await readFile(fileURLToPath(new URL('../examples/keywords.methane-catalysis.json', import.meta.url)), 'utf8'),
).keywords

const store = await loadStore(settings)
const keywords = effectiveKeywords(store, settings)

console.log(`keywords=${keywords.length} sources=${settings.sources.join('+')} days=${settings.days}`)
const started = Date.now()
const result = await scan(settings, keywords, store)
console.log(`scan took ${Date.now() - started} ms`)
console.log(`raw by source: ${JSON.stringify(result.bySource)}`)
console.log(`raw by keyword: ${JSON.stringify(result.byKeyword)}\n`)
console.log(formatDigest(settings, result))
await saveStore(settings, store)

if (process.argv.includes('--once')) process.exit(0)

const before = Object.keys(store.seen).length
const again = await scan(settings, keywords, store)
await saveStore(settings, store)
console.log('\n--- second scan (dedupe check) ---')
console.log(`matched=${again.matched} fresh=${again.fresh} returned=${again.picked.length} seenBefore=${before} seenAfter=${Object.keys(store.seen).length}`)

console.log('\n--- status ---')
console.log(formatStatus(settings, store))
