#!/usr/bin/env node
/**
 * dsh-lit-radar CLI — the same radar without DSH.
 *
 * Shares ./radar.js and the same state directory as the plugin, so a command-line
 * scan and a chat scan drain the same delivered history.
 */

import { readFile } from 'node:fs/promises'
import {
  effectiveKeywords,
  formatDigest,
  formatStatus,
  isKeyword,
  loadStore,
  resolveSettings,
  runScan,
  saveStore,
} from './radar.js'

const USAGE = `lit-radar — recent papers matching your research keywords, only the ones you have not seen.

Usage
  lit-radar [options]                  scan and print a digest
  lit-radar --status                   print configuration and counters
  lit-radar --list-keywords            print the active keyword list
  lit-radar --reset --yes              clear the delivered history

Keywords
  --keywords "topic=query;topic=query" set and save the keyword list (topic is optional)
  --keywords-file <path>               JSON file: [{ "topic": "...", "query": "..." }]

Scan
  --days <n>            lookback window in days, 1-90 (default 7)
  --limit <n>           maximum items printed, 1-60 (default 25)
  --per-keyword <n>     OpenAlex records requested per keyword, 1-25 (default 8)
  --sources <list>      comma-separated: crossref, openalex, arxiv (default all three)

Setup
  --state <dir>         state directory (default ~/.dsh/lit-radar)
  --mailto <email>      polite-pool contact for Crossref and OpenAlex; greatly reduces 429s
  --openalex-key <key>  OpenAlex API key; removes the shared anonymous daily budget

Output
  --json                machine-readable result instead of the digest
  -h, --help            this text

Examples
  lit-radar --keywords "methane pyrolysis;Fischer-Tropsch synthesis" --days 30
  lit-radar --keywords-file examples/keywords.methane-catalysis.json --limit 40
  lit-radar --status
`

/** Parse `--flag value` and `--flag=value` pairs. */
function parseArgs(argv) {
  const opts = { action: 'scan' }
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i]
    const [flag, inline] = raw.includes('=') ? [raw.slice(0, raw.indexOf('=')), raw.slice(raw.indexOf('=') + 1)] : [raw, undefined]
    const value = () => {
      if (inline !== undefined) return inline
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value`)
      i += 1
      return next
    }
    switch (flag) {
      case '-h': case '--help': opts.help = true; break
      case '--json': opts.json = true; break
      case '--status': opts.action = 'status'; break
      case '--list-keywords': opts.action = 'keywords'; break
      case '--reset': opts.action = 'reset'; break
      case '--yes': opts.yes = true; break
      case '--keywords': opts.keywords = value(); break
      case '--keywords-file': opts.keywordsFile = value(); break
      case '--days': opts.days = value(); break
      case '--limit': opts.limit = value(); break
      case '--per-keyword': opts.perKeyword = value(); break
      case '--sources': opts.sources = value(); break
      case '--state': opts.state = value(); break
      case '--mailto': opts.mailto = value(); break
      case '--openalex-key': opts.openalexKey = value(); break
      default: throw new Error(`unknown option ${raw}\n\n${USAGE}`)
    }
  }
  return opts
}

/** Turn `"topic=query;other=phrase"` into keyword pairs. */
function parseKeywordString(text) {
  return text
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const at = part.indexOf('=')
      if (at === -1) return { topic: part, query: part }
      return { topic: part.slice(0, at).trim(), query: part.slice(at + 1).trim() }
    })
}

/** Read a keyword list from a JSON file holding an array or `{ keywords: [...] }`. */
async function readKeywordFile(file) {
  const parsed = JSON.parse(await readFile(file, 'utf8'))
  const list = Array.isArray(parsed) ? parsed : parsed?.keywords
  if (!Array.isArray(list)) throw new Error(`${file}: expected an array of { topic, query } or { "keywords": [...] }`)
  return list
}

/** Validate and normalize keyword pairs, so a typo fails with a clear message. */
function assertKeywords(list, source) {
  if (list.length === 0) throw new Error(`${source}: no keywords`)
  const invalid = list.find(item => !isKeyword(item))
  if (invalid) throw new Error(`${source}: invalid entry ${JSON.stringify(invalid)} — both topic and query must be non-empty strings`)
  return list.map(item => ({ topic: item.topic.trim(), query: item.query.trim() }))
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    process.stdout.write(USAGE)
    return 0
  }

  const settings = resolveSettings({
    days: opts.days,
    limit: opts.limit,
    perKeyword: opts.perKeyword,
    sources: opts.sources ? opts.sources.split(',') : undefined,
    stateDir: opts.state,
    mailto: opts.mailto,
    openalexKey: opts.openalexKey,
  })
  const store = await loadStore(settings)

  if (opts.keywords || opts.keywordsFile) {
    const source = opts.keywordsFile ? opts.keywordsFile : '--keywords'
    const list = assertKeywords(
      opts.keywordsFile ? await readKeywordFile(opts.keywordsFile) : parseKeywordString(opts.keywords),
      source,
    )
    store.keywords = list
    await saveStore(settings, store)
    process.stderr.write(`saved ${list.length} keywords\n`)
  }

  if (opts.action === 'status') {
    process.stdout.write(`${formatStatus(settings, store)}\n`)
    return 0
  }

  if (opts.action === 'keywords') {
    const keywords = effectiveKeywords(store, settings)
    if (keywords.length === 0) {
      process.stderr.write('No keywords yet. Pass --keywords "topic=query" or --keywords-file <path>.\n')
      return 2
    }
    process.stdout.write(`${keywords.map((k, i) => `${i + 1}. ${k.topic} — ${k.query}`).join('\n')}\n`)
    return 0
  }

  if (opts.action === 'reset') {
    if (!opts.yes) {
      process.stderr.write('Refusing to erase the delivered history without --yes.\n')
      return 2
    }
    const removed = Object.keys(store.seen).length
    store.seen = {}
    store.lastScanAt = null
    store.lastNew = 0
    await saveStore(settings, store)
    process.stdout.write(`cleared ${removed} delivered entries\n`)
    return 0
  }

  const outcome = await runScan(settings, store, {})
  if (!outcome) {
    process.stderr.write('No keywords configured. Pass --keywords "topic=query" or --keywords-file <path>.\n')
    return 2
  }

  if (opts.json) {
    const { run, result } = outcome
    process.stdout.write(`${JSON.stringify({
      windowDays: run.days,
      fromDate: result.fromDate,
      scannedAt: result.scannedAt,
      matched: result.matched,
      fresh: result.fresh,
      withheld: result.withheld,
      errors: result.errors,
      bySource: result.bySource,
      items: result.picked,
    }, null, 2)}\n`)
    return 0
  }

  process.stdout.write(`${formatDigest(outcome.run, outcome.result)}\n`)
  return 0
}

main().then(
  code => process.exit(code),
  error => {
    process.stderr.write(`lit-radar: ${error?.message || error}\n`)
    process.exit(1)
  },
)
