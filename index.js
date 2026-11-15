/**
 * dsh-lit-radar — a literature radar for DSH.
 *
 * Host half: registers the model-facing `lit_radar` tool. Retrieval, dedupe, the
 * delivered-history store, and digest rendering live in ./radar.js, which the
 * CLI (./cli.mjs) shares.
 *
 * `defineTool` is loaded from the running installation at activation time
 * rather than through a bare static import: a bundle linked from a workspace
 * directory has no node_modules of its own, so `@deepseek-ai/dsh-tools` does not
 * resolve from here, while the copy inside the DSH installation does.
 */

import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
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

export const name = 'lit-radar'

/** The tool registry is the only required service. */
export const inject = ['tools']

const ACTIONS = ['scan', 'status', 'keywords', 'set_keywords', 'reset']

const DESCRIPTION = 'Search Crossref, OpenAlex, and arXiv for recent publications matching the saved '
  + 'research keywords and return only items not delivered before. `scan` fetches, marks what it returns '
  + 'as delivered, and prints a digest with title, venue, date, DOI/URL, authors, and an abstract excerpt; '
  + '`status`, `keywords`, `set_keywords`, and `reset` manage the keyword list and delivered history. '
  + 'A fresh install has no keywords: collect the topics from the user and call `set_keywords` first.'

const NO_KEYWORDS = 'No keywords are configured, so nothing was fetched. Ask the user which research '
  + 'topics to watch, then call lit_radar with action "set_keywords" and a list of { topic, query }: '
  + 'topic is a short label in the user\'s language, query is the English search phrase sent to the databases.'

const TOOL_PACKAGE = ['dsh-tools', 'lib', 'index.js']

/** Files that may hold the running installation's `dsh-tools` entry point. */
function candidateFiles() {
  const files = []
  const installDir = process.env.DSH_INSTALL_DIR
  if (installDir) files.push(join(dirname(installDir), ...TOOL_PACKAGE))
  const resources = process.resourcesPath
  if (resources) files.push(join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', ...TOOL_PACKAGE))
  return files
}

let pendingDefineTool = null

/**
 * Resolve `defineTool` from the running DSH installation.
 * @returns the installation's `defineTool`, so the registered definition is
 * exactly what the installed tool registry expects.
 */
function loadDefineTool() {
  if (!pendingDefineTool) {
    pendingDefineTool = (async () => {
      const attempts = []
      try {
        const mod = await import('@deepseek-ai/dsh-tools')
        if (typeof mod.defineTool === 'function') return mod.defineTool
        attempts.push('@deepseek-ai/dsh-tools: module has no defineTool export')
      } catch (error) {
        attempts.push(`@deepseek-ai/dsh-tools: ${error?.message || error}`)
      }
      for (const file of candidateFiles()) {
        try {
          const mod = await import(pathToFileURL(file).href)
          if (typeof mod.defineTool === 'function') return mod.defineTool
          attempts.push(`${file}: module has no defineTool export`)
        } catch (error) {
          attempts.push(`${file}: ${error?.message || error}`)
        }
      }
      throw new Error(`lit-radar could not load defineTool from the DSH installation:\n${attempts.join('\n')}`)
    })()
  }
  return pendingDefineTool
}

/**
 * Register the radar tool for the lifetime of this plugin activation.
 * @param ctx - plugin context carrying the tool registry.
 * @param config - the row's config: `days`, `limit`, `perKeyword`, `sources`, `keywords`, `stateDir`, `mailto`, `openalexKey`.
 */
export async function apply(ctx, config) {
  const defineTool = await loadDefineTool()
  const settings = resolveSettings(config)
  let storePromise = null

  const openStore = () => {
    if (!storePromise) storePromise = loadStore(settings)
    return storePromise
  }

  ctx.tools.register(defineTool({
    name: 'lit_radar',
    description: DESCRIPTION,
    parameters: {
      action: {
        type: 'string',
        enum: ACTIONS,
        description: 'Operation to run. Defaults to `scan`.',
      },
      days: {
        type: 'number',
        description: 'Lookback window in days for `scan`, 1–90. Defaults to the configured window (7).',
      },
      limit: {
        type: 'number',
        description: 'Maximum items `scan` returns, 1–60. Defaults to the configured cap (25).',
      },
      keywords: {
        type: 'array',
        description: 'Required by `set_keywords`: the complete replacement keyword list.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            topic: { type: 'string', required: true, description: 'Short label shown in the digest, usually in the user\'s language.' },
            query: { type: 'string', required: true, description: 'English search phrase sent to the databases.' },
          },
        },
      },
      confirm: {
        type: 'boolean',
        description: 'Required by `reset`; must be true, because it erases the delivered history.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const action = typeof args?.action === 'string' ? args.action : 'scan'
      const store = await openStore()

      if (action === 'status') {
        return formatStatus(settings, store)
      }

      if (action === 'keywords') {
        const keywords = effectiveKeywords(store, settings)
        if (keywords.length === 0) return NO_KEYWORDS
        const origin = store.keywords ? 'saved keywords' : 'keywords from the plugin config'
        return [`${origin} (${keywords.length}):`, ...keywords.map((k, i) => `${i + 1}. ${k.topic} — ${k.query}`)]
          .join('\n')
      }

      if (action === 'set_keywords') {
        const raw = Array.isArray(args?.keywords) ? args.keywords : null
        if (!raw || raw.length === 0) {
          throw new Error('set_keywords requires a non-empty `keywords` array of { topic, query }')
        }
        const invalid = raw.find(item => !isKeyword(item))
        if (invalid) {
          throw new Error(`invalid keyword entry ${JSON.stringify(invalid)}: both topic and query must be non-empty strings`)
        }
        const keywords = raw.map(item => ({ topic: item.topic.trim(), query: item.query.trim() }))
        store.keywords = keywords
        await saveStore(settings, store)
        return [`Saved ${keywords.length} keywords; the next scan uses them.`,
          ...keywords.map((k, i) => `${i + 1}. ${k.topic} — ${k.query}`)].join('\n')
      }

      if (action === 'reset') {
        if (args?.confirm !== true) {
          throw new Error('reset erases the delivered history; call it again with confirm: true')
        }
        const removed = Object.keys(store.seen).length
        store.seen = {}
        store.lastScanAt = null
        store.lastNew = 0
        await saveStore(settings, store)
        return `Cleared ${removed} delivered entries; the next scan can report those papers again.`
      }

      const outcome = await runScan(settings, store, {
        days: args?.days,
        limit: args?.limit,
        signal: exec?.signal,
      })
      if (!outcome) return NO_KEYWORDS
      return formatDigest(outcome.run, outcome.result)
    },
  }))
}
