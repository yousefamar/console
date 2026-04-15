import { useRef, useEffect, useState, useMemo } from 'react'
import { useBookmarkStore } from '@/store/bookmarks'
import { X, Loader2, Check, Plus, Sparkles } from 'lucide-react'

export function BookmarkAddBar() {
  const addUrl = useBookmarkStore((s) => s.addUrl)
  const setAddUrl = useBookmarkStore((s) => s.setAddUrl)
  const addLoading = useBookmarkStore((s) => s.addLoading)
  const addPreview = useBookmarkStore((s) => s.addPreview)
  const addSuggestedTags = useBookmarkStore((s) => s.addSuggestedTags)
  const addSelectedTags = useBookmarkStore((s) => s.addSelectedTags)
  const fetchAddPreview = useBookmarkStore((s) => s.fetchAddPreview)
  const toggleAddTag = useBookmarkStore((s) => s.toggleAddTag)
  const addCustomTag = useBookmarkStore((s) => s.addCustomTag)
  const saveNewBookmark = useBookmarkStore((s) => s.saveNewBookmark)
  const exitAddMode = useBookmarkStore((s) => s.exitAddMode)
  const bookmarks = useBookmarkStore((s) => s.bookmarks)

  const inputRef = useRef<HTMLInputElement>(null)
  const [customTagInput, setCustomTagInput] = useState('')

  // All existing tags for autocomplete
  const allTags = useMemo(() => {
    const tags = new Set<string>()
    for (const bm of bookmarks) {
      for (const tag of bm.tags) {
        if (tag !== 'status/active') tags.add(tag)
      }
    }
    return [...tags].sort()
  }, [bookmarks])

  const tagSuggestions = useMemo(() => {
    if (!customTagInput) return []
    const q = customTagInput.toLowerCase()
    return allTags
      .filter((t) => t.toLowerCase().includes(q) && !addSelectedTags.includes(t))
      .slice(0, 6)
  }, [customTagInput, allTags, addSelectedTags])

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleSubmitUrl = () => {
    const url = addUrl.trim()
    if (!url) return
    // Auto-add protocol if missing
    const normalizedUrl = url.match(/^https?:\/\//) ? url : `https://${url}`
    fetchAddPreview(normalizedUrl)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (addPreview) {
        saveNewBookmark()
      } else {
        handleSubmitUrl()
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      exitAddMode()
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-2 py-1">
        <span className="text-[10px] text-text-tertiary font-medium uppercase tracking-wide">Add bookmark</span>
        <button
          onClick={exitAddMode}
          className="p-0.5 text-text-tertiary hover:text-text-secondary transition-colors"
        >
          <X size={12} />
        </button>
      </div>

      {/* URL input */}
      <div className="border-b border-border px-2 py-1.5">
        <div className="flex items-center gap-1.5">
          <input
            ref={inputRef}
            type="url"
            placeholder="Paste URL..."
            value={addUrl}
            onChange={(e) => setAddUrl(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={addLoading}
            className="flex-1 bg-transparent text-xs text-text-primary placeholder:text-text-tertiary outline-none disabled:opacity-50"
          />
          {addLoading ? (
            <Loader2 size={12} className="text-text-tertiary animate-spin" />
          ) : !addPreview ? (
            <button
              onClick={handleSubmitUrl}
              disabled={!addUrl.trim()}
              className="text-[10px] text-accent hover:text-accent/80 disabled:opacity-30 transition-colors"
            >
              Fetch
            </button>
          ) : null}
        </div>
      </div>

      {/* Preview + tags */}
      {addPreview && (
        <div className="flex-1 overflow-y-auto px-2 py-2 space-y-2">
          {/* Metadata preview */}
          <div>
            <div className="text-xs text-text-primary font-medium leading-tight">
              {addPreview.title}
            </div>
            {addPreview.description && (
              <div className="text-[10px] text-text-tertiary leading-relaxed mt-0.5 line-clamp-3">
                {addPreview.description}
              </div>
            )}
            <div className="text-[10px] text-accent truncate mt-0.5">
              {addPreview.url}
            </div>
          </div>

          {/* Tags section */}
          <div>
            <div className="flex items-center gap-1 mb-1">
              <span className="text-[10px] text-text-tertiary">Tags</span>
              {addSuggestedTags.length > 0 && (
                <span className="flex items-center gap-0.5 text-[9px] text-accent/70">
                  <Sparkles size={8} />
                  AI suggested
                </span>
              )}
              {addLoading && addSuggestedTags.length === 0 && (
                <Loader2 size={8} className="text-text-tertiary animate-spin" />
              )}
            </div>

            {/* Selected tags */}
            <div className="flex flex-wrap gap-1 mb-1.5">
              {addSelectedTags.filter((t) => t !== 'status/active').map((tag) => (
                <button
                  key={tag}
                  onClick={() => toggleAddTag(tag)}
                  className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-sm text-[10px] bg-accent/15 text-accent transition-colors hover:bg-accent/25"
                >
                  {tag}
                  <X size={8} />
                </button>
              ))}
            </div>

            {/* Suggested but not selected */}
            {addSuggestedTags.filter((t) => !addSelectedTags.includes(t) && t !== 'status/active').length > 0 && (
              <div className="flex flex-wrap gap-1 mb-1.5">
                {addSuggestedTags
                  .filter((t) => !addSelectedTags.includes(t) && t !== 'status/active')
                  .map((tag) => (
                    <button
                      key={tag}
                      onClick={() => toggleAddTag(tag)}
                      className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-sm text-[10px] bg-surface-2 text-text-tertiary transition-colors hover:bg-surface-3"
                    >
                      <Plus size={8} />
                      {tag}
                    </button>
                  ))}
              </div>
            )}

            {/* Custom tag input */}
            <div className="relative">
              <input
                type="text"
                placeholder="Add tag..."
                value={customTagInput}
                onChange={(e) => setCustomTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && customTagInput) {
                    e.preventDefault()
                    e.stopPropagation()
                    if (tagSuggestions.length > 0) {
                      addCustomTag(tagSuggestions[0]!)
                    } else {
                      addCustomTag(customTagInput)
                    }
                    setCustomTagInput('')
                  }
                  if (e.key === 'Escape') {
                    setCustomTagInput('')
                  }
                }}
                className="w-full px-1.5 py-1 text-[10px] bg-surface-1 border border-border rounded-sm text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent"
              />
              {tagSuggestions.length > 0 && customTagInput && (
                <div className="absolute top-full left-0 right-0 mt-0.5 bg-surface-1 border border-border rounded-sm shadow-sm z-10 max-h-32 overflow-y-auto">
                  {tagSuggestions.map((tag) => (
                    <button
                      key={tag}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        addCustomTag(tag)
                        setCustomTagInput('')
                      }}
                      className="w-full text-left px-1.5 py-1 text-[10px] text-text-secondary hover:bg-surface-2 transition-colors"
                    >
                      {tag}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Save button */}
          <button
            onClick={saveNewBookmark}
            className="flex items-center justify-center gap-1 w-full px-2 py-1.5 text-[10px] font-medium bg-accent text-white rounded-sm hover:bg-accent/90 transition-colors"
          >
            <Check size={10} />
            Save bookmark
          </button>
        </div>
      )}

      {/* Empty state when no preview yet */}
      {!addPreview && !addLoading && (
        <div className="flex-1 flex items-center justify-center px-4">
          <p className="text-[10px] text-text-tertiary text-center">
            Paste a URL and press Enter.<br />
            Metadata and tags will be suggested automatically.
          </p>
        </div>
      )}

      {/* Loading state */}
      {addLoading && !addPreview && (
        <div className="flex-1 flex items-center justify-center gap-2">
          <Loader2 size={14} className="text-text-tertiary animate-spin" />
          <span className="text-[10px] text-text-tertiary">Fetching page info...</span>
        </div>
      )}
    </div>
  )
}
