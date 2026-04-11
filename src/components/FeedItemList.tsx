import { useRef, useEffect } from 'react'
import { useFeedStore } from '@/store/feeds'
import { useIsMobile } from '@/hooks/useMediaQuery'
import { FeedItemListEntry } from './FeedItemListEntry'
import { SwipeableRow } from './SwipeableRow'
import { Search, Eye, EyeOff, Check } from 'lucide-react'

export function FeedItemList() {
  const items = useFeedStore((s) => s.items)
  const selectedItemId = useFeedStore((s) => s.selectedItemId)
  const searchQuery = useFeedStore((s) => s.searchQuery)
  const showUnreadOnly = useFeedStore((s) => s.showUnreadOnly)
  const setSearchQuery = useFeedStore((s) => s.setSearchQuery)
  const toggleUnreadOnly = useFeedStore((s) => s.toggleUnreadOnly)
  const selectItem = useFeedStore((s) => s.selectItem)
  const selectedFeedId = useFeedStore((s) => s.selectedFeedId)
  const selectedFolderId = useFeedStore((s) => s.selectedFolderId)
  const feeds = useFeedStore((s) => s.feeds)

  const markRead = useFeedStore((s) => s.markRead)
  const isMobile = useIsMobile()
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  // Scroll selected item into view
  useEffect(() => {
    if (!selectedItemId || !listRef.current) return
    const el = listRef.current.querySelector(`[data-item-id="${selectedItemId}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedItemId])

  // Derive header title
  let title = 'All Feeds'
  if (selectedFeedId) {
    const feed = feeds.find((f) => f.id === selectedFeedId)
    title = feed?.title || 'Feed'
  } else if (selectedFolderId) {
    title = selectedFolderId
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Header */}
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-border">
        <span className="text-xs font-medium text-text-primary truncate flex-1">{title}</span>
        <button
          onClick={toggleUnreadOnly}
          className="text-text-tertiary hover:text-text-secondary transition-colors"
          title={showUnreadOnly ? 'Show all' : 'Show unread only'}
        >
          {showUnreadOnly ? <EyeOff size={12} /> : <Eye size={12} />}
        </button>
      </div>

      {/* Search */}
      <div className="relative px-2 py-1 border-b border-border">
        <Search size={11} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-text-tertiary" />
        <input
          ref={searchRef}
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search articles..."
          data-feed-search
          className="w-full bg-transparent text-xs text-text-primary placeholder:text-text-tertiary pl-5 py-0.5 outline-none"
        />
      </div>

      {/* Items */}
      <div ref={listRef} className="flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <span className="text-xs text-text-tertiary">
              {showUnreadOnly ? 'No unread articles' : 'No articles'}
            </span>
          </div>
        ) : (
          items.map((item) => (
            isMobile ? (
              <SwipeableRow
                key={item.id}
                right={{ icon: <Check size={20} className="text-green-500" />, color: '34, 197, 94', onTrigger: () => markRead(item.id) }}
              >
                <FeedItemListEntry item={item} isSelected={item.id === selectedItemId} onClick={() => selectItem(item.id)} />
              </SwipeableRow>
            ) : (
              <FeedItemListEntry key={item.id} item={item} isSelected={item.id === selectedItemId} onClick={() => selectItem(item.id)} />
            )
          ))
        )}
      </div>
    </div>
  )
}
