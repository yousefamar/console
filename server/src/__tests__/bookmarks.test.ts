import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseFrontmatter, toBookmark, buildTagTree, BookmarkStore } from '../bookmarks.js'

// --------------------------------------------------------------------------
// parseFrontmatter
// --------------------------------------------------------------------------

describe('parseFrontmatter', () => {
  it('parses valid YAML frontmatter', () => {
    const content = `---
title: Test Bookmark
url: https://example.com
tags:
- dev/tools
- status/active
---
Some body content`

    const { frontmatter, body } = parseFrontmatter(content)
    expect(frontmatter.title).toBe('Test Bookmark')
    expect(frontmatter.url).toBe('https://example.com')
    expect(frontmatter.tags).toEqual(['dev/tools', 'status/active'])
    expect(body).toBe('Some body content')
  })

  it('handles missing frontmatter', () => {
    const content = 'Just plain text with no frontmatter'
    const { frontmatter, body } = parseFrontmatter(content)
    expect(frontmatter).toEqual({})
    expect(body).toBe(content)
  })

  it('handles empty frontmatter', () => {
    const content = `---

---
Body only`
    const { frontmatter, body } = parseFrontmatter(content)
    expect(frontmatter).toEqual({})
    expect(body).toBe('Body only')
  })

  it('handles frontmatter with missing fields', () => {
    const content = `---
title: Only Title
---
`
    const { frontmatter, body } = parseFrontmatter(content)
    expect(frontmatter.title).toBe('Only Title')
    expect(frontmatter.url).toBeUndefined()
    expect(frontmatter.tags).toBeUndefined()
  })

  it('handles malformed YAML gracefully', () => {
    const content = `---
title: [invalid yaml
  broken: {
---
body`
    const { frontmatter, body } = parseFrontmatter(content)
    // Should fallback gracefully
    expect(typeof frontmatter).toBe('object')
    expect(typeof body).toBe('string')
  })
})

// --------------------------------------------------------------------------
// toBookmark
// --------------------------------------------------------------------------

describe('toBookmark', () => {
  it('converts frontmatter to bookmark with defaults', () => {
    const bm = toBookmark('test.md', {
      title: 'Test',
      url: 'https://example.com',
      added: '2026-01-03',
      description: 'A test',
      tags: ['dev/tools'],
    })
    expect(bm).toEqual({
      filename: 'test.md',
      title: 'Test',
      url: 'https://example.com',
      added: '2026-01-03',
      archive: null,
      description: 'A test',
      tags: ['dev/tools'],
    })
  })

  it('uses filename as title fallback', () => {
    const bm = toBookmark('my-bookmark.md', { url: 'https://example.com' })
    expect(bm.title).toBe('my-bookmark')
  })

  it('handles missing tags', () => {
    const bm = toBookmark('test.md', { title: 'No tags', url: 'https://example.com' })
    expect(bm.tags).toEqual([])
  })

  it('handles archive URL', () => {
    const bm = toBookmark('test.md', {
      title: 'Archived',
      url: 'https://example.com',
      archive: 'https://web.archive.org/example',
    })
    expect(bm.archive).toBe('https://web.archive.org/example')
  })
})

// --------------------------------------------------------------------------
// buildTagTree
// --------------------------------------------------------------------------

describe('buildTagTree', () => {
  it('builds hierarchical tag tree', () => {
    const bookmarks = [
      { filename: 'a.md', title: 'A', url: '', added: '', archive: null, description: '', tags: ['dev/frontend/react'] },
      { filename: 'b.md', title: 'B', url: '', added: '', archive: null, description: '', tags: ['dev/frontend/vue'] },
      { filename: 'c.md', title: 'C', url: '', added: '', archive: null, description: '', tags: ['dev/backend'] },
    ]

    const tree = buildTagTree(bookmarks)
    expect(tree).toHaveLength(1) // just 'dev'
    expect(tree[0]!.name).toBe('dev')
    expect(tree[0]!.count).toBe(3) // all 3 bookmarks have dev/*
    expect(tree[0]!.children).toHaveLength(2) // frontend, backend

    const frontend = tree[0]!.children.find((n) => n.name === 'frontend')!
    expect(frontend.count).toBe(2)
    expect(frontend.children).toHaveLength(2) // react, vue
    expect(frontend.fullPath).toBe('dev/frontend')

    const backend = tree[0]!.children.find((n) => n.name === 'backend')!
    expect(backend.count).toBe(1)
    expect(backend.children).toHaveLength(0)
  })

  it('handles bookmarks with no tags', () => {
    const tree = buildTagTree([
      { filename: 'a.md', title: 'A', url: '', added: '', archive: null, description: '', tags: [] },
    ])
    expect(tree).toEqual([])
  })

  it('handles multiple root-level tags', () => {
    const tree = buildTagTree([
      { filename: 'a.md', title: 'A', url: '', added: '', archive: null, description: '', tags: ['dev/tools', 'status/active'] },
    ])
    expect(tree).toHaveLength(2) // dev, status
  })
})

// --------------------------------------------------------------------------
// BookmarkStore (integration — uses temp directory)
// --------------------------------------------------------------------------

describe('BookmarkStore', () => {
  let tmpDir: string
  let store: BookmarkStore

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'bookmarks-test-'))
    store = new BookmarkStore(tmpDir)

    // Create test bookmark files
    await writeFile(join(tmpDir, 'example-com.md'), `---
title: Example Site
url: https://example.com
added: '2026-01-01'
archive: null
description: An example website
tags:
- status/active
- dev/tools
---
Some notes about example.com`)

    await writeFile(join(tmpDir, 'broken-site.md'), `---
title: Broken Site
url: https://broken.example.com
added: '2026-01-02'
archive: https://web.archive.org/broken
description: This site is broken
tags:
- status/broken
- dev/frontend
---
`)

    await writeFile(join(tmpDir, 'no-tags.md'), `---
title: No Tags
url: https://notags.example.com
added: '2026-01-03'
description: Bookmark with no tags
---
`)

    // Non-markdown file (should be ignored)
    await writeFile(join(tmpDir, 'readme.txt'), 'Not a bookmark')
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('loads all bookmark .md files', async () => {
    const list = await store.list()
    expect(list).toHaveLength(3)
    expect(list.map((b) => b.filename).sort()).toEqual([
      'broken-site.md',
      'example-com.md',
      'no-tags.md',
    ])
  })

  it('returns bookmark without body in list', async () => {
    const list = await store.list()
    const example = list.find((b) => b.filename === 'example-com.md')!
    expect(example.title).toBe('Example Site')
    expect(example.url).toBe('https://example.com')
    expect(example.tags).toEqual(['status/active', 'dev/tools'])
    expect('body' in example).toBe(false)
  })

  it('returns single bookmark with body', async () => {
    const bm = await store.get('example-com.md')
    expect(bm).not.toBeNull()
    expect(bm!.title).toBe('Example Site')
    expect(bm!.body).toBe('Some notes about example.com')
  })

  it('returns null for nonexistent bookmark', async () => {
    const bm = await store.get('nonexistent.md')
    expect(bm).toBeNull()
  })

  it('updates tags preserving other fields and body', async () => {
    const updated = await store.update('example-com.md', {
      tags: ['status/active', 'dev/tools', 'learning/reference'],
    })
    expect(updated).not.toBeNull()
    expect(updated!.tags).toEqual(['status/active', 'dev/tools', 'learning/reference'])
    expect(updated!.title).toBe('Example Site')
    expect(updated!.body).toBe('Some notes about example.com')

    // Verify file on disk
    const content = await readFile(join(tmpDir, 'example-com.md'), 'utf-8')
    expect(content).toContain('learning/reference')
    expect(content).toContain('Some notes about example.com')
    expect(content).toContain('title: Example Site')
  })

  it('returns null when updating nonexistent file', async () => {
    const result = await store.update('nonexistent.md', { tags: [] })
    expect(result).toBeNull()
  })

  it('deletes a bookmark', async () => {
    const deleted = await store.delete('broken-site.md')
    expect(deleted).toBe(true)

    // Should be gone from cache
    const bm = await store.get('broken-site.md')
    expect(bm).toBeNull()

    // Should be gone from disk
    const files = await readdir(tmpDir)
    expect(files).not.toContain('broken-site.md')
  })

  it('returns false when deleting nonexistent file', async () => {
    const deleted = await store.delete('nonexistent.md')
    expect(deleted).toBe(false)
  })

  it('builds tag tree from loaded bookmarks', async () => {
    const tree = await store.getTagTree()
    expect(tree.length).toBeGreaterThan(0)
    const statusNode = tree.find((n) => n.name === 'status')!
    expect(statusNode).toBeDefined()
    expect(statusNode.count).toBe(2) // active + broken
    const devNode = tree.find((n) => n.name === 'dev')!
    expect(devNode).toBeDefined()
    expect(devNode.count).toBe(2) // tools, frontend
  })

  it('handles malformed files gracefully', async () => {
    await writeFile(join(tmpDir, 'bad-file.md'), 'no frontmatter at all')
    await store.reload()
    // Should still load the other 3 valid bookmarks
    const list = await store.list()
    expect(list).toHaveLength(3)
  })

  it('reloads from disk', async () => {
    await store.list() // initial load
    // Add a new file
    await writeFile(join(tmpDir, 'new-site.md'), `---
title: New Site
url: https://new.example.com
tags:
- status/active
---
`)
    await store.reload()
    const list = await store.list()
    expect(list).toHaveLength(4)
  })
})
