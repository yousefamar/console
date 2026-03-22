import { create } from 'zustand'

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

export interface Bookmark {
  filename: string
  title: string
  url: string
  added: string
  archive: string | null
  description: string
  tags: string[]
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
// Hub API helpers
// --------------------------------------------------------------------------

function getHubUrl(): string {
  if (typeof window !== 'undefined') {
    return localStorage.getItem('agentHubUrl') ?? 'http://localhost:9877'
  }
  return 'http://localhost:9877'
}

async function hubFetch(path: string, options?: RequestInit): Promise<Response> {
  return fetch(`${getHubUrl()}${path}`, options)
}

// --------------------------------------------------------------------------
// Filtering
// --------------------------------------------------------------------------

export function filterBookmarks(
  bookmarks: Bookmark[],
  searchQuery: string,
  selectedTag: string | null,
): Bookmark[] {
  let filtered = bookmarks

  // Tag filter
  if (selectedTag) {
    filtered = filtered.filter((bm) =>
      bm.tags.some((tag) => tag === selectedTag || tag.startsWith(selectedTag + '/')),
    )
  }

  // Search filter
  if (searchQuery) {
    const q = searchQuery.toLowerCase()
    filtered = filtered.filter((bm) =>
      bm.title.toLowerCase().includes(q)
      || bm.url.toLowerCase().includes(q)
      || bm.description.toLowerCase().includes(q)
      || bm.tags.some((tag) => tag.toLowerCase().includes(q)),
    )
  }

  return filtered
}

// --------------------------------------------------------------------------
// Store
// --------------------------------------------------------------------------

interface BookmarkState {
  // Data
  bookmarks: Bookmark[]
  tagTree: TagTreeNode[]
  loading: boolean
  connected: boolean

  // Selection
  selectedBookmarkId: string | null // filename
  selectedBookmarkBody: string | null

  // Filtering
  searchQuery: string
  selectedTag: string | null
  expandedTags: Set<string>

  // Triage mode
  triageMode: boolean
  triageIndex: number

  // Actions
  fetchBookmarks: () => Promise<void>
  selectBookmark: (filename: string | null) => void
  selectNextBookmark: () => void
  selectPrevBookmark: () => void
  deleteBookmark: (filename?: string) => Promise<void>
  updateBookmarkTags: (filename: string, tags: string[]) => Promise<void>
  setSearchQuery: (query: string) => void
  selectTag: (tag: string | null) => void
  toggleTagExpanded: (tag: string) => void
  enterTriageMode: () => void
  exitTriageMode: () => void
  triageKeep: () => void
  triageSkip: () => void
  triageDelete: () => Promise<void>
  openBookmarkUrl: () => void
}

export const useBookmarkStore = create<BookmarkState>((set, get) => ({
  bookmarks: [],
  tagTree: [],
  loading: false,
  connected: false,
  selectedBookmarkId: null,
  selectedBookmarkBody: null,
  searchQuery: '',
  selectedTag: null,
  expandedTags: new Set<string>(),
  triageMode: false,
  triageIndex: 0,

  fetchBookmarks: async () => {
    set({ loading: true })
    try {
      const [bmRes, tagRes] = await Promise.all([
        hubFetch('/bookmarks'),
        hubFetch('/bookmarks/tags'),
      ])
      if (!bmRes.ok || !tagRes.ok) {
        set({ loading: false, connected: false })
        return
      }
      const bookmarks = (await bmRes.json()) as Bookmark[]
      const tagTree = (await tagRes.json()) as TagTreeNode[]
      // Sort alphabetically by title
      bookmarks.sort((a, b) => a.title.localeCompare(b.title))
      set({ bookmarks, tagTree, loading: false, connected: true })
    } catch {
      set({ loading: false, connected: false })
    }
  },

  selectBookmark: (filename) => {
    if (!filename) {
      set({ selectedBookmarkId: null, selectedBookmarkBody: null })
      return
    }
    set({ selectedBookmarkId: filename, selectedBookmarkBody: null })
    // Fetch body in background
    hubFetch(`/bookmarks/${encodeURIComponent(filename)}`)
      .then((res) => res.ok ? res.json() : null)
      .then((bm: BookmarkWithBody | null) => {
        if (bm && get().selectedBookmarkId === filename) {
          set({ selectedBookmarkBody: bm.body })
        }
      })
      .catch(() => {})
  },

  selectNextBookmark: () => {
    const { bookmarks, selectedBookmarkId, searchQuery, selectedTag, triageMode, triageIndex } = get()
    const filtered = filterBookmarks(bookmarks, searchQuery, selectedTag)
    if (filtered.length === 0) return

    if (triageMode) {
      const next = Math.min(triageIndex + 1, filtered.length - 1)
      set({ triageIndex: next, selectedBookmarkId: filtered[next]!.filename, selectedBookmarkBody: null })
      return
    }

    const idx = filtered.findIndex((b) => b.filename === selectedBookmarkId)
    const next = idx < 0 ? 0 : Math.min(idx + 1, filtered.length - 1)
    get().selectBookmark(filtered[next]!.filename)
  },

  selectPrevBookmark: () => {
    const { bookmarks, selectedBookmarkId, searchQuery, selectedTag, triageMode, triageIndex } = get()
    const filtered = filterBookmarks(bookmarks, searchQuery, selectedTag)
    if (filtered.length === 0) return

    if (triageMode) {
      const prev = Math.max(triageIndex - 1, 0)
      set({ triageIndex: prev, selectedBookmarkId: filtered[prev]!.filename, selectedBookmarkBody: null })
      return
    }

    const idx = filtered.findIndex((b) => b.filename === selectedBookmarkId)
    const prev = idx < 0 ? 0 : Math.max(idx - 1, 0)
    get().selectBookmark(filtered[prev]!.filename)
  },

  deleteBookmark: async (filename) => {
    const target = filename ?? get().selectedBookmarkId
    if (!target) return

    try {
      const res = await hubFetch(`/bookmarks/${encodeURIComponent(target)}`, { method: 'DELETE' })
      if (!res.ok) return
    } catch {
      return
    }

    // Remove from local state
    const { bookmarks, selectedBookmarkId, searchQuery, selectedTag, triageMode, triageIndex } = get()
    const filtered = filterBookmarks(bookmarks, searchQuery, selectedTag)
    const filteredIdx = filtered.findIndex((b) => b.filename === target)
    const newBookmarks = bookmarks.filter((b) => b.filename !== target)

    // Auto-advance selection
    let newSelected = selectedBookmarkId === target ? null : selectedBookmarkId
    if (selectedBookmarkId === target && filtered.length > 1) {
      const nextIdx = Math.min(filteredIdx, filtered.length - 2)
      const remaining = filtered.filter((b) => b.filename !== target)
      if (remaining[nextIdx]) newSelected = remaining[nextIdx]!.filename
    }

    // Adjust triage index
    let newTriageIndex = triageIndex
    if (triageMode && filteredIdx <= triageIndex) {
      newTriageIndex = Math.max(0, triageIndex)
      // Since the item was removed, the array shifted — keep same index
      // but clamp to new length
      const newFiltered = filterBookmarks(newBookmarks, searchQuery, selectedTag)
      newTriageIndex = Math.min(newTriageIndex, Math.max(0, newFiltered.length - 1))
    }

    set({
      bookmarks: newBookmarks,
      selectedBookmarkId: newSelected,
      selectedBookmarkBody: null,
      triageIndex: newTriageIndex,
    })
  },

  updateBookmarkTags: async (filename, tags) => {
    try {
      const res = await hubFetch(`/bookmarks/${encodeURIComponent(filename)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags }),
      })
      if (!res.ok) return
      const updated = (await res.json()) as BookmarkWithBody

      // Update local state
      set((s) => ({
        bookmarks: s.bookmarks.map((b) =>
          b.filename === filename
            ? { ...b, tags: updated.tags }
            : b,
        ),
      }))
    } catch {
      // Silently fail — vault is source of truth
    }
  },

  setSearchQuery: (query) => set({ searchQuery: query }),

  selectTag: (tag) => {
    const { selectedTag, expandedTags } = get()
    if (tag === selectedTag) {
      set({ selectedTag: null })
      return
    }
    // Expand parent tags
    if (tag) {
      const newExpanded = new Set(expandedTags)
      const parts = tag.split('/')
      for (let i = 0; i < parts.length; i++) {
        newExpanded.add(parts.slice(0, i + 1).join('/'))
      }
      set({ selectedTag: tag, expandedTags: newExpanded })
    } else {
      set({ selectedTag: null })
    }
  },

  toggleTagExpanded: (tag) => {
    const expanded = new Set(get().expandedTags)
    if (expanded.has(tag)) expanded.delete(tag)
    else expanded.add(tag)
    set({ expandedTags: expanded })
  },

  enterTriageMode: () => {
    const { bookmarks, searchQuery, selectedTag } = get()
    const filtered = filterBookmarks(bookmarks, searchQuery, selectedTag)
    set({
      triageMode: true,
      triageIndex: 0,
      selectedBookmarkId: filtered[0]?.filename ?? null,
      selectedBookmarkBody: null,
    })
  },

  exitTriageMode: () => {
    set({ triageMode: false })
  },

  triageKeep: () => {
    const { bookmarks, searchQuery, selectedTag, triageIndex } = get()
    const filtered = filterBookmarks(bookmarks, searchQuery, selectedTag)
    const next = triageIndex + 1
    if (next >= filtered.length) {
      set({ triageMode: false })
      return
    }
    set({
      triageIndex: next,
      selectedBookmarkId: filtered[next]!.filename,
      selectedBookmarkBody: null,
    })
  },

  triageSkip: () => {
    // Same as keep — just advance
    get().triageKeep()
  },

  triageDelete: async () => {
    const { bookmarks, searchQuery, selectedTag, triageIndex } = get()
    const filtered = filterBookmarks(bookmarks, searchQuery, selectedTag)
    const current = filtered[triageIndex]
    if (!current) return
    await get().deleteBookmark(current.filename)
    // After delete, check if we're past the end
    const newFiltered = filterBookmarks(get().bookmarks, searchQuery, selectedTag)
    if (get().triageIndex >= newFiltered.length) {
      set({ triageMode: false })
    } else if (newFiltered[get().triageIndex]) {
      set({
        selectedBookmarkId: newFiltered[get().triageIndex]!.filename,
        selectedBookmarkBody: null,
      })
    }
  },

  openBookmarkUrl: () => {
    const { bookmarks, selectedBookmarkId } = get()
    const bm = bookmarks.find((b) => b.filename === selectedBookmarkId)
    if (bm?.url) {
      window.open(bm.url, '_blank')
    }
  },
}))
