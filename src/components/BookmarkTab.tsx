import { memo, useEffect } from 'react'
import { useBookmarkStore } from '@/store/bookmarks'
import { BookmarkList } from './BookmarkList'
import { BookmarkDetail } from './BookmarkDetail'
import { BookmarkTriageView } from './BookmarkTriageView'
import { BookmarkTagTree } from './BookmarkTagTree'
import { useIsMobile } from '@/hooks/useMediaQuery'

export const BookmarkTab = memo(function BookmarkTab() {
  const connected = useBookmarkStore((s) => s.connected)
  const loading = useBookmarkStore((s) => s.loading)
  const bookmarks = useBookmarkStore((s) => s.bookmarks)
  const fetchBookmarks = useBookmarkStore((s) => s.fetchBookmarks)
  const triageMode = useBookmarkStore((s) => s.triageMode)
  const selectedBookmarkId = useBookmarkStore((s) => s.selectedBookmarkId)
  const isMobile = useIsMobile()

  // Fetch bookmarks on mount (only once — hub caches them)
  useEffect(() => {
    if (bookmarks.length === 0 && !loading) {
      fetchBookmarks()
    }
  }, [])

  if (loading && bookmarks.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-text-secondary">Loading bookmarks...</p>
      </div>
    )
  }

  if (!connected && bookmarks.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center px-4">
        <p className="text-sm text-text-secondary">Bookmarks not available</p>
        <p className="text-xs text-text-tertiary max-w-xs">
          Start the server to browse bookmarks:
        </p>
        <pre className="text-xs font-mono bg-surface-2 px-3 py-2 rounded-sm text-text-secondary">
          cd server && npm run dev
        </pre>
      </div>
    )
  }

  if (triageMode) {
    return <BookmarkTriageView />
  }

  // Mobile: show list or detail, not both (same pattern as email/chat)
  if (isMobile) {
    if (selectedBookmarkId) {
      return <BookmarkDetail />
    }
    return <BookmarkList />
  }

  // Desktop: three-pane split (tag tree | list | detail)
  return (
    <div className="flex flex-1 min-h-0">
      <div className="w-44 flex-shrink-0 border-r border-border overflow-y-auto">
        <BookmarkTagTree />
      </div>
      <div className="w-72 flex-shrink-0 border-r border-border overflow-hidden flex flex-col">
        <BookmarkList />
      </div>
      <div className="flex-1 min-w-0 overflow-hidden flex flex-col">
        <BookmarkDetail />
      </div>
    </div>
  )
})
