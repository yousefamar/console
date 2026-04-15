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

import { hubFetchRaw as hubFetch } from '@/hub'

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

  // Add bookmark
  addMode: boolean
  addUrl: string
  addLoading: boolean
  addPreview: { title: string; description: string; url: string } | null
  addSuggestedTags: string[]
  addSelectedTags: string[]

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
  enterAddMode: () => void
  exitAddMode: () => void
  setAddUrl: (url: string) => void
  fetchAddPreview: (url: string) => Promise<void>
  toggleAddTag: (tag: string) => void
  addCustomTag: (tag: string) => void
  saveNewBookmark: () => Promise<void>
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
  addMode: false,
  addUrl: '',
  addLoading: false,
  addPreview: null,
  addSuggestedTags: [],
  addSelectedTags: [],

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

  enterAddMode: () => {
    set({
      addMode: true,
      addUrl: '',
      addLoading: false,
      addPreview: null,
      addSuggestedTags: [],
      addSelectedTags: [],
    })
  },

  exitAddMode: () => {
    set({
      addMode: false,
      addUrl: '',
      addLoading: false,
      addPreview: null,
      addSuggestedTags: [],
      addSelectedTags: [],
    })
  },

  setAddUrl: (url) => set({ addUrl: url }),

  fetchAddPreview: async (url) => {
    set({ addLoading: true, addPreview: null, addSuggestedTags: [], addSelectedTags: [] })
    try {
      // Create the bookmark (fetches metadata server-side)
      const createRes = await hubFetch('/bookmarks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })
      if (!createRes.ok) {
        set({ addLoading: false })
        return
      }
      const bm = (await createRes.json()) as Bookmark & { body: string }
      const preview = { title: bm.title, description: bm.description, url: bm.url }
      set({ addPreview: preview, addSelectedTags: [...bm.tags] })

      // Add to local bookmarks list immediately
      set((s) => {
        const exists = s.bookmarks.some((b) => b.filename === bm.filename)
        if (exists) return s
        const bookmarks = [...s.bookmarks, { ...bm }].sort((a, b) => a.title.localeCompare(b.title))
        return { bookmarks, selectedBookmarkId: bm.filename }
      })

      // Suggest tags in parallel (non-blocking)
      hubFetch('/bookmarks/suggest-tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: bm.title, description: bm.description, url: bm.url }),
      })
        .then((res) => res.ok ? res.json() : null)
        .then((data: { tags: string[] } | null) => {
          if (data?.tags && get().addMode) {
            set({ addSuggestedTags: data.tags, addSelectedTags: data.tags })
            // Also update the bookmark file with suggested tags
            const currentBm = get().bookmarks.find((b) => b.filename === bm.filename)
            if (currentBm) {
              get().updateBookmarkTags(bm.filename, data.tags)
            }
          }
        })
        .catch(() => {})

      set({ addLoading: false })
    } catch {
      set({ addLoading: false })
    }
  },

  toggleAddTag: (tag) => {
    set((s) => {
      const tags = s.addSelectedTags.includes(tag)
        ? s.addSelectedTags.filter((t) => t !== tag)
        : [...s.addSelectedTags, tag]
      return { addSelectedTags: tags }
    })
  },

  addCustomTag: (tag) => {
    if (!tag) return
    set((s) => ({
      addSelectedTags: s.addSelectedTags.includes(tag)
        ? s.addSelectedTags
        : [...s.addSelectedTags, tag],
    }))
  },

  saveNewBookmark: async () => {
    const { addPreview, addSelectedTags, bookmarks } = get()
    if (!addPreview) return

    // Find the bookmark that was created and update its tags
    const bm = bookmarks.find((b) => b.url === addPreview.url)
    if (bm) {
      await get().updateBookmarkTags(bm.filename, addSelectedTags)
    }

    // Refresh tag tree
    try {
      const tagRes = await hubFetch('/bookmarks/tags')
      if (tagRes.ok) {
        const tagTree = (await tagRes.json()) as TagTreeNode[]
        set({ tagTree })
      }
    } catch {}

    get().exitAddMode()
  },
}))
