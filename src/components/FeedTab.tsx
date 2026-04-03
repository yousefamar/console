import { useEffect } from 'react'
import { useFeedStore } from '@/store/feeds'
import { useIsMobile } from '@/hooks/useMediaQuery'
import { FeedFolderTree } from './FeedFolderTree'
import { FeedItemList } from './FeedItemList'
import { FeedItemView } from './FeedItemView'
import { FeedAddModal } from './FeedAddModal'
import { Rss } from 'lucide-react'

export function FeedTab() {
  const feeds = useFeedStore((s) => s.feeds)
  const loading = useFeedStore((s) => s.loading)
  const connected = useFeedStore((s) => s.connected)
  const selectedItemId = useFeedStore((s) => s.selectedItemId)
  const showAddModal = useFeedStore((s) => s.showAddModal)
  const fetchFeeds = useFeedStore((s) => s.fetchFeeds)
  const refreshItems = useFeedStore((s) => s.refreshItems)
  const loadItemsFromDb = useFeedStore((s) => s.loadItemsFromDb)
  const computeUnreadCounts = useFeedStore((s) => s.computeUnreadCounts)
  const isMobile = useIsMobile()

  useEffect(() => {
    fetchFeeds().then(async () => {
      await loadItemsFromDb()
      await computeUnreadCounts()
      // Background refresh
      refreshItems()
    })
  }, [])

  if (!connected && !loading && feeds.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center px-4">
        <Rss size={24} className="text-text-tertiary" />
        <p className="text-sm text-text-secondary">Feed Reader</p>
        <p className="text-xs text-text-tertiary max-w-xs">
          Subscribe to RSS/Atom feeds. Import an OPML file or add feeds manually.
          Requires the console server to be running.
        </p>
        <button
          onClick={() => useFeedStore.getState().setShowAddModal(true)}
          className="mt-1 px-3 py-1.5 text-xs font-medium bg-surface-2 text-text-primary rounded-sm hover:bg-surface-1 border border-border transition-colors"
        >
          Import OPML or Add Feed
        </button>
        {showAddModal && <FeedAddModal />}
      </div>
    )
  }

  if (loading && feeds.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <span className="text-xs text-text-tertiary">Loading feeds...</span>
      </div>
    )
  }

  if (isMobile) {
    return (
      <div className="flex flex-1 min-h-0 flex-col">
        {selectedItemId ? <FeedItemView /> : <FeedItemList />}
        {showAddModal && <FeedAddModal />}
      </div>
    )
  }

  return (
    <div className="flex flex-1 min-h-0">
      <div className="w-44 flex-shrink-0 border-r border-border overflow-y-auto">
        <FeedFolderTree />
      </div>
      <div className="w-72 flex-shrink-0 border-r border-border overflow-hidden flex flex-col">
        <FeedItemList />
      </div>
      <div className="flex-1 min-w-0 overflow-hidden flex flex-col">
        <FeedItemView />
      </div>
      {showAddModal && <FeedAddModal />}
    </div>
  )
}
