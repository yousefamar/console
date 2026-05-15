import { useRef, useEffect, useMemo } from 'react'
import { useBookmarkStore, filterBookmarks } from '@/store/bookmarks'
import { useIsMobile } from '@/hooks/useMediaQuery'
import { usePullToRefresh } from '@/hooks/usePullToRefresh'
import { BookmarkListItem } from './BookmarkListItem'
import { BookmarkAddBar } from './BookmarkAddBar'
import { Search, Plus } from 'lucide-react'

export function BookmarkList() {
  const bookmarks = useBookmarkStore((s) => s.bookmarks)
  const searchQuery = useBookmarkStore((s) => s.searchQuery)
  const selectedTag = useBookmarkStore((s) => s.selectedTag)
  const setSearchQuery = useBookmarkStore((s) => s.setSearchQuery)
  const selectedBookmarkId = useBookmarkStore((s) => s.selectedBookmarkId)
  const enterTriageMode = useBookmarkStore((s) => s.enterTriageMode)
  const addMode = useBookmarkStore((s) => s.addMode)
  const enterAddMode = useBookmarkStore((s) => s.enterAddMode)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const isMobile = useIsMobile()

  usePullToRefresh(listRef, () => useBookmarkStore.getState().fetchBookmarks(), isMobile)

  const filtered = useMemo(
    () => filterBookmarks(bookmarks, searchQuery, selectedTag),
    [bookmarks, searchQuery, selectedTag],
  )

  // Scroll selected item into view
  useEffect(() => {
    if (!selectedBookmarkId || !listRef.current) return
    const el = listRef.current.querySelector(`[data-bookmark-id="${CSS.escape(selectedBookmarkId)}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedBookmarkId])

  const brokenCount = filtered.filter((b) => b.tags.includes('status/broken')).length

  // Show add mode UI instead of list
  if (addMode) {
    return <BookmarkAddBar />
  }

  return (
    <div className="flex flex-col h-full">
      {/* Search */}
      <div className="flex items-center border-b border-border px-2 py-1 gap-1.5">
        <Search size={11} className="text-text-tertiary flex-shrink-0" />
        <input
          ref={inputRef}
          type="search"
          data-bookmark-search
          placeholder="Search bookmarks..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="flex-1 bg-transparent text-xs text-text-primary placeholder:text-text-tertiary outline-none"
        />
        <button
          onClick={enterAddMode}
          className="p-0.5 text-text-tertiary hover:text-accent transition-colors"
          title="Add bookmark (a)"
        >
          <Plus size={12} />
        </button>
      </div>

      {/* Stats bar */}
      <div className="flex items-center justify-between border-b border-border px-2 py-0.5">
        <span className="text-[10px] text-text-tertiary">
          {filtered.length === bookmarks.length
            ? `${bookmarks.length} bookmarks`
            : `${filtered.length} of ${bookmarks.length}`}
          {brokenCount > 0 && ` · ${brokenCount} broken`}
          {selectedTag && (
            <button
              onClick={() => useBookmarkStore.getState().selectTag(null)}
              className="ml-1 text-accent hover:underline"
            >
              ×{selectedTag}
            </button>
          )}
        </span>
        <button
          onClick={enterTriageMode}
          className="text-[10px] text-text-tertiary hover:text-text-secondary transition-colors"
          title="Enter triage mode (m)"
        >
          triage
        </button>
      </div>

      {/* List */}
      <div ref={listRef} className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="px-3 py-8 text-center">
            <p className="text-xs text-text-tertiary">No bookmarks found</p>
          </div>
        ) : (
          filtered.map((bm) => (
            <BookmarkListItem
              key={bm.filename}
              bookmark={bm}
              selected={bm.filename === selectedBookmarkId}
            />
          ))
        )}
      </div>
    </div>
  )
}
