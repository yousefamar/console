// Area registry — validates the tags used to mark vault posts/pages as
// belonging to a PARA "area" (life, ai, dev, writing, …). Areas are tags,
// not folders (Yousef writes under `tags: [life]` regardless of where the
// file lives), but an unregistered tag is almost always a typo or an
// undecided new area, so every write path checks against this registry
// rather than trusting free-form tags.
//
// Registry lives in the vault itself (`_data/areas.json`) so it round-trips
// with Syncthing like everything else — no hub-only config to go stale.

import { join } from 'node:path'
import type { NoteStore } from './notes.js'
import { parseFrontmatter } from './blog.js'

const REGISTRY_PATH = '_data/areas.json'

export interface Area {
  slug: string
  title: string
}

export interface AreaRegistry {
  areas: Area[]
  /** Tags that are valid but denote something other than an area (e.g. `projects`, the pointer to project-tagged posts). */
  reserved: string[]
}

const EMPTY_REGISTRY: AreaRegistry = { areas: [], reserved: [] }

export async function loadAreaRegistry(store: NoteStore): Promise<AreaRegistry> {
  try {
    const raw = await store.read(REGISTRY_PATH)
    const parsed = JSON.parse(raw) as Partial<AreaRegistry>
    return {
      areas: Array.isArray(parsed.areas) ? parsed.areas.filter((a) => a && typeof a.slug === 'string') : [],
      reserved: Array.isArray(parsed.reserved) ? parsed.reserved.filter((r) => typeof r === 'string') : [],
    }
  } catch {
    return EMPTY_REGISTRY
  }
}

/** Pure: every valid tag value (areas + reserved), for autocomplete/validation. */
export function validTags(registry: AreaRegistry): Set<string> {
  return new Set([...registry.areas.map((a) => a.slug), ...registry.reserved])
}

export function isValidTag(tag: string, registry: AreaRegistry): boolean {
  return validTags(registry).has(tag)
}

export interface TagLintIssue {
  path: string
  tag: string
}

/** Pure: given (path, tags) pairs, report every tag not in the registry. */
export function lintTagPairs(files: Array<{ path: string; tags: string[] }>, registry: AreaRegistry): TagLintIssue[] {
  const valid = validTags(registry)
  const issues: TagLintIssue[] = []
  for (const f of files) {
    for (const tag of f.tags) {
      if (!valid.has(tag)) issues.push({ path: f.path, tag })
    }
  }
  return issues
}

/** Scans every vault post's `tags:` frontmatter for values outside the registry. */
export async function lintVaultTags(store: NoteStore, registry: AreaRegistry): Promise<TagLintIssue[]> {
  const all = await store.list()
  const pairs: Array<{ path: string; tags: string[] }> = []
  for (const f of all) {
    if (!f.path.endsWith('.md')) continue
    try {
      const content = await store.read(f.path)
      const { fm } = parseFrontmatter(content)
      if (fm.tags?.length) pairs.push({ path: f.path, tags: fm.tags })
    } catch { /* unreadable — skip, not this lint's job */ }
  }
  return lintTagPairs(pairs, registry)
}

export function areaRegistryPath(vaultPath: string): string {
  return join(vaultPath, REGISTRY_PATH)
}
