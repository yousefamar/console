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
