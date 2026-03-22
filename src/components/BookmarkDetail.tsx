import { useState, useRef, useMemo, useEffect } from 'react'
import { useBookmarkStore, filterBookmarks } from '@/store/bookmarks'
import { ExternalLink, Trash2, Archive, X, ChevronLeft } from 'lucide-react'
import { useIsMobile } from '@/hooks/useMediaQuery'

// Max iframes to keep alive in the pool (prevents memory bloat)
const MAX_POOL_SIZE = 20
// How many to preload ahead/behind
const PRELOAD_AHEAD = 2

export function BookmarkDetail() {
  const bookmarks = useBookmarkStore((s) => s.bookmarks)
  const selectedBookmarkId = useBookmarkStore((s) => s.selectedBookmarkId)
  const selectedBookmarkBody = useBookmarkStore((s) => s.selectedBookmarkBody)
  const searchQuery = useBookmarkStore((s) => s.searchQuery)
  const selectedTag = useBookmarkStore((s) => s.selectedTag)
  const updateBookmarkTags = useBookmarkStore((s) => s.updateBookmarkTags)
  const deleteBookmark = useBookmarkStore((s) => s.deleteBookmark)
  const openBookmarkUrl = useBookmarkStore((s) => s.openBookmarkUrl)
  const selectBookmark = useBookmarkStore((s) => s.selectBookmark)
  const isMobile = useIsMobile()

  const allTags = useAllTags()

  const filtered = useMemo(
    () => filterBookmarks(bookmarks, searchQuery, selectedTag),
    [bookmarks, searchQuery, selectedTag],
  )

  // Persistent iframe pool — only grows (up to MAX_POOL_SIZE), never shrinks on navigate
  // Each entry: { url, filename } — keyed by url to avoid duplicates
  const [iframePool, setIframePool] = useState<Array<{ url: string; filename: string }>>([])

  useEffect(() => {
    if (!selectedBookmarkId) return
    const idx = filtered.findIndex((b) => b.filename === selectedBookmarkId)
    if (idx < 0) return

    // Gather URLs to preload: selected + PRELOAD_AHEAD in each direction
    const start = Math.max(0, idx - PRELOAD_AHEAD)
    const end = Math.min(filtered.length, idx + PRELOAD_AHEAD + 1)
    const toPreload = filtered.slice(start, end)

    setIframePool((prev) => {
      const existing = new Set(prev.map((p) => p.url))
      const newEntries = toPreload.filter((bm) => !existing.has(bm.url))
      if (newEntries.length === 0) return prev

      const merged = [...prev, ...newEntries.map((bm) => ({ url: bm.url, filename: bm.filename }))]
      // Evict oldest entries if over limit, but never evict the current selection
      if (merged.length > MAX_POOL_SIZE) {
        const currentUrl = filtered[idx]?.url
        const kept: typeof merged = []
        // Keep the most recent entries (end of array) and always keep current
        for (let i = merged.length - 1; i >= 0 && kept.length < MAX_POOL_SIZE; i--) {
          kept.unshift(merged[i]!)
        }
        // Ensure current is in there
        if (currentUrl && !kept.some((e) => e.url === currentUrl)) {
          const current = merged.find((e) => e.url === currentUrl)
          if (current) {
            kept.pop()
            kept.unshift(current)
          }
        }
        return kept
      }
      return merged
    })
  }, [selectedBookmarkId, filtered])

  // Clear pool when filters change substantially
  const filterKey = `${searchQuery}|${selectedTag ?? ''}`
  const prevFilterKey = useRef(filterKey)
  useEffect(() => {
    if (prevFilterKey.current !== filterKey) {
      prevFilterKey.current = filterKey
      setIframePool([])
    }
  }, [filterKey])

  const bookmark = bookmarks.find((b) => b.filename === selectedBookmarkId)
  const selectedUrl = bookmark?.url

  if (!bookmark) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-xs text-text-tertiary">Select a bookmark</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Metadata section */}
      <div className="flex-shrink-0 overflow-y-auto p-3 space-y-2 max-h-[40%]">
        {isMobile && (
          <button
            onClick={() => selectBookmark(null)}
            className="flex items-center gap-1 text-xs text-text-tertiary hover:text-text-secondary -ml-1"
          >
            <ChevronLeft size={14} />
            <span>Back</span>
          </button>
        )}

        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-text-primary leading-tight">
              {bookmark.title}
            </h2>
            <a
              href={bookmark.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-accent hover:underline break-all leading-tight mt-0.5 block"
            >
              {bookmark.url}
            </a>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              onClick={openBookmarkUrl}
              className="p-1 text-text-tertiary hover:text-text-secondary transition-colors"
              title="Open in new tab (o)"
            >
              <ExternalLink size={13} />
            </button>
            <button
              onClick={() => deleteBookmark()}
              className="p-1 text-text-tertiary hover:text-destructive transition-colors"
              title="Delete bookmark (d)"
            >
              <Trash2 size={13} />
            </button>
          </div>
        </div>

        {bookmark.description && (
          <p className="text-xs text-text-secondary leading-relaxed">
            {bookmark.description}
          </p>
        )}

        {bookmark.archive && (
          <a
            href={bookmark.archive}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-[10px] text-text-tertiary hover:text-text-secondary"
          >
            <Archive size={10} />
            <span>Archive snapshot</span>
          </a>
        )}

        {bookmark.added && (
          <p className="text-[10px] text-text-tertiary">
            Added {formatDate(bookmark.added)}
          </p>
        )}

        <TagEditor
          key={bookmark.filename}
          filename={bookmark.filename}
          tags={bookmark.tags}
          allTags={allTags}
          onUpdate={updateBookmarkTags}
        />

        {selectedBookmarkBody && (
          <div className="border-t border-border pt-2">
            <p className="text-[10px] text-text-tertiary mb-1">Notes</p>
            <div className="text-xs text-text-secondary whitespace-pre-wrap leading-relaxed">
              {selectedBookmarkBody}
            </div>
          </div>
        )}
      </div>

      {/* Persistent iframe pool — iframes stay mounted, visibility toggled */}
      {!isMobile && (
        <div className="flex-1 min-h-0 border-t border-border relative">
          {iframePool.map((entry) => (
            <iframe
              key={entry.url}
              src={entry.url}
              className="absolute inset-0 w-full h-full bg-white"
              style={{ display: entry.url === selectedUrl ? 'block' : 'none' }}
              sandbox="allow-scripts allow-same-origin"
              title="Bookmark preview"
            />
          ))}
        </div>
      )}
    </div>
  )
}

// --------------------------------------------------------------------------
// Tag Editor
// --------------------------------------------------------------------------

function TagEditor({
  filename,
  tags,
  allTags,
  onUpdate,
}: {
  filename: string
  tags: string[]
  allTags: string[]
  onUpdate: (filename: string, tags: string[]) => Promise<void>
}) {
  const [inputValue, setInputValue] = useState('')
  const [showSuggestions, setShowSuggestions] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const suggestions = useMemo(() => {
    if (!inputValue) return []
    const q = inputValue.toLowerCase()
    return allTags
      .filter((t) => t.toLowerCase().includes(q) && !tags.includes(t))
      .slice(0, 8)
  }, [inputValue, allTags, tags])

  const addTag = (tag: string) => {
    if (!tag || tags.includes(tag)) return
    onUpdate(filename, [...tags, tag])
    setInputValue('')
    setShowSuggestions(false)
  }

  const removeTag = (tag: string) => {
    onUpdate(filename, tags.filter((t) => t !== tag))
  }

  return (
    <div>
      <p className="text-[10px] text-text-tertiary mb-1">Tags</p>
      <div className="flex flex-wrap gap-1 mb-1.5">
        {tags.map((tag) => (
          <span
            key={tag}
            className={`
              inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-sm text-[10px]
              ${tag === 'status/broken'
                ? 'bg-destructive/15 text-destructive'
                : 'bg-surface-2 text-text-secondary'
              }
            `}
          >
            {tag}
            <button
              onClick={() => removeTag(tag)}
              className="text-text-tertiary hover:text-text-primary transition-colors ml-0.5"
            >
              <X size={8} />
            </button>
          </span>
        ))}
      </div>
      <div className="relative">
        <input
          ref={inputRef}
          data-bookmark-tag-input
          type="text"
          placeholder="Add tag..."
          value={inputValue}
          onChange={(e) => {
            setInputValue(e.target.value)
            setShowSuggestions(true)
          }}
          onFocus={() => setShowSuggestions(true)}
          onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              if (suggestions.length > 0) addTag(suggestions[0]!)
              else if (inputValue) addTag(inputValue)
            }
            if (e.key === 'Escape') {
              setShowSuggestions(false)
              inputRef.current?.blur()
            }
          }}
          className="w-full px-1.5 py-1 text-[10px] bg-surface-1 border border-border rounded-sm text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent"
        />
        {showSuggestions && suggestions.length > 0 && (
          <div className="absolute top-full left-0 right-0 mt-0.5 bg-surface-1 border border-border rounded-sm shadow-sm z-10 max-h-32 overflow-y-auto">
            {suggestions.map((tag) => (
              <button
                key={tag}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => addTag(tag)}
                className="w-full text-left px-1.5 py-1 text-[10px] text-text-secondary hover:bg-surface-2 transition-colors"
              >
                {tag}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function useAllTags(): string[] {
  const bookmarks = useBookmarkStore((s) => s.bookmarks)
  return useMemo(() => {
    const tags = new Set<string>()
    for (const bm of bookmarks) {
      for (const tag of bm.tags) tags.add(tag)
    }
    return [...tags].sort()
  }, [bookmarks])
}

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr)
    if (isNaN(d.getTime())) return dateStr
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  } catch {
    return dateStr
  }
}
