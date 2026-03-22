import { useState, useRef, useMemo, useEffect } from 'react'
import { useBookmarkStore, filterBookmarks } from '@/store/bookmarks'
import { ExternalLink, X } from 'lucide-react'
import { useIsMobile } from '@/hooks/useMediaQuery'

export function BookmarkTriageView() {
  const bookmarks = useBookmarkStore((s) => s.bookmarks)
  const searchQuery = useBookmarkStore((s) => s.searchQuery)
  const selectedTag = useBookmarkStore((s) => s.selectedTag)
  const triageIndex = useBookmarkStore((s) => s.triageIndex)
  const triageKeep = useBookmarkStore((s) => s.triageKeep)
  const triageSkip = useBookmarkStore((s) => s.triageSkip)
  const triageDelete = useBookmarkStore((s) => s.triageDelete)
  const exitTriageMode = useBookmarkStore((s) => s.exitTriageMode)
  const updateBookmarkTags = useBookmarkStore((s) => s.updateBookmarkTags)
  const selectedBookmarkBody = useBookmarkStore((s) => s.selectedBookmarkBody)
  const selectBookmark = useBookmarkStore((s) => s.selectBookmark)
  const isMobile = useIsMobile()

  const filtered = useMemo(
    () => filterBookmarks(bookmarks, searchQuery, selectedTag),
    [bookmarks, searchQuery, selectedTag],
  )

  // Fetch body for current triage item
  const currentFilename = filtered[triageIndex]?.filename
  useEffect(() => {
    if (currentFilename) selectBookmark(currentFilename)
  }, [currentFilename])

  const current = filtered[triageIndex]

  if (!current) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3">
        <p className="text-sm text-text-primary font-medium">All done!</p>
        <p className="text-xs text-text-tertiary">Reviewed all bookmarks in this queue.</p>
        <button
          onClick={exitTriageMode}
          className="text-xs text-accent hover:underline"
        >
          Back to browse
        </button>
      </div>
    )
  }

  const progress = filtered.length > 0
    ? ((triageIndex + 1) / filtered.length) * 100
    : 0

  let domain = ''
  try {
    domain = new URL(current.url).hostname.replace(/^www\./, '')
  } catch {
    domain = current.url
  }

  return (
    <div className={`flex flex-1 min-h-0 ${isMobile ? 'flex-col' : ''}`}>
      {/* Card area */}
      <div className={`flex flex-col ${isMobile ? 'flex-1' : 'w-1/2 border-r border-border'} min-h-0`}>
        {/* Progress bar */}
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border">
          <div className="flex-1 h-1 bg-surface-2 rounded-full overflow-hidden">
            <div
              className="h-full bg-accent rounded-full transition-all duration-normal"
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="text-[10px] text-text-tertiary flex-shrink-0">
            {triageIndex + 1} / {filtered.length}
          </span>
          <button
            onClick={exitTriageMode}
            className="text-text-tertiary hover:text-text-secondary transition-colors"
            title="Exit triage (Esc)"
          >
            <X size={12} />
          </button>
        </div>

        {/* Bookmark card */}
        <div className="flex-1 overflow-y-auto p-4">
          <h2 className="text-base font-semibold text-text-primary leading-tight mb-1">
            {current.title}
          </h2>

          <a
            href={current.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-accent hover:underline break-all block mb-2"
          >
            {domain}
            <ExternalLink size={10} className="inline ml-1" />
          </a>

          {current.description && (
            <p className="text-xs text-text-secondary leading-relaxed mb-3">
              {current.description}
            </p>
          )}

          {/* Tags (editable) */}
          <TriageTagEditor
            filename={current.filename}
            tags={current.tags}
            bookmarks={bookmarks}
            onUpdate={updateBookmarkTags}
          />

          {/* Notes/body */}
          {selectedBookmarkBody && (
            <div className="border-t border-border pt-2 mt-3">
              <p className="text-[10px] text-text-tertiary mb-1">Notes</p>
              <div className="text-xs text-text-secondary whitespace-pre-wrap leading-relaxed">
                {selectedBookmarkBody}
              </div>
            </div>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex border-t border-border">
          <button
            onClick={() => triageDelete()}
            className="flex-1 py-2 text-xs font-medium text-destructive hover:bg-destructive/10 transition-colors border-r border-border"
          >
            Delete <span className="text-text-tertiary ml-1 font-mono text-[10px]">d</span>
          </button>
          <button
            onClick={triageSkip}
            className="flex-1 py-2 text-xs font-medium text-text-secondary hover:bg-surface-1 transition-colors border-r border-border"
          >
            Skip <span className="text-text-tertiary ml-1 font-mono text-[10px]">s</span>
          </button>
          <button
            onClick={triageKeep}
            className="flex-1 py-2 text-xs font-medium text-success hover:bg-success/10 transition-colors"
          >
            Keep <span className="text-text-tertiary ml-1 font-mono text-[10px]">e</span>
          </button>
        </div>
      </div>

      {/* Persistent iframe pool (desktop only) */}
      {!isMobile && (
        <TriageIframePool
          filtered={filtered}
          triageIndex={triageIndex}
          currentUrl={current.url}
        />
      )}
    </div>
  )
}

// --------------------------------------------------------------------------
// Persistent iframe pool for triage — keeps loaded iframes alive
// --------------------------------------------------------------------------

function TriageIframePool({
  filtered,
  triageIndex,
  currentUrl,
}: {
  filtered: { url: string; filename: string }[]
  triageIndex: number
  currentUrl: string
}) {
  const [pool, setPool] = useState<Array<{ url: string }>>([])

  useEffect(() => {
    // Preload current + next 2
    const end = Math.min(filtered.length, triageIndex + 3)
    const toPreload = filtered.slice(triageIndex, end)

    setPool((prev) => {
      const existing = new Set(prev.map((p) => p.url))
      const newEntries = toPreload.filter((bm) => !existing.has(bm.url))
      if (newEntries.length === 0) return prev
      const merged = [...prev, ...newEntries.map((bm) => ({ url: bm.url }))]
      // Cap at 20 — keep most recent
      return merged.length > 20 ? merged.slice(-20) : merged
    })
  }, [triageIndex, filtered])

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center justify-between px-3 py-1 border-b border-border bg-surface-1">
        <span className="text-[10px] text-text-tertiary truncate">{currentUrl}</span>
        <a
          href={currentUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[10px] text-text-tertiary hover:text-text-secondary flex-shrink-0 ml-2"
        >
          <ExternalLink size={10} />
        </a>
      </div>
      <div className="flex-1 relative">
        {pool.map((entry) => (
          <iframe
            key={entry.url}
            src={entry.url}
            className="absolute inset-0 w-full h-full bg-white"
            style={{ display: entry.url === currentUrl ? 'block' : 'none' }}
            sandbox="allow-scripts allow-same-origin"
            title="Bookmark preview"
          />
        ))}
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------
// Inline tag editor for triage mode
// --------------------------------------------------------------------------

function TriageTagEditor({
  filename,
  tags,
  bookmarks,
  onUpdate,
}: {
  filename: string
  tags: string[]
  bookmarks: { tags: string[] }[]
  onUpdate: (filename: string, tags: string[]) => Promise<void>
}) {
  const [inputValue, setInputValue] = useState('')
  const [showSuggestions, setShowSuggestions] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const allTags = useMemo(() => {
    const set = new Set<string>()
    for (const bm of bookmarks) for (const t of bm.tags) set.add(t)
    return [...set].sort()
  }, [bookmarks])

  const suggestions = useMemo(() => {
    if (!inputValue) return []
    const q = inputValue.toLowerCase()
    return allTags.filter((t) => t.toLowerCase().includes(q) && !tags.includes(t)).slice(0, 8)
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
      <div className="flex flex-wrap gap-1 mb-2">
        {tags.map((tag) => (
          <span
            key={tag}
            className={`
              inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-[10px]
              ${tag === 'status/broken' ? 'bg-destructive/15 text-destructive' : 'bg-surface-2 text-text-secondary'}
            `}
          >
            {tag}
            <button onClick={() => removeTag(tag)} className="opacity-50 hover:opacity-100">
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
          placeholder="Add tag... (t)"
          value={inputValue}
          onChange={(e) => { setInputValue(e.target.value); setShowSuggestions(true) }}
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
          className="w-full px-2 py-1 text-xs bg-surface-1 border border-border rounded-sm text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent"
        />
        {showSuggestions && suggestions.length > 0 && (
          <div className="absolute top-full left-0 right-0 mt-0.5 bg-surface-1 border border-border rounded-sm shadow-sm z-10 max-h-32 overflow-y-auto">
            {suggestions.map((tag) => (
              <button
                key={tag}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => addTag(tag)}
                className="w-full text-left px-2 py-1 text-[10px] text-text-secondary hover:bg-surface-2"
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
