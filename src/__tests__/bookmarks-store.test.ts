import { describe, it, expect, beforeEach, vi } from 'vitest'
import { filterBookmarks, useBookmarkStore, type Bookmark } from '@/store/bookmarks'

// --------------------------------------------------------------------------
// filterBookmarks (pure function)
// --------------------------------------------------------------------------

const sampleBookmarks: Bookmark[] = [
  {
    filename: 'example-com.md',
    title: 'Example Site',
    url: 'https://example.com',
    added: '2026-01-01',
    archive: null,
    description: 'An example website for testing',
    tags: ['status/active', 'dev/tools'],
  },
  {
    filename: 'broken-site.md',
    title: 'Broken Site',
    url: 'https://broken.example.com',
    added: '2026-01-02',
    archive: 'https://web.archive.org/broken',
    description: 'This site no longer works',
    tags: ['status/broken', 'dev/frontend/react'],
  },
  {
    filename: 'ai-tool.md',
    title: 'AI Tool',
    url: 'https://ai.example.com',
    added: '2026-01-03',
    archive: null,
    description: 'Machine learning platform',
    tags: ['status/active', 'ai-ml/tools', 'dev/backend'],
  },
  {
    filename: 'no-tags.md',
    title: 'No Tags',
    url: 'https://notags.example.com',
    added: '2026-01-04',
    archive: null,
    description: 'Bookmark with no tags',
    tags: [],
  },
]

describe('filterBookmarks', () => {
  it('returns all bookmarks when no filters', () => {
    const result = filterBookmarks(sampleBookmarks, '', null)
    expect(result).toHaveLength(4)
  })

  it('filters by tag (exact match)', () => {
    const result = filterBookmarks(sampleBookmarks, '', 'status/broken')
    expect(result).toHaveLength(1)
    expect(result[0]!.filename).toBe('broken-site.md')
  })

  it('filters by parent tag (includes children)', () => {
    const result = filterBookmarks(sampleBookmarks, '', 'dev')
    expect(result).toHaveLength(3) // example-com, broken-site, ai-tool
  })

  it('filters by nested tag', () => {
    const result = filterBookmarks(sampleBookmarks, '', 'dev/frontend')
    expect(result).toHaveLength(1) // broken-site (dev/frontend/react starts with dev/frontend/)
  })

  it('filters by search query — title', () => {
    const result = filterBookmarks(sampleBookmarks, 'broken', null)
    expect(result).toHaveLength(1)
    expect(result[0]!.filename).toBe('broken-site.md')
  })

  it('filters by search query — url', () => {
    const result = filterBookmarks(sampleBookmarks, 'ai.example', null)
    expect(result).toHaveLength(1)
    expect(result[0]!.filename).toBe('ai-tool.md')
  })

  it('filters by search query — description', () => {
    const result = filterBookmarks(sampleBookmarks, 'machine learning', null)
    expect(result).toHaveLength(1)
    expect(result[0]!.filename).toBe('ai-tool.md')
  })

  it('filters by search query — tag name', () => {
    const result = filterBookmarks(sampleBookmarks, 'ai-ml', null)
    expect(result).toHaveLength(1)
    expect(result[0]!.filename).toBe('ai-tool.md')
  })

  it('combines tag and search filters', () => {
    const result = filterBookmarks(sampleBookmarks, 'testing', 'status/active')
    expect(result).toHaveLength(1)
    expect(result[0]!.filename).toBe('example-com.md')
  })

  it('search is case-insensitive', () => {
    const result = filterBookmarks(sampleBookmarks, 'BROKEN', null)
    expect(result).toHaveLength(1)
  })
})

// --------------------------------------------------------------------------
// useBookmarkStore
// --------------------------------------------------------------------------

describe('useBookmarkStore', () => {
  beforeEach(() => {
    useBookmarkStore.setState({
      bookmarks: [...sampleBookmarks],
      tagTree: [],
      loading: false,
      connected: true,
      selectedBookmarkId: null,
      selectedBookmarkBody: null,
      searchQuery: '',
      selectedTag: null,
      expandedTags: new Set(),
      triageMode: false,
      triageIndex: 0,
    })
  })

  it('selectBookmark sets selectedBookmarkId', () => {
    // Mock fetch for body
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ body: 'test' })))
    useBookmarkStore.getState().selectBookmark('example-com.md')
    expect(useBookmarkStore.getState().selectedBookmarkId).toBe('example-com.md')
    vi.restoreAllMocks()
  })

  it('selectBookmark(null) deselects', () => {
    useBookmarkStore.setState({ selectedBookmarkId: 'example-com.md' })
    useBookmarkStore.getState().selectBookmark(null)
    expect(useBookmarkStore.getState().selectedBookmarkId).toBeNull()
  })

  it('selectNextBookmark advances selection', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ body: '' })))
    useBookmarkStore.getState().selectBookmark(sampleBookmarks[0]!.filename)
    useBookmarkStore.getState().selectNextBookmark()
    expect(useBookmarkStore.getState().selectedBookmarkId).toBe(sampleBookmarks[1]!.filename)
    vi.restoreAllMocks()
  })

  it('selectPrevBookmark moves back', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ body: '' })))
    useBookmarkStore.getState().selectBookmark(sampleBookmarks[1]!.filename)
    useBookmarkStore.getState().selectPrevBookmark()
    expect(useBookmarkStore.getState().selectedBookmarkId).toBe(sampleBookmarks[0]!.filename)
    vi.restoreAllMocks()
  })

  it('selectNextBookmark selects first when none selected', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ body: '' })))
    useBookmarkStore.getState().selectNextBookmark()
    expect(useBookmarkStore.getState().selectedBookmarkId).toBe(sampleBookmarks[0]!.filename)
    vi.restoreAllMocks()
  })

  it('setSearchQuery updates search', () => {
    useBookmarkStore.getState().setSearchQuery('broken')
    expect(useBookmarkStore.getState().searchQuery).toBe('broken')
  })

  it('selectTag toggles tag filter', () => {
    useBookmarkStore.getState().selectTag('dev/tools')
    expect(useBookmarkStore.getState().selectedTag).toBe('dev/tools')
    // Clicking same tag again clears it
    useBookmarkStore.getState().selectTag('dev/tools')
    expect(useBookmarkStore.getState().selectedTag).toBeNull()
  })

  it('selectTag expands parent tags', () => {
    useBookmarkStore.getState().selectTag('dev/frontend/react')
    const expanded = useBookmarkStore.getState().expandedTags
    expect(expanded.has('dev')).toBe(true)
    expect(expanded.has('dev/frontend')).toBe(true)
    expect(expanded.has('dev/frontend/react')).toBe(true)
  })

  it('toggleTagExpanded toggles expansion', () => {
    useBookmarkStore.getState().toggleTagExpanded('dev')
    expect(useBookmarkStore.getState().expandedTags.has('dev')).toBe(true)
    useBookmarkStore.getState().toggleTagExpanded('dev')
    expect(useBookmarkStore.getState().expandedTags.has('dev')).toBe(false)
  })

  it('deleteBookmark removes from list', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true })))
    useBookmarkStore.setState({ selectedBookmarkId: 'broken-site.md' })
    await useBookmarkStore.getState().deleteBookmark('broken-site.md')
    expect(useBookmarkStore.getState().bookmarks.find((b) => b.filename === 'broken-site.md')).toBeUndefined()
    vi.restoreAllMocks()
  })

  // Triage mode

  it('enterTriageMode sets up queue at index 0', () => {
    useBookmarkStore.getState().enterTriageMode()
    expect(useBookmarkStore.getState().triageMode).toBe(true)
    expect(useBookmarkStore.getState().triageIndex).toBe(0)
    expect(useBookmarkStore.getState().selectedBookmarkId).toBe(sampleBookmarks[0]!.filename)
  })

  it('triageKeep advances to next bookmark', () => {
    useBookmarkStore.getState().enterTriageMode()
    useBookmarkStore.getState().triageKeep()
    expect(useBookmarkStore.getState().triageIndex).toBe(1)
    expect(useBookmarkStore.getState().selectedBookmarkId).toBe(sampleBookmarks[1]!.filename)
  })

  it('triageKeep exits triage at end of queue', () => {
    useBookmarkStore.getState().enterTriageMode()
    // Advance to end
    for (let i = 0; i < sampleBookmarks.length; i++) {
      useBookmarkStore.getState().triageKeep()
    }
    expect(useBookmarkStore.getState().triageMode).toBe(false)
  })

  it('triageSkip is same as keep', () => {
    useBookmarkStore.getState().enterTriageMode()
    useBookmarkStore.getState().triageSkip()
    expect(useBookmarkStore.getState().triageIndex).toBe(1)
  })

  it('triageDelete removes and stays at same index', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true })))
    useBookmarkStore.getState().enterTriageMode()
    const firstFilename = sampleBookmarks[0]!.filename
    await useBookmarkStore.getState().triageDelete()
    expect(useBookmarkStore.getState().bookmarks.find((b) => b.filename === firstFilename)).toBeUndefined()
    expect(useBookmarkStore.getState().triageIndex).toBe(0)
    // Should now point to what was the second item
    expect(useBookmarkStore.getState().selectedBookmarkId).toBe(sampleBookmarks[1]!.filename)
    vi.restoreAllMocks()
  })

  it('triage respects search filter', () => {
    useBookmarkStore.getState().setSearchQuery('broken')
    useBookmarkStore.getState().enterTriageMode()
    expect(useBookmarkStore.getState().selectedBookmarkId).toBe('broken-site.md')
  })

  it('triage respects tag filter', () => {
    useBookmarkStore.getState().selectTag('status/broken')
    useBookmarkStore.getState().enterTriageMode()
    expect(useBookmarkStore.getState().selectedBookmarkId).toBe('broken-site.md')
  })

  it('exitTriageMode clears triage state', () => {
    useBookmarkStore.getState().enterTriageMode()
    useBookmarkStore.getState().exitTriageMode()
    expect(useBookmarkStore.getState().triageMode).toBe(false)
  })
})
