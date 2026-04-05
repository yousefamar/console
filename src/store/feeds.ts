import { create } from 'zustand'
import { db } from '@/db'
import type { DbFeedItem, DbFeedRead } from '@/db'

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

// --------------------------------------------------------------------------
// Hub API
// --------------------------------------------------------------------------

import { hubFetchRaw as hubFetch } from '@/hub'

// --------------------------------------------------------------------------
// Store
// --------------------------------------------------------------------------

interface FeedState {
  // Data
  feeds: FeedSubscription[]
  items: FeedItem[]
  loading: boolean
  connected: boolean
  lastSync: string | null

  // Selection
  selectedFeedId: string | null
  selectedFolderId: string | null
  selectedItemId: string | null

  // UI
  searchQuery: string
  showUnreadOnly: boolean
  expandedFolders: Set<string>
  unreadCounts: Record<string, number>
  totalUnread: number
  showAddModal: boolean

  // Actions
  fetchFeeds: () => Promise<void>
  refreshItems: () => Promise<void>
  selectFeed: (feedId: string | null) => void
  selectFolder: (folder: string | null) => void
  selectItem: (itemId: string | null) => void
  selectNextItem: () => void
  selectPrevItem: () => void
  markRead: (itemId?: string) => Promise<void>
  markUnread: (itemId: string) => Promise<void>
  markFeedRead: (feedId: string) => Promise<void>
  markFolderRead: (folder: string) => Promise<void>
  toggleFolder: (folder: string) => void
  toggleUnreadOnly: () => void
  setSearchQuery: (q: string) => void
  addFeed: (xmlUrl: string, folder?: string, fullText?: boolean) => Promise<void>
  deleteFeed: (feedId: string) => Promise<void>
  importOpml: (file: File) => Promise<void>
  openItemInBrowser: () => void
  loadItemsFromDb: () => Promise<void>
  computeUnreadCounts: () => Promise<void>
  setShowAddModal: (v: boolean) => void
}

export const useFeedStore = create<FeedState>((set, get) => ({
  feeds: [],
  items: [],
  loading: false,
  connected: false,
  lastSync: null,

  selectedFeedId: null,
  selectedFolderId: null,
  selectedItemId: null,

  searchQuery: '',
  showUnreadOnly: true,
  expandedFolders: new Set<string>(),
  unreadCounts: {},
  totalUnread: 0,
  showAddModal: false,

  setShowAddModal: (v) => set({ showAddModal: v }),

  fetchFeeds: async () => {
    set({ loading: true })
    try {
      const res = await hubFetch('/feeds')
      if (!res.ok) {
        set({ loading: false, connected: false })
        return
      }
      const feeds = (await res.json()) as FeedSubscription[]
      feeds.sort((a, b) => a.title.localeCompare(b.title))
      set({ feeds, loading: false, connected: true })
    } catch {
      set({ loading: false, connected: false })
    }
  },

  refreshItems: async () => {
    const { lastSync, connected } = get()
    if (!connected) return

    try {
      const params = lastSync ? `?since=${encodeURIComponent(lastSync)}` : ''
      const res = await hubFetch(`/feeds/items${params}`)
      if (!res.ok) return

      const data = await res.json() as { items: FeedItem[]; readIds: string[] }

      // Store items in IndexedDB
      if (data.items.length > 0) {
        const dbItems: DbFeedItem[] = data.items.map((item) => ({
          id: item.id,
          feedId: item.feedId,
          title: item.title,
          link: item.link,
          content: item.content,
          contentSnippet: item.contentSnippet,
          author: item.author,
          publishedAt: item.publishedAt,
          imageUrl: item.imageUrl,
        }))
        await db.feedItems.bulkPut(dbItems)
      }

      // Sync read state from hub (cross-device sync)
      if (data.readIds.length > 0) {
        const readEntries: DbFeedRead[] = data.readIds.map((id) => ({ itemId: id }))
        await db.feedRead.bulkPut(readEntries)
      }

      set({ lastSync: new Date().toISOString() })

      // Trim old items: keep max 50 per feed
      await trimItems(get().feeds)

      // Reload view
      await get().loadItemsFromDb()
      await get().computeUnreadCounts()
    } catch (err) {
      console.error('Feed refresh failed:', err)
    }
  },

  selectFeed: (feedId) => {
    set({ selectedFeedId: feedId, selectedFolderId: null, selectedItemId: null })
    get().loadItemsFromDb()
  },

  selectFolder: (folder) => {
    set({ selectedFolderId: folder, selectedFeedId: null, selectedItemId: null })
    get().loadItemsFromDb()
  },

  selectItem: (itemId) => {
    set({ selectedItemId: itemId })
  },

  selectNextItem: () => {
    const { items, selectedItemId } = get()
    if (items.length === 0) return
    const idx = items.findIndex((i) => i.id === selectedItemId)
    const next = idx < 0 ? 0 : Math.min(idx + 1, items.length - 1)
    set({ selectedItemId: items[next]!.id })
  },

  selectPrevItem: () => {
    const { items, selectedItemId } = get()
    if (items.length === 0) return
    const idx = items.findIndex((i) => i.id === selectedItemId)
    const prev = idx <= 0 ? 0 : idx - 1
    set({ selectedItemId: items[prev]!.id })
  },

  markRead: async (itemId?) => {
    const id = itemId ?? get().selectedItemId
    if (!id) return

    // Optimistic: add to local read set
    await db.feedRead.put({ itemId: id })

    // Auto-advance
    const { items, selectedItemId } = get()
    if (id === selectedItemId) {
      const idx = items.findIndex((i) => i.id === id)
      const nextIdx = idx >= 0 && idx < items.length - 1 ? idx + 1 : Math.max(0, idx - 1)
      const nextId = items.length > 1 ? items[nextIdx]?.id ?? null : null
      set({ selectedItemId: nextId })
    }

    await get().loadItemsFromDb()
    await get().computeUnreadCounts()

    // Push to hub in background
    hubFetch('/feeds/read', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ add: [id] }),
    }).catch(() => {})
  },

  markUnread: async (itemId) => {
    await db.feedRead.delete(itemId)
    await get().loadItemsFromDb()
    await get().computeUnreadCounts()

    hubFetch('/feeds/read', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ remove: [itemId] }),
    }).catch(() => {})
  },

  markFeedRead: async (feedId) => {
    const feedItems = await db.feedItems.where('feedId').equals(feedId).toArray()
    const readSet = new Set((await db.feedRead.toArray()).map((r) => r.itemId))
    const toMark = feedItems.filter((i) => !readSet.has(i.id)).map((i) => i.id)

    if (toMark.length > 0) {
      await db.feedRead.bulkPut(toMark.map((id) => ({ itemId: id })))
      await get().loadItemsFromDb()
      await get().computeUnreadCounts()

      hubFetch('/feeds/read', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ add: toMark }),
      }).catch(() => {})
    }
  },

  markFolderRead: async (folder) => {
    const folderFeedIds = get().feeds.filter((f) => f.folder === folder).map((f) => f.id)
    if (folderFeedIds.length === 0) return

    const feedItems = await db.feedItems.where('feedId').anyOf(folderFeedIds).toArray()
    const readSet = new Set((await db.feedRead.toArray()).map((r) => r.itemId))
    const toMark = feedItems.filter((i) => !readSet.has(i.id)).map((i) => i.id)

    if (toMark.length > 0) {
      await db.feedRead.bulkPut(toMark.map((id) => ({ itemId: id })))
      await get().loadItemsFromDb()
      await get().computeUnreadCounts()

      hubFetch('/feeds/read', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ add: toMark }),
      }).catch(() => {})
    }
  },

  toggleFolder: (folder) => set((s) => {
    const next = new Set(s.expandedFolders)
    if (next.has(folder)) next.delete(folder)
    else next.add(folder)
    return { expandedFolders: next }
  }),

  toggleUnreadOnly: () => {
    set((s) => ({ showUnreadOnly: !s.showUnreadOnly }))
    get().loadItemsFromDb()
  },

  setSearchQuery: (q) => {
    set({ searchQuery: q })
    get().loadItemsFromDb()
  },

  addFeed: async (xmlUrl, folder, fullText) => {
    try {
      const res = await hubFetch('/feeds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ xmlUrl, folder, fullText }),
      })
      if (res.ok) {
        await get().fetchFeeds()
        await get().refreshItems()
      }
    } catch {
      // Fail silently
    }
  },

  deleteFeed: async (feedId) => {
    try {
      const res = await hubFetch(`/feeds/${feedId}`, { method: 'DELETE' })
      if (res.ok) {
        // Remove items from IndexedDB
        const items = await db.feedItems.where('feedId').equals(feedId).toArray()
        const itemIds = items.map((i) => i.id)
        await db.feedItems.where('feedId').equals(feedId).delete()
        if (itemIds.length > 0) {
          await db.feedRead.bulkDelete(itemIds)
        }

        set((s) => ({
          feeds: s.feeds.filter((f) => f.id !== feedId),
          selectedFeedId: s.selectedFeedId === feedId ? null : s.selectedFeedId,
        }))
        await get().loadItemsFromDb()
        await get().computeUnreadCounts()
      }
    } catch {
      // Fail silently
    }
  },

  importOpml: async (file) => {
    try {
      const opmlXml = await file.text()
      const res = await hubFetch('/feeds/import-opml', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ opmlXml }),
      })
      if (res.ok) {
        await get().fetchFeeds()
        // Don't immediately refresh all — that would take a while with 170 feeds
      }
    } catch {
      // Fail silently
    }
  },

  openItemInBrowser: () => {
    const { items, selectedItemId } = get()
    const item = items.find((i) => i.id === selectedItemId)
    if (item?.link) {
      window.open(item.link, '_blank', 'noopener')
    }
  },

  loadItemsFromDb: async () => {
    const { selectedFeedId, selectedFolderId, feeds, showUnreadOnly, searchQuery } = get()

    // Determine which feed IDs to query
    let feedIds: string[] | null = null
    if (selectedFeedId) {
      feedIds = [selectedFeedId]
    } else if (selectedFolderId) {
      feedIds = feeds.filter((f) => f.folder === selectedFolderId).map((f) => f.id)
    }

    // Query IndexedDB
    let items: DbFeedItem[]
    if (feedIds && feedIds.length === 1) {
      items = await db.feedItems.where('feedId').equals(feedIds[0]!).reverse().sortBy('publishedAt')
    } else if (feedIds) {
      items = await db.feedItems.where('feedId').anyOf(feedIds).reverse().sortBy('publishedAt')
    } else {
      items = await db.feedItems.orderBy('publishedAt').reverse().toArray()
    }

    // Filter unread only (unread = NOT in read set)
    if (showUnreadOnly) {
      const readSet = new Set((await db.feedRead.toArray()).map((r) => r.itemId))
      items = items.filter((i) => !readSet.has(i.id))
    }

    // Filter by search
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      items = items.filter((i) =>
        i.title.toLowerCase().includes(q) ||
        i.contentSnippet.toLowerCase().includes(q) ||
        (i.author?.toLowerCase().includes(q) ?? false)
      )
    }

    // Limit to 200 items for performance
    items = items.slice(0, 200)

    set({ items })
  },

  computeUnreadCounts: async () => {
    const readSet = new Set((await db.feedRead.toArray()).map((r) => r.itemId))
    const allItems = await db.feedItems.toArray()

    const counts: Record<string, number> = {}
    let total = 0

    for (const item of allItems) {
      if (!readSet.has(item.id)) {
        counts[item.feedId] = (counts[item.feedId] || 0) + 1
        total++
      }
    }

    set({ unreadCounts: counts, totalUnread: total })
  },
}))

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

async function trimItems(feeds: FeedSubscription[]) {
  const MAX_PER_FEED = 50
  for (const feed of feeds) {
    const items = await db.feedItems
      .where('feedId')
      .equals(feed.id)
      .reverse()
      .sortBy('publishedAt')

    if (items.length > MAX_PER_FEED) {
      const toDelete = items.slice(MAX_PER_FEED).map((i) => i.id)
      await db.feedItems.bulkDelete(toDelete)
      // Also clean unread for deleted items
      await db.feedRead.bulkDelete(toDelete)
    }
  }
}
