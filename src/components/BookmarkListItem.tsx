import { useBookmarkStore, type Bookmark } from '@/store/bookmarks'

interface Props {
  bookmark: Bookmark
  selected: boolean
}

export function BookmarkListItem({ bookmark, selected }: Props) {
  const selectBookmark = useBookmarkStore((s) => s.selectBookmark)
  const isBroken = bookmark.tags.includes('status/broken')

  // Extract domain from URL
  let domain = ''
  try {
    domain = new URL(bookmark.url).hostname.replace(/^www\./, '')
  } catch {
    domain = bookmark.url
  }

  return (
    <div
      data-bookmark-id={bookmark.filename}
      onClick={() => selectBookmark(bookmark.filename)}
      className={`
        px-2 py-1.5 cursor-pointer border-b border-border transition-colors duration-fast
        ${selected ? 'bg-surface-2' : 'hover:bg-surface-1'}
        ${isBroken ? 'border-l-2 border-l-destructive' : ''}
      `}
    >
      {/* Title */}
      <div className="text-xs text-text-primary truncate font-medium leading-tight">
        {bookmark.title}
      </div>

      {/* Domain */}
      <div className="text-[10px] text-text-tertiary truncate mt-0.5">
        {domain}
      </div>

      {/* Description (one line) */}
      {bookmark.description && (
        <div className="text-[10px] text-text-tertiary truncate mt-0.5 leading-tight">
          {bookmark.description}
        </div>
      )}

      {/* Tags (compact) */}
      {bookmark.tags.length > 0 && (
        <div className="flex flex-wrap gap-0.5 mt-1">
          {bookmark.tags.filter((t) => t !== 'status/active').slice(0, 4).map((tag) => (
            <span
              key={tag}
              className={`
                inline-block px-1 py-0 rounded-sm text-[9px] leading-relaxed
                ${tag === 'status/broken'
                  ? 'bg-destructive/15 text-destructive'
                  : 'bg-surface-2 text-text-tertiary'
                }
              `}
            >
              {tag.includes('/') ? tag.split('/').pop() : tag}
            </span>
          ))}
          {bookmark.tags.filter((t) => t !== 'status/active').length > 4 && (
            <span className="text-[9px] text-text-tertiary">
              +{bookmark.tags.filter((t) => t !== 'status/active').length - 4}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
