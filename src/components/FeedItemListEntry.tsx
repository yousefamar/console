import { useFeedStore, type FeedItem } from '@/store/feeds'

export function FeedItemListEntry({ item, isSelected, onClick }: {
  item: FeedItem
  isSelected: boolean
  onClick: () => void
}) {
  const feeds = useFeedStore((s) => s.feeds)
  const feed = feeds.find((f) => f.id === item.feedId)

  return (
    <button
      data-item-id={item.id}
      onClick={onClick}
      className={`w-full text-left px-2 py-1.5 border-b border-border transition-colors ${
        isSelected ? 'bg-surface-2' : 'hover:bg-surface-1'
      }`}
    >
      <div className="flex items-start gap-1.5">
        <div className="flex-1 min-w-0">
          <div className="text-xs text-text-primary truncate leading-tight">
            {item.title}
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            {feed && (
              <span className="text-[10px] text-text-tertiary truncate max-w-[120px]">
                {feed.title}
              </span>
            )}
            {item.author && (
              <span className="text-[10px] text-text-tertiary truncate max-w-[80px]">
                {item.author}
              </span>
            )}
          </div>
          {item.contentSnippet && (
            <div className="text-[10px] text-text-tertiary mt-0.5 line-clamp-2 leading-tight">
              {item.contentSnippet}
            </div>
          )}
        </div>
        <span className="text-[10px] text-text-tertiary whitespace-nowrap flex-shrink-0">
          {formatRelativeDate(item.publishedAt)}
        </span>
      </div>
    </button>
  )
}

function formatRelativeDate(isoDate: string): string {
  const date = new Date(isoDate)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  const diffHr = Math.floor(diffMs / 3600000)
  const diffDay = Math.floor(diffMs / 86400000)

  if (diffMin < 1) return 'now'
  if (diffMin < 60) return `${diffMin}m`
  if (diffHr < 24) return `${diffHr}h`
  if (diffDay < 7) return `${diffDay}d`
  if (diffDay < 365) return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}
