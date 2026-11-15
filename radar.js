/**
 * dsh-lit-radar core: keyword store, OpenAlex/arXiv retrieval, dedupe, digest text.
 *
 * Deliberately free of DSH imports so the retrieval path can be exercised under
 * plain Node (see test/scan.mjs) instead of only through the installed plugin.
 *
 * Retrieval sources are public, key-less APIs:
 *   - OpenAlex works endpoint (journal articles + indexed preprints)
 *   - arXiv Atom API (preprints)
 * Items already delivered are remembered in a JSON store so a daily scan only
 * reports what is new.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const VERSION = '0.1.0'

/** How long a delivered item stays in the seen map before pruning. */
const SEEN_TTL_DAYS = 180

const USER_AGENT = `dsh-lit-radar/${VERSION} (DeepSeek Harness plugin)`

/**
 * Seed keywords shipped with the package: none. A radar is only useful when its
 * keywords match one person's research, so the user supplies them through
 * `set_keywords` (or the plugin's `config.keywords`), and `examples/` carries a
 * worked set to copy from.
 * @type {{ topic: string, query: string }[]}
 */
export const DEFAULT_KEYWORDS = []

const DEFAULTS = {
  days: 7,
  limit: 25,
  perKeyword: 8,
  sources: ['crossref', 'openalex', 'arxiv'],
  stateDir: '',
  mailto: '',
  openalexKey: '',
}

/** Source ids a picture can be configured with. */
const SOURCE_IDS = ['crossref', 'openalex', 'arxiv']

/**
 * Whether a value is a usable `{ topic, query }` keyword pair.
 * @param value - candidate keyword.
 * @returns true when both fields are non-empty strings.
 */
export function isKeyword(value) {
  return Boolean(value)
    && typeof value === 'object'
    && typeof value.topic === 'string' && value.topic.trim().length > 0
    && typeof value.query === 'string' && value.query.trim().length > 0
}

/**
 * Directory the delivered-history store lives in. Defaults next to the profile
 * so it survives restarts and stays out of the plugin's own checkout.
 * @returns absolute directory path.
 */
function defaultStateDir() {
  const base = process.env.DSH_PROFILE_DIR || join(homedir(), '.dsh')
  return join(base, 'lit-radar')
}

/**
 * Merge a row's `config` with the built-in defaults, clamping every number to
 * its supported range rather than trusting the caller.
 * @param config - raw plugin config, possibly empty.
 * @returns resolved settings.
 */
export function resolveSettings(config = {}) {
  const cfg = config && typeof config === 'object' ? config : {}
  const int = (value, fallback, min, max) => {
    const n = Number(value)
    if (!Number.isFinite(n)) return fallback
    return Math.min(max, Math.max(min, Math.round(n)))
  }
  const sources = Array.isArray(cfg.sources)
    ? cfg.sources.filter(source => SOURCE_IDS.includes(source))
    : []
  return {
    days: int(cfg.days, DEFAULTS.days, 1, 90),
    limit: int(cfg.limit, DEFAULTS.limit, 1, 60),
    perKeyword: int(cfg.perKeyword, DEFAULTS.perKeyword, 1, 25),
    sources: sources.length > 0 ? sources : [...DEFAULTS.sources],
    stateDir: typeof cfg.stateDir === 'string' && cfg.stateDir.trim() ? cfg.stateDir.trim() : defaultStateDir(),
    mailto: typeof cfg.mailto === 'string' ? cfg.mailto.trim() : '',
    openalexKey: typeof cfg.openalexKey === 'string' ? cfg.openalexKey.trim() : '',
    keywords: Array.isArray(cfg.keywords) ? cfg.keywords.filter(isKeyword) : [],
  }
}

/**
 * The keyword list a scan should use: what the user saved, else the seed list
 * from the plugin config, else nothing.
 * @param store - loaded store.
 * @param settings - resolved settings (its `keywords` seeds a fresh install).
 * @returns keyword pairs, possibly empty.
 */
export function effectiveKeywords(store, settings = {}) {
  if (store && Array.isArray(store.keywords) && store.keywords.length > 0) return store.keywords
  if (Array.isArray(settings.keywords) && settings.keywords.length > 0) return settings.keywords
  return DEFAULT_KEYWORDS
}

/**
 * Path of the store file for one settings object.
 * @param settings - resolved settings.
 * @returns absolute file path.
 */
export function storePath(settings) {
  return join(settings.stateDir, 'state.json')
}

/**
 * Read the store, tolerating a missing or unreadable file.
 * @param settings - resolved settings.
 * @returns store with `seen`, optional `keywords`, and last-scan fields.
 */
export async function loadStore(settings) {
  const empty = { version: 1, seen: {}, keywords: null, lastScanAt: null, lastNew: 0 }
  try {
    const parsed = JSON.parse(await readFile(storePath(settings), 'utf8'))
    if (!parsed || typeof parsed !== 'object') return empty
    const store = { ...empty }
    if (parsed.seen && typeof parsed.seen === 'object' && !Array.isArray(parsed.seen)) {
      for (const [key, at] of Object.entries(parsed.seen)) {
        if (typeof key === 'string' && typeof at === 'string') store.seen[key] = at
      }
    }
    if (Array.isArray(parsed.keywords)) store.keywords = parsed.keywords.filter(isKeyword)
    if (typeof parsed.lastScanAt === 'string') store.lastScanAt = parsed.lastScanAt
    if (Number.isFinite(parsed.lastNew)) store.lastNew = parsed.lastNew
    return store
  } catch {
    return empty
  }
}

/**
 * Persist the store atomically, pruning entries older than the retention window.
 * @param settings - resolved settings.
 * @param store - store to write.
 * @returns when the file is in place.
 */
export async function saveStore(settings, store) {
  await mkdir(settings.stateDir, { recursive: true })
  const file = storePath(settings)
  const tmp = `${file}.${process.pid}.tmp`
  const cutoff = Date.now() - SEEN_TTL_DAYS * 864e5
  const seen = {}
  for (const [key, at] of Object.entries(store.seen || {})) {
    const t = Date.parse(at)
    if (Number.isFinite(t) && t >= cutoff) seen[key] = at
  }
  const payload = {
    version: 1,
    seen,
    keywords: store.keywords ?? null,
    lastScanAt: store.lastScanAt ?? null,
    lastNew: store.lastNew ?? 0,
  }
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
}

/** Collapse whitespace and decode the handful of XML entities arXiv emits. */
function cleanText(value) {
  if (typeof value !== 'string') return ''
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Cut text at a word boundary near `max` characters. */
function clip(text, max) {
  if (typeof text !== 'string') return ''
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/** Escape a string for use inside a RegExp. */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Rebuild plain text from OpenAlex's inverted abstract index.
 * @param index - `{ word: [positions] }` map.
 * @param max - character budget.
 * @returns abstract excerpt, possibly empty.
 */
export function reconstructAbstract(index, max = 700) {
  if (!index || typeof index !== 'object') return ''
  const slots = []
  for (const [word, positions] of Object.entries(index)) {
    if (!Array.isArray(positions)) continue
    for (const position of positions) {
      if (Number.isInteger(position) && position >= 0 && position < 20000) slots[position] = word
    }
  }
  const text = slots.filter(w => typeof w === 'string').join(' ').replace(/\s+/g, ' ').trim()
  return clip(text, max)
}

/**
 * Combine the caller's cancellation with a per-request timeout.
 * @param signal - caller signal, possibly undefined.
 * @param ms - timeout in milliseconds.
 * @returns a signal that aborts on either.
 */
function timeoutSignal(signal, ms) {
  const timeout = AbortSignal.timeout(ms)
  if (!signal) return timeout
  try {
    return AbortSignal.any([signal, timeout])
  } catch {
    return timeout
  }
}

/** Statuses worth retrying: rate limits and transient gateway failures. */
const RETRY_STATUS = new Set([429, 500, 502, 503, 504])

/** Wait that rejects early when the caller's signal aborts. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }, { once: true })
  })
}

/**
 * Perform one HTTP request, retrying rate limits and transient failures with a
 * short backoff that honours `Retry-After`. A daily scan should not silently
 * lose keywords when one source throttles a burst.
 * @param url - request URL.
 * @param accept - `Accept` header value.
 * @param signal - cancellation/timeout signal.
 * @param attempt - retry index.
 * @returns the successful response.
 */
async function request(url, accept, signal, attempt = 0) {
  const res = await fetch(url, { signal, headers: { accept, 'user-agent': USER_AGENT } })
  if (res.ok) return res
  if (RETRY_STATUS.has(res.status) && attempt < 2 && !signal?.aborted) {
    const retryAfter = Number(res.headers.get('retry-after'))
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1000, 8000)
      : 1200 * (attempt + 1)
    await sleep(delay, signal)
    return request(url, accept, signal, attempt + 1)
  }
  const error = new Error(`HTTP ${res.status} ${res.statusText}`)
  error.status = res.status
  throw error
}

/**
 * Fetch JSON with a bounded timeout and a descriptive failure. The thrown error
 * carries `status` so a caller can distinguish a rejected filter from an
 * outage.
 * @param url - request URL.
 * @param signal - cancellation/timeout signal.
 * @returns parsed JSON.
 */
async function fetchJson(url, signal) {
  const res = await request(url, 'application/json', signal)
  return res.json()
}

/**
 * Fetch XML/Atom text with a bounded timeout.
 * @param url - request URL.
 * @param signal - cancellation/timeout signal.
 * @returns response body.
 */
async function fetchText(url, signal) {
  const res = await request(url, 'application/atom+xml, application/xml;q=0.9, text/xml;q=0.8', signal)
  return res.text()
}

/**
 * Normalize one OpenAlex work into a digest item.
 * @param work - raw OpenAlex work.
 * @param keyword - keyword that produced it.
 * @returns item, or null when the record carries no usable title.
 */
function fromOpenAlex(work, keyword) {
  if (!work || typeof work !== 'object') return null
  const title = cleanText(work.display_name || work.title || '')
  if (!title) return null
  const doi = typeof work.doi === 'string' ? work.doi.replace(/^https?:\/\/doi\.org\//i, '') : ''
  const authors = (Array.isArray(work.authorships) ? work.authorships : [])
    .map(a => (a && a.author && typeof a.author.display_name === 'string' ? a.author.display_name : ''))
    .filter(Boolean)
  return {
    title,
    date: typeof work.publication_date === 'string' ? work.publication_date : '',
    venue: cleanText(work.primary_location?.source?.display_name || work.host_venue?.display_name || ''),
    doi,
    url: doi ? `https://doi.org/${doi}` : (typeof work.id === 'string' ? work.id : ''),
    abstract: reconstructAbstract(work.abstract_inverted_index),
    kind: typeof work.type === 'string' ? work.type : '',
    authors: authors.slice(0, 3).concat(authors.length > 3 ? ['et al.'] : []),
    source: 'openalex',
    keyword: keyword.topic,
  }
}

/** Read the first `<tag>...</tag>` value from an Atom entry body. */
function pickTag(body, tag) {
  const re = new RegExp(`<${escapeRegExp(tag)}[^>]*>([\\s\\S]*?)</${escapeRegExp(tag)}>`)
  const match = body.match(re)
  return match ? match[1] : ''
}

/**
 * Normalize one arXiv Atom entry into a digest item.
 * @param body - one `<entry>` body.
 * @param keywords - the active keyword list, for attribution.
 * @returns item, or null when the entry carries no usable title.
 */
function fromArxiv(body, keywords) {
  const title = cleanText(pickTag(body, 'title'))
  if (!title) return null
  const published = cleanText(pickTag(body, 'published') || pickTag(body, 'updated'))
  const summary = cleanText(pickTag(body, 'summary'))
  const doi = cleanText(pickTag(body, 'arxiv:doi'))
  const id = cleanText(pickTag(body, 'id'))
  const names = [...body.matchAll(/<name>([\s\S]*?)<\/name>/g)].map(m => cleanText(m[1])).filter(Boolean)
  const haystack = `${title} ${summary}`.toLowerCase()
  const hit = keywords.find(k => haystack.includes(k.query.toLowerCase()))
  return {
    title,
    date: published.slice(0, 10),
    venue: 'arXiv',
    doi,
    url: doi ? `https://doi.org/${doi}` : id,
    abstract: clip(summary, 700),
    kind: 'preprint',
    authors: names.slice(0, 3).concat(names.length > 3 ? ['et al.'] : []),
    source: 'arxiv',
    keyword: hit ? hit.topic : '',
  }
}

/**
 * Work types worth reporting. Dropping `dataset`, `other`, and `dissertation`
 * keeps repository deposits and imported metadata records out of the digest.
 */
const OPENALEX_TYPES = 'article|preprint|review'

/** Read a Crossref `date-parts` triple as `YYYY-MM-DD`. */
function datePartsToIso(parts) {
  const first = Array.isArray(parts) ? parts[0] : null
  if (!Array.isArray(first) || !Number.isInteger(first[0])) return ''
  const pad = n => String(n).padStart(2, '0')
  return `${first[0]}-${pad(first[1] ?? 1)}-${pad(first[2] ?? 1)}`
}

/**
 * Normalize one Crossref work into a digest item. Crossref carries JATS markup
 * in `abstract`, which `cleanText` strips.
 * @param work - raw Crossref item.
 * @param keyword - keyword that produced it.
 * @returns item, or null when the record carries no usable title.
 */
function fromCrossref(work, keyword) {
  if (!work || typeof work !== 'object') return null
  const rawTitle = Array.isArray(work.title) ? work.title[0] : work.title
  const title = cleanText(rawTitle || '')
  if (!title) return null
  const authors = (Array.isArray(work.author) ? work.author : [])
    .map(a => [a?.given, a?.family].filter(Boolean).join(' ').trim())
    .filter(Boolean)
  const date = datePartsToIso(work['published-online']?.['date-parts'])
    || datePartsToIso(work['published-print']?.['date-parts'])
    || datePartsToIso(work.issued?.['date-parts'])
  const doi = typeof work.DOI === 'string' ? work.DOI : ''
  const container = Array.isArray(work['container-title']) ? work['container-title'][0] : work['container-title']
  return {
    title,
    date,
    venue: cleanText(container || ''),
    doi,
    url: doi ? `https://doi.org/${doi}` : (typeof work.URL === 'string' ? work.URL : ''),
    abstract: clip(cleanText(typeof work.abstract === 'string' ? work.abstract : ''), 700),
    kind: typeof work.type === 'string' ? work.type : '',
    authors: authors.slice(0, 3).concat(authors.length > 3 ? ['et al.'] : []),
    source: 'crossref',
    keyword: keyword.topic,
  }
}

/** Split a query into lower-case word terms. */
function queryTerms(query) {
  return query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

/** How many of the query terms appear in an item's title/abstract. */
function matchedTermCount(item, terms) {
  const haystack = ` ${item.title} ${item.abstract} `.toLowerCase().replace(/[^a-z0-9]+/g, ' ')
  return terms.filter(term => haystack.includes(term)).length
}

/**
 * Query Crossref for one keyword. This is the primary keyless source because
 * its limits are per client, unlike OpenAlex's shared-IP daily budget.
 *
 * Crossref ranks by relevance inside the date window, but its ranking drifts
 * towards neighbouring topics (`plastic pyrolysis` for `methane pyrolysis`), so
 * an item is kept only when every query word appears in its title/abstract —
 * or when it ranks in the answer's top three and carries at least half of the
 * words, which keeps genuinely on-topic hits whose abstract uses synonyms.
 * @param keyword - keyword pair.
 * @param fromDate - inclusive `YYYY-MM-DD` lower bound.
 * @param toDate - inclusive `YYYY-MM-DD` upper bound.
 * @param settings - resolved settings.
 * @param signal - cancellation signal.
 * @returns normalized items.
 */
async function crossrefSearch(keyword, fromDate, toDate, settings, signal) {
  const url = new URL('https://api.crossref.org/works')
  url.searchParams.set('query.bibliographic', keyword.query)
  url.searchParams.set(
    'filter',
    `from-pub-date:${fromDate},until-pub-date:${toDate},type:journal-article,type:proceedings-article`,
  )
  url.searchParams.set('rows', '30')
  url.searchParams.set('select', 'DOI,title,container-title,published-online,published-print,issued,author,abstract,type,URL')
  if (settings.mailto) url.searchParams.set('mailto', settings.mailto)
  const json = await fetchJson(url, timeoutSignal(signal, 25000))
  const items = (Array.isArray(json?.message?.items) ? json.message.items : [])
    .map(item => fromCrossref(item, keyword))
    .filter(Boolean)
  const terms = queryTerms(keyword.query)
  const half = Math.ceil(terms.length / 2)
  return items.filter((item, index) => {
    const found = matchedTermCount(item, terms)
    return found === terms.length || (index < 3 && found >= half)
  })
}

/**
 * Query OpenAlex for one keyword, restricted to title/abstract matches inside
 * the publication-date window. OpenAlex rejects an unknown filter with 400, so
 * a rejected `title_and_abstract.search` falls back to the default full-text
 * `search` instead of losing the keyword.
 * @param keyword - keyword pair.
 * @param fromDate - inclusive `YYYY-MM-DD` lower bound.
 * @param toDate - inclusive `YYYY-MM-DD` upper bound.
 * @param settings - resolved settings.
 * @param signal - cancellation signal.
 * @returns normalized items.
 */
async function openalexSearch(keyword, fromDate, toDate, settings, signal) {
  const window = `from_publication_date:${fromDate},to_publication_date:${toDate},type:${OPENALEX_TYPES}`
  const build = useTitleAbstract => {
    const url = new URL('https://api.openalex.org/works')
    if (useTitleAbstract) {
      // Unquoted so OpenAlex ANDs the terms instead of requiring one literal
      // phrase, which is what a plain search box means by several words.
      url.searchParams.set('filter', `${window},title_and_abstract.search:${keyword.query}`)
    } else {
      url.searchParams.set('filter', window)
      url.searchParams.set('search', keyword.query)
    }
    url.searchParams.set('sort', 'publication_date:desc')
    url.searchParams.set('per-page', String(settings.perKeyword))
    if (settings.mailto) url.searchParams.set('mailto', settings.mailto)
    if (settings.openalexKey) url.searchParams.set('api_key', settings.openalexKey)
    return url
  }
  let json
  try {
    json = await fetchJson(build(true), timeoutSignal(signal, 25000))
  } catch (error) {
    if (error?.status !== 400) throw error
    json = await fetchJson(build(false), timeoutSignal(signal, 25000))
  }
  const results = Array.isArray(json?.results) ? json.results : []
  return results.map(work => fromOpenAlex(work, keyword)).filter(Boolean)
}

/**
 * Query arXiv once with every keyword OR-ed together, which keeps the request
 * count at one and stays inside arXiv's politeness guidance.
 * @param keywords - active keyword list.
 * @param settings - resolved settings.
 * @param signal - cancellation signal.
 * @returns normalized items.
 */
async function arxivSearch(keywords, settings, signal) {
  const phrase = keywords
    .map(k => `all:"${k.query.replace(/"/g, '').trim()}"`)
    .join(' OR ')
  const max = Math.min(60, Math.max(15, keywords.length * 3))
  const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(phrase)}`
    + `&start=0&max_results=${max}&sortBy=submittedDate&sortOrder=descending`
  const xml = await fetchText(url, timeoutSignal(signal, 30000))
  const entries = xml.split('<entry>').slice(1)
  return entries
    .map(entry => fromArxiv(entry.split('</entry>')[0], keywords))
    .filter(Boolean)
}

/** Normalized title, the identity that survives publisher-specific DOIs. */
function titleKey(title) {
  return `title:${title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`
}

/**
 * Every key an item can be recognized by. A paper may carry several DOIs — an
 * Angewandte article has both a German and an international-edition DOI — so the
 * title is the merge key and the DOI plus arXiv id are only additional
 * identities for the delivered check.
 * @param item - normalized item.
 * @returns candidate keys, most stable first.
 */
export function itemKeys(item) {
  const keys = [titleKey(item.title)]
  if (item.doi) keys.push(`doi:${item.doi.toLowerCase()}`)
  if (item.source === 'arxiv' && item.url) {
    const match = item.url.match(/abs\/([^/?#]+)$/)
    if (match) keys.push(`arxiv:${match[1]}`)
  }
  return keys
}

/** `YYYY-MM-DD` for `days` ago. */
function isoDaysAgo(days) {
  return new Date(Date.now() - days * 864e5).toISOString().slice(0, 10)
}

/** `YYYY-MM-DD` for today; the upper bound keeps future-dated deposits out. */
function isoToday() {
  return new Date().toISOString().slice(0, 10)
}

/** Run async jobs with bounded concurrency, preserving input order. */
async function mapLimit(items, limit, job) {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      out[index] = await job(items[index], index)
    }
  }
  const size = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: size }, worker))
  return out
}

/**
 * Run one scan: fetch from every enabled source, dedupe across sources and
 * against the delivered history, mark the returned items delivered, persist.
 * @param settings - resolved settings.
 * @param keywords - active keyword list.
 * @param store - loaded store, mutated in place.
 * @param signal - optional cancellation signal.
 * @returns scan outcome for formatting.
 */
export async function scan(settings, keywords, store, signal) {
  const fromDate = isoDaysAgo(settings.days)
  const toDate = isoToday()
  const errors = []
  const collected = []
  const bySource = {}
  const byKeyword = {}

  if (settings.sources.includes('crossref')) {
    const batches = await mapLimit(keywords, 3, async keyword => {
      try {
        return await crossrefSearch(keyword, fromDate, toDate, settings, signal)
      } catch (error) {
        errors.push(`Crossref「${keyword.topic}」: ${error?.message || error}`)
        return []
      }
    })
    const items = batches.flat()
    bySource.crossref = items.length
    collected.push(...items)
  }

  if (settings.sources.includes('openalex')) {
    const batches = await mapLimit(keywords, 4, async keyword => {
      try {
        const items = await openalexSearch(keyword, fromDate, toDate, settings, signal)
        byKeyword[keyword.topic] = items.length
        return items
      } catch (error) {
        errors.push(`OpenAlex「${keyword.topic}」: ${error?.message || error}`)
        return []
      }
    })
    const items = batches.flat()
    bySource.openalex = items.length
    collected.push(...items)
  }

  if (settings.sources.includes('arxiv')) {
    try {
      const items = await arxivSearch(keywords, settings, signal)
      bySource.arxiv = items.length
      collected.push(...items)
    } catch (error) {
      errors.push(`arXiv: ${error?.message || error}`)
      bySource.arxiv = 0
    }
  }

  const byKey = new Map()
  for (const item of collected) {
    if (!item.date || item.date < fromDate || item.date > toDate) continue
    const key = titleKey(item.title)
    const existing = byKey.get(key)
    if (existing) {
      // Keep the richer record when two sources describe the same paper.
      if (!existing.keyword && item.keyword) existing.keyword = item.keyword
      if (!existing.doi && item.doi) existing.doi = item.doi
      if (!existing.abstract && item.abstract) existing.abstract = item.abstract
      if (existing.authors.length <= 1 && item.authors.length > 1) existing.authors = item.authors
      if (!existing.venue && item.venue) existing.venue = item.venue
      continue
    }
    byKey.set(key, { ...item })
  }

  const all = [...byKey.values()].sort((a, b) => (b.date || '').localeCompare(a.date || ''))
  const fresh = all.filter(item => !itemKeys(item).some(key => store.seen[key]))
  const picked = fresh.slice(0, settings.limit)
  const at = new Date().toISOString()
  for (const item of picked) store.seen[titleKey(item.title)] = at
  store.lastScanAt = at
  store.lastNew = picked.length

  return {
    fromDate,
    scannedAt: at,
    matched: all.length,
    fresh: fresh.length,
    picked,
    withheld: fresh.length - picked.length,
    errors,
    keywords: keywords.length,
    bySource,
    byKeyword,
  }
}

/** Format an ISO instant in the host's local time as `YYYY-MM-DD HH:mm`. */
function stamp(iso) {
  if (!iso) return 'never'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'unknown'
  const pad = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Clamp a number into range, falling back to the configured value. */
export function clampInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/**
 * Run a scan against the active keywords and persist the delivered marks. The
 * plugin tool and the CLI share this so both behave identically.
 * @param settings - resolved settings.
 * @param store - loaded store, mutated and saved.
 * @param overrides - per-call `days`, `limit`, and cancellation signal.
 * @returns null when no keyword is configured, else the run settings and result.
 */
export async function runScan(settings, store, { days, limit, signal } = {}) {
  const keywords = effectiveKeywords(store, settings)
  if (keywords.length === 0) return null
  const run = {
    ...settings,
    days: clampInt(days, settings.days, 1, 90),
    limit: clampInt(limit, settings.limit, 1, 60),
  }
  const result = await scan(run, keywords, store, signal)
  await saveStore(settings, store)
  return { run, result }
}

/**
 * Render a scan outcome as the digest. Field labels stay in English so one
 * build serves every locale; topics, titles, and abstracts keep whatever
 * language the user and the source use.
 * @param settings - resolved settings.
 * @param result - value returned by {@link scan}.
 * @returns plain text digest.
 */
export function formatDigest(settings, result) {
  const lines = []
  lines.push(`lit-radar · last ${settings.days} days (from ${result.fromDate}) · ${stamp(result.scannedAt)}`)
  lines.push('')

  if (result.picked.length === 0) {
    if (result.errors.length >= result.keywords && result.matched === 0) {
      lines.push('Nothing fetched: every source failed, see the errors below.')
    } else if (result.matched === 0) {
      lines.push('No matches for these keywords in this window.')
    } else {
      lines.push(`${result.matched} matched, all already delivered — nothing new.`)
    }
  } else {
    lines.push(`${result.matched} matched · ${result.fresh} new · returning ${result.picked.length}`)
    lines.push('')
    result.picked.forEach((item, index) => {
      lines.push(`[${index + 1}] ${item.title}`)
      const meta = [item.venue, item.date, item.kind].filter(Boolean).join(' · ')
      if (meta) lines.push(`    venue: ${meta}`)
      if (item.keyword) lines.push(`    keyword: ${item.keyword}`)
      if (item.authors.length > 0) lines.push(`    authors: ${item.authors.join(', ')}`)
      if (item.doi) lines.push(`    doi: ${item.doi}`)
      else if (item.url) lines.push(`    url: ${item.url}`)
      if (item.abstract) lines.push(`    abstract: ${item.abstract}`)
      lines.push('')
    })
    if (result.withheld > 0) {
      lines.push(`${result.withheld} more new items beyond limit=${settings.limit} are left for the next scan.`)
    }
    lines.push(`Marked these ${result.picked.length} items as delivered; the next scan will not repeat them.`)
  }

  if (result.errors.length > 0) {
    lines.push('')
    lines.push(`Sources that failed (${result.errors.length}):`)
    for (const error of result.errors.slice(0, 6)) lines.push(`  - ${error}`)
    if (result.errors.length > 6) lines.push(`  …and ${result.errors.length - 6} more of the same kind`)
  }

  return lines.join('\n')
}

/**
 * Render the current configuration and counters.
 * @param settings - resolved settings.
 * @param store - loaded store.
 * @returns plain text status.
 */
export function formatStatus(settings, store) {
  const keywords = effectiveKeywords(store, settings)
  const lines = [
    'lit-radar status',
    `${keywords.length} keywords · sources ${settings.sources.join(' + ')} · window ${settings.days} days · cap ${settings.limit} per scan`,
    `${Object.keys(store.seen).length} delivered entries · last scan ${stamp(store.lastScanAt)} (${store.lastNew} new)`,
    `state file: ${storePath(settings)}`,
  ]
  if (keywords.length === 0) {
    lines.push('', 'No keywords configured yet — set them to start the radar.')
  } else {
    lines.push('', ...keywords.map((k, i) => `${i + 1}. ${k.topic} — ${k.query}`))
  }
  return lines.join('\n')
}
