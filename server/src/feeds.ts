// ============================================================================
// Feed Store — RSS/Atom feed subscription management and fetching
// ============================================================================

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import RssParser from 'rss-parser'
import { XMLParser, XMLBuilder } from 'fast-xml-parser'
import { createHash } from 'node:crypto'
import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

export interface FeedSubscription {
  id: string
  title: string
  xmlUrl: string
  siteUrl?: string
  folder: string | null
  imageUrl?: string
  fullText?: boolean
  maxItems?: number
  addedAt: string
}

export interface FeedItem {
  id: string
  feedId: string
  title: string
  link: string
  content: string
  contentSnippet: string
  author?: string
  publishedAt: string
  imageUrl?: string
}

interface FeedsConfig {
  feeds: FeedSubscription[]
}

interface CachedFeed {
  items: FeedItem[]
  fetchedAt: number
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function feedId(xmlUrl: string): string {
  return createHash('sha256').update(xmlUrl).digest('hex').slice(0, 12)
}

function snippet(html: string, max = 200): string {
  const text = html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
  return text.length > max ? text.slice(0, max - 1) + '\u2026' : text
}

/**
 * Fetch a URL and extract the article content using Mozilla Readability.
 * Returns HTML content or null on failure.
 */
async function fetchFullText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Console-FeedReader/1.0' },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return null
    const html = await res.text()
    const { document } = parseHTML(html)
    const reader = new Readability(document)
    const article = reader.parse()
    return article?.content || null
  } catch {
    return null
  }
}

function extractAttr(obj: unknown, attr: string): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined
  const rec = obj as Record<string, unknown>
  // rss-parser puts XML attributes in $ object: { $: { url: "..." } }
  const dollar = rec.$ as Record<string, string> | undefined
  if (dollar?.[attr]) return dollar[attr]
  // Or it might be a direct property
  if (typeof rec[attr] === 'string') return rec[attr] as string
  return undefined
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
}

function itemId(guid: string | undefined, link: string | undefined, feedIdStr: string): string {
  const key = guid || link || `${feedIdStr}-${Date.now()}-${Math.random()}`
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

// --------------------------------------------------------------------------
// FeedStore
// --------------------------------------------------------------------------

export class FeedStore {
  private configPath: string
  private readPath: string
  private config: FeedsConfig | null = null
  private readSet: Set<string> | null = null
  private cache = new Map<string, CachedFeed>()
  private parser = new RssParser({
    timeout: 15000,
    headers: { 'User-Agent': 'Console-FeedReader/1.0' },
    customFields: {
      item: [
        ['media:group', 'mediaGroup'],
        ['media:thumbnail', 'mediaThumbnail', { keepArray: false }],
        ['yt:videoId', 'ytVideoId'],
      ],
    },
  })
  private static CACHE_TTL = 5 * 60 * 1000 // 5 minutes

  constructor(configPath: string, readPath: string) {
    this.configPath = configPath
    this.readPath = readPath
  }

  // --- Config I/O ---

  private loadConfig(): FeedsConfig {
    if (this.config) return this.config
    if (existsSync(this.configPath)) {
      const data = readFileSync(this.configPath, 'utf-8')
      this.config = JSON.parse(data) as FeedsConfig
    } else {
      this.config = { feeds: [] }
    }
    return this.config
  }

  private saveConfig() {
    const dir = dirname(this.configPath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(this.configPath, JSON.stringify(this.config, null, 2))
  }

  private loadRead(): Set<string> {
    if (this.readSet) return this.readSet
    if (existsSync(this.readPath)) {
      const data = JSON.parse(readFileSync(this.readPath, 'utf-8'))
      this.readSet = new Set(data.read || [])
    } else {
      this.readSet = new Set()
    }
    return this.readSet
  }

  private saveRead() {
    const dir = dirname(this.readPath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const arr = Array.from(this.readSet || [])
    writeFileSync(this.readPath, JSON.stringify({ read: arr }))
  }

  // --- CRUD ---

  list(): FeedSubscription[] {
    return this.loadConfig().feeds
  }

  async add(xmlUrl: string, title?: string, folder?: string, fullText?: boolean): Promise<FeedSubscription> {
    const config = this.loadConfig()

    // Deduplicate
    const existing = config.feeds.find((f) => f.xmlUrl === xmlUrl)
    if (existing) return existing

    // Auto-discover title if not provided
    let discoveredTitle = title || xmlUrl
    let siteUrl: string | undefined
    let imageUrl: string | undefined
    try {
      const feed = await this.parser.parseURL(xmlUrl)
      discoveredTitle = title || feed.title || xmlUrl
      siteUrl = feed.link || undefined
      imageUrl = feed.image?.url || undefined
    } catch {
      // Use provided or URL as fallback
    }

    const sub: FeedSubscription = {
      id: feedId(xmlUrl),
      title: discoveredTitle,
      xmlUrl,
      siteUrl,
      folder: folder || null,
      imageUrl,
      fullText: fullText || false,
      addedAt: new Date().toISOString(),
    }

    config.feeds.push(sub)
    this.saveConfig()
    return sub
  }

  delete(id: string): boolean {
    const config = this.loadConfig()
    const idx = config.feeds.findIndex((f) => f.id === id)
    if (idx === -1) return false
    config.feeds.splice(idx, 1)
    this.saveConfig()
    this.cache.delete(id)

    // We no longer prune the read set on fetch (that wiped read history when a
    // feed transiently failed). The deleted feed's read ids simply linger —
    // harmless (ids are tiny) and self-corrects if the feed is ever re-added.
    return true
  }

  update(id: string, updates: { title?: string; folder?: string; xmlUrl?: string; fullText?: boolean; maxItems?: number | null }): FeedSubscription | null {
    const config = this.loadConfig()
    const feed = config.feeds.find((f) => f.id === id)
    if (!feed) return null
    if (updates.title !== undefined) feed.title = updates.title
    if (updates.folder !== undefined) feed.folder = updates.folder
    if (updates.xmlUrl !== undefined) {
      feed.xmlUrl = updates.xmlUrl
      this.cache.delete(id) // invalidate cached items for old URL
    }
    if (updates.fullText !== undefined) {
      feed.fullText = updates.fullText
      this.cache.delete(id) // re-fetch with new mode
    }
    if (updates.maxItems !== undefined) {
      if (updates.maxItems === null) delete feed.maxItems
      else feed.maxItems = updates.maxItems
    }
    this.saveConfig()
    return feed
  }

  // --- Fetch items ---

  async fetchFeed(id: string): Promise<FeedItem[]> {
    const config = this.loadConfig()
    const sub = config.feeds.find((f) => f.id === id)
    if (!sub) return []

    // Check cache
    const cached = this.cache.get(id)
    if (cached && Date.now() - cached.fetchedAt < FeedStore.CACHE_TTL) {
      return cached.items
    }

    try {
      const feed = await this.parser.parseURL(sub.xmlUrl)
      const items: FeedItem[] = (feed.items || []).map((item) => {
        const raw = item as unknown as Record<string, unknown>

        // Extract YouTube-specific fields from media:group
        const mediaGroup = raw.mediaGroup as Record<string, unknown> | undefined
        const ytVideoId = raw.ytVideoId as string | undefined
        const mediaThumbnail = extractAttr(mediaGroup?.['media:thumbnail'], 'url')
          ?? extractAttr(raw.mediaThumbnail, 'url')
        const mediaDescription = Array.isArray(mediaGroup?.['media:description'])
          ? (mediaGroup!['media:description'] as string[])[0]
          : mediaGroup?.['media:description'] as string | undefined

        // Build content — YouTube gets description, others use content:encoded/content/summary
        let content = (raw['content:encoded'] || item.content || item.summary || '') as string
        let contentImg = ''

        if (ytVideoId && !content) {
          const desc = mediaDescription ? `<p>${escapeHtml(String(mediaDescription))}</p>` : ''
          content = desc
          contentImg = mediaThumbnail || `https://i.ytimg.com/vi/${ytVideoId}/hqdefault.jpg`
        }

        const thumbUrl = contentImg
          || (item.enclosure?.url && item.enclosure?.type?.startsWith('image/') ? item.enclosure.url : undefined)
          || mediaThumbnail
          || undefined

        return {
          id: itemId(item.guid, item.link, id),
          feedId: id,
          title: item.title || '(untitled)',
          link: item.link || '',
          content,
          contentSnippet: snippet(content || item.contentSnippet || ''),
          author: item.creator || (raw.author as string | undefined) || undefined,
          publishedAt: item.isoDate || item.pubDate || new Date().toISOString(),
          imageUrl: thumbUrl,
        }
      })

      // Full-text: fetch article content from each item's URL via Readability
      if (sub.fullText) {
        const needsFullText = items.filter((item) =>
          item.link && (!item.content || item.content.length < 200)
        )
        if (needsFullText.length > 0) {
          const BATCH = 5
          for (let i = 0; i < needsFullText.length; i += BATCH) {
            const batch = needsFullText.slice(i, i + BATCH)
            await Promise.allSettled(
              batch.map(async (item) => {
                const fullContent = await fetchFullText(item.link)
                if (fullContent && fullContent.length > item.content.length) {
                  item.content = fullContent
                  item.contentSnippet = snippet(fullContent)
                }
              })
            )
          }
        }
      }

      this.cache.set(id, { items, fetchedAt: Date.now() })
      return items
    } catch (err) {
      console.error(`Failed to fetch feed ${sub.title} (${sub.xmlUrl}): ${(err as Error).message}`)
      // Return cached if available, even if stale
      return cached?.items || []
    }
  }

  async fetchAllSince(since?: string): Promise<{ items: FeedItem[]; readIds: string[]; currentItemIds: string[] }> {
    const config = this.loadConfig()
    const sinceDate = since ? new Date(since).getTime() : 0
    const read = this.loadRead()

    // Fetch all feeds in parallel with concurrency limit
    const CONCURRENCY = 10
    const allItems: FeedItem[] = []
    const feeds = [...config.feeds]

    for (let i = 0; i < feeds.length; i += CONCURRENCY) {
      const batch = feeds.slice(i, i + CONCURRENCY)
      const results = await Promise.allSettled(
        batch.map((sub) => this.fetchFeed(sub.id))
      )
      for (const result of results) {
        if (result.status === 'fulfilled') {
          allItems.push(...result.value)
        }
      }
    }

    // Filter to items since the given date
    const filtered = sinceDate > 0
      ? allItems.filter((item) => new Date(item.publishedAt).getTime() > sinceDate)
      : allItems

    const allItemIds = new Set(allItems.map((i) => i.id))

    // NOTE: we deliberately do NOT prune the read set against the current items.
    // A feed transiently failing to fetch (network/timeout/rate-limit — common
    // with 100+ feeds) makes its items briefly vanish from `allItems`; pruning
    // here would then permanently drop those items' read markers, so they'd
    // resurface as unread on the next successful fetch. Read ids are tiny, so an
    // unbounded read set is fine. Read entries are cleaned only when a feed is
    // explicitly deleted (see `delete()`), not on every fetch.

    return { items: filtered, readIds: Array.from(read), currentItemIds: Array.from(allItemIds) }
  }

  // --- Read state ---

  getRead(): string[] {
    return Array.from(this.loadRead())
  }

  syncRead(add?: string[], remove?: string[]): string[] {
    const read = this.loadRead()
    if (add) for (const id of add) read.add(id)
    if (remove) for (const id of remove) read.delete(id)
    this.saveRead()
    return Array.from(read)
  }

  // --- OPML ---

  importOpml(opmlXml: string): FeedSubscription[] {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
    })
    const parsed = parser.parse(opmlXml)

    const config = this.loadConfig()
    const existingUrls = new Set(config.feeds.map((f) => f.xmlUrl))
    const added: FeedSubscription[] = []

    function processOutlines(outlines: unknown, folder: string | null) {
      const items = Array.isArray(outlines) ? outlines : [outlines]
      for (const outline of items) {
        if (!outline) continue
        const xmlUrl = outline['@_xmlUrl']
        if (xmlUrl && !existingUrls.has(xmlUrl)) {
          const sub: FeedSubscription = {
            id: feedId(xmlUrl),
            title: outline['@_title'] || outline['@_text'] || xmlUrl,
            xmlUrl,
            siteUrl: outline['@_htmlUrl'] || undefined,
            folder,
            imageUrl: outline['@_feeder:imageUrl'] || undefined,
            addedAt: new Date().toISOString(),
          }
          config.feeds.push(sub)
          existingUrls.add(xmlUrl)
          added.push(sub)
        } else if (!xmlUrl && outline.outline) {
          // This is a folder
          const folderName = outline['@_title'] || outline['@_text'] || 'Untitled'
          processOutlines(outline.outline, folderName)
        }
      }
    }

    const body = parsed?.opml?.body
    if (body?.outline) {
      processOutlines(body.outline, null)
    }

    this.saveConfig()
    return added
  }

  exportOpml(): string {
    const config = this.loadConfig()
    const folders = new Map<string, FeedSubscription[]>()
    const topLevel: FeedSubscription[] = []

    for (const feed of config.feeds) {
      if (feed.folder) {
        const arr = folders.get(feed.folder) || []
        arr.push(feed)
        folders.set(feed.folder, arr)
      } else {
        topLevel.push(feed)
      }
    }

    const builder = new XMLBuilder({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      format: true,
    })

    const outlines: unknown[] = [
      ...topLevel.map((f) => ({
        '@_title': f.title,
        '@_text': f.title,
        '@_type': 'rss',
        '@_xmlUrl': f.xmlUrl,
        ...(f.siteUrl ? { '@_htmlUrl': f.siteUrl } : {}),
      })),
    ]

    for (const [name, feeds] of folders) {
      outlines.push({
        '@_title': name,
        '@_text': name,
        outline: feeds.map((f) => ({
          '@_title': f.title,
          '@_text': f.title,
          '@_type': 'rss',
          '@_xmlUrl': f.xmlUrl,
          ...(f.siteUrl ? { '@_htmlUrl': f.siteUrl } : {}),
        })),
      })
    }

    const opml = {
      '?xml': { '@_version': '1.0', '@_encoding': 'UTF-8' },
      opml: {
        '@_version': '1.1',
        head: { title: 'Console Feed Subscriptions' },
        body: { outline: outlines },
      },
    }

    return builder.build(opml)
  }
}
