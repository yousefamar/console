// ============================================================================
// Bookmark Manager — reads/writes Obsidian vault bookmark .md files
//
// Each bookmark is a .md file with YAML frontmatter (title, url, added,
// archive, description, tags) and optional body content.
// ============================================================================

import { readdir, readFile, writeFile, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

export interface BookmarkFrontmatter {
  title: string
  url: string
  added: string
  archive: string | null
  description: string
  tags: string[]
}

export interface Bookmark extends BookmarkFrontmatter {
  filename: string
}

export interface BookmarkWithBody extends Bookmark {
  body: string
}

export interface TagTreeNode {
  name: string
  fullPath: string
  count: number
  children: TagTreeNode[]
}

// --------------------------------------------------------------------------
// Parsing
// --------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/

export function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(FRONTMATTER_RE)
  if (!match) {
    return { frontmatter: {}, body: content }
  }
  const [, yamlText, body] = match
  try {
    const frontmatter = parseYaml(yamlText!) as Record<string, unknown>
    return { frontmatter: frontmatter ?? {}, body: (body ?? '').trim() }
  } catch {
    return { frontmatter: {}, body: content }
  }
}

export function toBookmark(filename: string, fm: Record<string, unknown>): Bookmark {
  return {
    filename,
    title: String(fm.title ?? filename.replace(/\.md$/, '')),
    url: String(fm.url ?? ''),
    added: String(fm.added ?? ''),
    archive: fm.archive ? String(fm.archive) : null,
    description: String(fm.description ?? ''),
    tags: Array.isArray(fm.tags) ? fm.tags.map(String) : [],
  }
}

// --------------------------------------------------------------------------
// Tag tree builder
// --------------------------------------------------------------------------

export function buildTagTree(bookmarks: Bookmark[]): TagTreeNode[] {
  // Count each tag path and all parent paths
  const tagCounts = new Map<string, number>()
  for (const bm of bookmarks) {
    for (const tag of bm.tags) {
      const parts = tag.split('/')
      for (let i = 0; i < parts.length; i++) {
        const path = parts.slice(0, i + 1).join('/')
        tagCounts.set(path, (tagCounts.get(path) ?? 0) + 1)
      }
    }
  }

  // Build nested tree
  interface TreeBuild { count: number; fullPath: string; children: Map<string, TreeBuild> }
  const root = new Map<string, TreeBuild>()

  for (const [tag, count] of [...tagCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const parts = tag.split('/')
    let current = root
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!
      const path = parts.slice(0, i + 1).join('/')
      if (!current.has(part)) {
        current.set(part, { count: tagCounts.get(path) ?? 0, fullPath: path, children: new Map() })
      }
      if (i < parts.length - 1) {
        current = current.get(part)!.children
      }
    }
  }

  function toNodes(map: Map<string, TreeBuild>): TagTreeNode[] {
    return [...map.entries()].map(([name, data]) => ({
      name,
      fullPath: data.fullPath,
      count: data.count,
      children: toNodes(data.children),
    }))
  }

  return toNodes(root)
}

// --------------------------------------------------------------------------
// Metadata fetching
// --------------------------------------------------------------------------

export interface PageMetadata {
  title: string
  description: string
  url: string // canonical or original
}

/** Fetch a URL and extract title + description via OG tags / Readability */
export async function fetchPageMetadata(url: string): Promise<PageMetadata> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Console-Bookmarks/1.0)' },
    signal: AbortSignal.timeout(15000),
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  const html = await res.text()
  const { document } = parseHTML(html)

  // Try OG tags first, then meta tags, then Readability
  const og = (prop: string) =>
    document.querySelector(`meta[property="og:${prop}"]`)?.getAttribute('content')
      ?? document.querySelector(`meta[name="og:${prop}"]`)?.getAttribute('content')

  const metaDesc =
    document.querySelector('meta[name="description"]')?.getAttribute('content')
    ?? document.querySelector('meta[property="description"]')?.getAttribute('content')

  const canonical =
    document.querySelector('link[rel="canonical"]')?.getAttribute('href')

  let title = og('title') ?? document.querySelector('title')?.textContent ?? ''
  let description = og('description') ?? metaDesc ?? ''

  // Fallback to Readability for title/description if missing
  if (!title || !description) {
    try {
      const reader = new Readability(document as unknown as Document)
      const article = reader.parse()
      if (article) {
        if (!title) title = article.title ?? ''
        if (!description) description = article.excerpt ?? ''
      }
    } catch {
      // Readability can fail on some pages
    }
  }

  return {
    title: title.trim(),
    description: description.trim(),
    url: canonical && canonical.startsWith('http') ? canonical : url,
  }
}

/** Turn a title into a safe filename */
function toFilename(title: string, existingFilenames: Set<string>): string {
  let name = title
    .toLowerCase()
    .replace(/[^\w\s-]/g, '') // strip non-word chars
    .replace(/\s+/g, '-')     // spaces to hyphens
    .replace(/-+/g, '-')      // collapse hyphens
    .replace(/^-|-$/g, '')    // trim hyphens
    .slice(0, 80)             // reasonable length

  if (!name) name = 'bookmark'

  let filename = `${name}.md`
  let counter = 2
  while (existingFilenames.has(filename)) {
    filename = `${name}-${counter}.md`
    counter++
  }
  return filename
}

// --------------------------------------------------------------------------
// BookmarkStore — in-memory cache with file I/O
// --------------------------------------------------------------------------

export class BookmarkStore {
  private cache = new Map<string, BookmarkWithBody>()
  private loaded = false
  readonly vaultPath: string

  constructor(vaultPath?: string) {
    this.vaultPath = resolve(vaultPath ?? join(homedir(), 'sync', 'brain', 'root', 'bookmarks'))
  }

  /** Load all bookmark .md files from the vault directory */
  async loadAll(): Promise<void> {
    this.cache.clear()
    const entries = await readdir(this.vaultPath)
    const mdFiles = entries.filter((f) => f.endsWith('.md'))

    await Promise.all(
      mdFiles.map(async (filename) => {
        try {
          const content = await readFile(join(this.vaultPath, filename), 'utf-8')
          const { frontmatter, body } = parseFrontmatter(content)
          if (frontmatter.url || frontmatter.title) {
            const bm = toBookmark(filename, frontmatter)
            this.cache.set(filename, { ...bm, body })
          }
        } catch {
          // Skip unreadable files
        }
      }),
    )
    this.loaded = true
  }

  /** Ensure cache is populated */
  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.loadAll()
  }

  /** Get all bookmarks (frontmatter only, no body) */
  async list(): Promise<Bookmark[]> {
    await this.ensureLoaded()
    return [...this.cache.values()].map(({ body: _, ...rest }) => rest)
  }

  /** Get a single bookmark with body */
  async get(filename: string): Promise<BookmarkWithBody | null> {
    await this.ensureLoaded()
    return this.cache.get(filename) ?? null
  }

  /** Update frontmatter fields (preserves body and unspecified fields) */
  async update(filename: string, updates: Partial<BookmarkFrontmatter>): Promise<BookmarkWithBody | null> {
    await this.ensureLoaded()
    const filePath = join(this.vaultPath, filename)

    // Read current file content to preserve exact format
    let content: string
    try {
      content = await readFile(filePath, 'utf-8')
    } catch {
      return null
    }

    const { frontmatter, body } = parseFrontmatter(content)

    // Merge updates into frontmatter
    for (const [key, value] of Object.entries(updates)) {
      frontmatter[key] = value
    }

    // Rebuild file
    const yamlContent = stringifyYaml(frontmatter)
    const newContent = `---\n${yamlContent}---\n${body}`
    await writeFile(filePath, newContent, 'utf-8')

    // Update cache
    const bm = toBookmark(filename, frontmatter)
    const updated = { ...bm, body }
    this.cache.set(filename, updated)
    return updated
  }

  /** Delete a bookmark file */
  async delete(filename: string): Promise<boolean> {
    await this.ensureLoaded()
    const filePath = join(this.vaultPath, filename)
    try {
      await unlink(filePath)
      this.cache.delete(filename)
      return true
    } catch {
      return false
    }
  }

  /** Get the tag tree */
  async getTagTree(): Promise<TagTreeNode[]> {
    await this.ensureLoaded()
    return buildTagTree([...this.cache.values()])
  }

  /** Create a new bookmark from a URL — fetches metadata automatically */
  async create(
    url: string,
    overrides?: Partial<BookmarkFrontmatter>,
  ): Promise<BookmarkWithBody> {
    await this.ensureLoaded()

    // Check for duplicate URL
    for (const bm of this.cache.values()) {
      if (bm.url === url) {
        return bm
      }
    }

    // Fetch metadata
    let meta: PageMetadata
    try {
      meta = await fetchPageMetadata(url)
    } catch {
      meta = { title: '', description: '', url }
    }

    const title = overrides?.title || meta.title || new URL(url).hostname
    const description = overrides?.description || meta.description
    const tags = overrides?.tags ?? ['status/active']
    const added = new Date().toISOString().split('T')[0]!

    const filename = toFilename(title, new Set(this.cache.keys()))

    const frontmatter: BookmarkFrontmatter = {
      title,
      url: meta.url || url,
      added,
      archive: null,
      description,
      tags,
    }

    const yamlContent = stringifyYaml(frontmatter as unknown as Record<string, unknown>)
    const fileContent = `---\n${yamlContent}---\n`
    await writeFile(join(this.vaultPath, filename), fileContent, 'utf-8')

    const bm: BookmarkWithBody = { ...frontmatter, filename, body: '' }
    this.cache.set(filename, bm)
    return bm
  }

  /** Suggest tags for a bookmark using Claude API */
  async suggestTags(
    title: string,
    description: string,
    url: string,
  ): Promise<string[]> {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) return []

    // Gather existing tags for context
    await this.ensureLoaded()
    const allTags = new Set<string>()
    for (const bm of this.cache.values()) {
      for (const tag of bm.tags) {
        if (tag !== 'status/active') allTags.add(tag)
      }
    }
    const tagList = [...allTags].sort()

    const prompt = `You are a bookmark categorizer. Given a webpage's title, description, and URL, suggest 2-5 tags from the existing tag list below. Only suggest tags that genuinely apply. If none fit well, suggest the closest parent category.

Existing tags (hierarchical, "/" separated):
${tagList.join('\n')}

Webpage:
Title: ${title}
Description: ${description}
URL: ${url}

Respond with ONLY a JSON array of tag strings, e.g. ["dev/tools", "ai-ml/tools"]. Always include "status/active".`

    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 256,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(15000),
      })
      if (!res.ok) return []
      const data = await res.json() as { content: Array<{ text: string }> }
      const text = data.content[0]?.text ?? ''
      // Extract JSON array from response
      const match = text.match(/\[[\s\S]*\]/)
      if (!match) return []
      const tags = JSON.parse(match[0]) as string[]
      // Ensure status/active is included
      if (!tags.includes('status/active')) tags.push('status/active')
      return tags.filter((t) => typeof t === 'string')
    } catch {
      return []
    }
  }

  /** Force reload from disk */
  async reload(): Promise<void> {
    this.loaded = false
    await this.loadAll()
  }

  /** Get count */
  get size(): number {
    return this.cache.size
  }
}
