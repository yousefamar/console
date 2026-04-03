import { useState, useEffect } from 'react'
import { useFeedStore, type FeedSubscription } from '@/store/feeds'
import { ChevronRight, ChevronDown, Rss, FolderOpen, Folder, Plus, Trash2, ExternalLink, Info, Copy, CheckCheck } from 'lucide-react'

interface FeedContextMenu {
  x: number
  y: number
  feed: FeedSubscription
}

interface FolderContextMenu {
  x: number
  y: number
  folder: string
}

export function FeedFolderTree() {
  const feeds = useFeedStore((s) => s.feeds)
  const selectedFeedId = useFeedStore((s) => s.selectedFeedId)
  const selectedFolderId = useFeedStore((s) => s.selectedFolderId)
  const expandedFolders = useFeedStore((s) => s.expandedFolders)
  const unreadCounts = useFeedStore((s) => s.unreadCounts)
  const totalUnread = useFeedStore((s) => s.totalUnread)
  const selectFeed = useFeedStore((s) => s.selectFeed)
  const selectFolder = useFeedStore((s) => s.selectFolder)
  const toggleFolder = useFeedStore((s) => s.toggleFolder)
  const setShowAddModal = useFeedStore((s) => s.setShowAddModal)
  const deleteFeed = useFeedStore((s) => s.deleteFeed)
  const markFeedRead = useFeedStore((s) => s.markFeedRead)
  const markFolderRead = useFeedStore((s) => s.markFolderRead)

  const [feedMenu, setFeedMenu] = useState<FeedContextMenu | null>(null)
  const [folderMenu, setFolderMenu] = useState<FolderContextMenu | null>(null)
  const [feedInfo, setFeedInfo] = useState<FeedSubscription | null>(null)

  const activeMenu = feedMenu || folderMenu

  // Close context menu on click outside
  useEffect(() => {
    if (!activeMenu) return
    const close = () => { setFeedMenu(null); setFolderMenu(null) }
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [activeMenu])

  const handleFeedContextMenu = (e: React.MouseEvent, feed: FeedSubscription) => {
    e.preventDefault()
    setFolderMenu(null)
    setFeedMenu({ x: e.clientX, y: e.clientY, feed })
  }

  const handleFolderContextMenu = (e: React.MouseEvent, folder: string) => {
    e.preventDefault()
    setFeedMenu(null)
    setFolderMenu({ x: e.clientX, y: e.clientY, folder })
  }

  // Build folder structure
  const folders = new Map<string, FeedSubscription[]>()
  const topLevel: FeedSubscription[] = []

  for (const feed of feeds) {
    if (feed.folder) {
      const arr = folders.get(feed.folder) || []
      arr.push(feed)
      folders.set(feed.folder, arr)
    } else {
      topLevel.push(feed)
    }
  }

  const folderNames = Array.from(folders.keys()).sort()

  function folderUnreadCount(folder: string): number {
    const folderFeeds = folders.get(folder) || []
    return folderFeeds.reduce((sum, f) => sum + (unreadCounts[f.id] || 0), 0)
  }

  const isAllSelected = !selectedFeedId && !selectedFolderId

  return (
    <div className="py-1">
      {/* Header */}
      <div className="flex items-center justify-between px-2 py-1">
        <span className="text-[10px] font-medium text-text-tertiary uppercase tracking-wider">Feeds</span>
        <button
          onClick={() => setShowAddModal(true)}
          className="text-text-tertiary hover:text-text-secondary transition-colors"
          title="Add feed"
        >
          <Plus size={12} />
        </button>
      </div>

      {/* All feeds */}
      <button
        onClick={() => { selectFeed(null); selectFolder(null) }}
        className={`w-full flex items-center gap-1.5 px-2 py-1 text-xs transition-colors ${
          isAllSelected ? 'bg-surface-2 text-text-primary' : 'text-text-secondary hover:bg-surface-1'
        }`}
      >
        <Rss size={11} className="flex-shrink-0" />
        <span className="truncate flex-1 text-left">All</span>
        {totalUnread > 0 && (
          <span className="text-[10px] text-text-tertiary">{totalUnread}</span>
        )}
      </button>

      {/* Folders */}
      {folderNames.map((folder) => {
        const expanded = expandedFolders.has(folder)
        const folderFeeds = folders.get(folder) || []
        const unread = folderUnreadCount(folder)
        const isFolderSelected = selectedFolderId === folder

        return (
          <div key={folder}>
            <div
              className={`w-full flex items-center gap-1 px-2 py-1 text-xs transition-colors cursor-pointer ${
                isFolderSelected ? 'bg-surface-2 text-text-primary' : 'text-text-secondary hover:bg-surface-1'
              }`}
              onClick={() => selectFolder(folder)}
              onContextMenu={(e) => handleFolderContextMenu(e, folder)}
            >
              <span
                onClick={(e) => { e.stopPropagation(); toggleFolder(folder) }}
                className="flex-shrink-0 hover:text-text-primary"
              >
                {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
              </span>
              {expanded ? <FolderOpen size={11} /> : <Folder size={11} />}
              <span className="truncate flex-1 text-left">{folder}</span>
              {unread > 0 && (
                <span className="text-[10px] text-text-tertiary">{unread}</span>
              )}
            </div>
            {expanded && folderFeeds.map((feed) => (
              <FeedEntry
                key={feed.id}
                feed={feed}
                isSelected={selectedFeedId === feed.id}
                unread={unreadCounts[feed.id] || 0}
                onClick={() => selectFeed(feed.id)}
                onContextMenu={(e) => handleFeedContextMenu(e, feed)}
                indent
              />
            ))}
          </div>
        )
      })}

      {/* Top-level feeds (no folder) */}
      {topLevel.map((feed) => (
        <FeedEntry
          key={feed.id}
          feed={feed}
          isSelected={selectedFeedId === feed.id}
          unread={unreadCounts[feed.id] || 0}
          onClick={() => selectFeed(feed.id)}
          onContextMenu={(e) => handleFeedContextMenu(e, feed)}
        />
      ))}

      {/* Feed context menu */}
      {feedMenu && (
        <div
          className="fixed z-50 bg-surface-0 border border-border rounded-sm shadow-lg py-0.5 min-w-36"
          style={{ left: feedMenu.x, top: feedMenu.y }}
        >
          <button
            onClick={() => {
              markFeedRead(feedMenu.feed.id)
              setFeedMenu(null)
            }}
            className="flex items-center gap-2 w-full px-3 py-1 text-xs text-text-primary hover:bg-surface-1 transition-colors"
          >
            <CheckCheck size={11} className="text-text-tertiary" />
            Mark all read
          </button>
          <button
            onClick={() => {
              setFeedInfo(feedMenu.feed)
              setFeedMenu(null)
            }}
            className="flex items-center gap-2 w-full px-3 py-1 text-xs text-text-primary hover:bg-surface-1 transition-colors"
          >
            <Info size={11} className="text-text-tertiary" />
            Feed info
          </button>
          {feedMenu.feed.siteUrl && (
            <button
              onClick={() => {
                window.open(feedMenu.feed.siteUrl, '_blank', 'noopener')
                setFeedMenu(null)
              }}
              className="flex items-center gap-2 w-full px-3 py-1 text-xs text-text-primary hover:bg-surface-1 transition-colors"
            >
              <ExternalLink size={11} className="text-text-tertiary" />
              Open site
            </button>
          )}
          <button
            onClick={() => {
              navigator.clipboard.writeText(feedMenu.feed.xmlUrl)
              setFeedMenu(null)
            }}
            className="flex items-center gap-2 w-full px-3 py-1 text-xs text-text-primary hover:bg-surface-1 transition-colors"
          >
            <Copy size={11} className="text-text-tertiary" />
            Copy feed URL
          </button>
          <div className="border-t border-border my-0.5" />
          <button
            onClick={() => {
              deleteFeed(feedMenu.feed.id)
              setFeedMenu(null)
            }}
            className="flex items-center gap-2 w-full px-3 py-1 text-xs text-red-400 hover:bg-surface-1 transition-colors"
          >
            <Trash2 size={11} />
            Delete feed
          </button>
        </div>
      )}

      {/* Folder context menu */}
      {folderMenu && (
        <div
          className="fixed z-50 bg-surface-0 border border-border rounded-sm shadow-lg py-0.5 min-w-36"
          style={{ left: folderMenu.x, top: folderMenu.y }}
        >
          <button
            onClick={() => {
              markFolderRead(folderMenu.folder)
              setFolderMenu(null)
            }}
            className="flex items-center gap-2 w-full px-3 py-1 text-xs text-text-primary hover:bg-surface-1 transition-colors"
          >
            <CheckCheck size={11} className="text-text-tertiary" />
            Mark all read
          </button>
        </div>
      )}

      {/* Feed info modal */}
      {feedInfo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setFeedInfo(null)}>
          <div
            className="bg-surface-0 border border-border rounded-sm shadow-lg w-80 max-w-[90vw]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-3 py-2 border-b border-border">
              <span className="text-xs font-medium text-text-primary truncate">{feedInfo.title}</span>
            </div>
            <div className="px-3 py-2 space-y-2">
              <InfoRow label="Feed URL" value={feedInfo.xmlUrl} copyable />
              {feedInfo.siteUrl && <InfoRow label="Site URL" value={feedInfo.siteUrl} copyable link />}
              {feedInfo.folder && <InfoRow label="Folder" value={feedInfo.folder} />}
              <InfoRow label="Added" value={new Date(feedInfo.addedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} />
              <div>
                <div className="text-[10px] text-text-tertiary uppercase tracking-wider">Full text</div>
                <label className="flex items-center gap-1.5 mt-0.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={feedInfo.fullText || false}
                    onChange={async (e) => {
                      const val = e.target.checked
                      setFeedInfo({ ...feedInfo, fullText: val })
                      const hubUrl = localStorage.getItem('consoleServerUrl') ?? 'http://localhost:9877'
                      await fetch(`${hubUrl}/feeds/${feedInfo.id}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ fullText: val }),
                      })
                      await useFeedStore.getState().fetchFeeds()
                    }}
                    className="accent-text-primary"
                  />
                  <span className="text-xs text-text-secondary">Fetch full article from page</span>
                </label>
              </div>
            </div>
            <div className="px-3 py-2 border-t border-border flex justify-end">
              <button
                onClick={() => setFeedInfo(null)}
                className="px-2 py-0.5 text-xs text-text-secondary hover:text-text-primary transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function FeedEntry({ feed, isSelected, unread, onClick, onContextMenu, indent }: {
  feed: FeedSubscription
  isSelected: boolean
  unread: number
  onClick: () => void
  onContextMenu: (e: React.MouseEvent) => void
  indent?: boolean
}) {
  return (
    <button
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={`w-full flex items-center gap-1.5 py-1 text-xs transition-colors ${
        indent ? 'pl-6 pr-2' : 'px-2'
      } ${isSelected ? 'bg-surface-2 text-text-primary' : 'text-text-secondary hover:bg-surface-1'}`}
    >
      <Rss size={9} className="flex-shrink-0 opacity-50" />
      <span className="truncate flex-1 text-left">{feed.title}</span>
      {unread > 0 && (
        <span className="text-[10px] text-text-tertiary font-medium">{unread}</span>
      )}
    </button>
  )
}

function InfoRow({ label, value, copyable, link }: {
  label: string
  value: string
  copyable?: boolean
  link?: boolean
}) {
  return (
    <div>
      <div className="text-[10px] text-text-tertiary uppercase tracking-wider">{label}</div>
      <div className="flex items-center gap-1 mt-0.5">
        {link ? (
          <a
            href={value}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-400 hover:text-blue-300 underline truncate flex-1"
          >
            {value}
          </a>
        ) : (
          <span className="text-xs text-text-secondary truncate flex-1">{value}</span>
        )}
        {copyable && (
          <button
            onClick={() => navigator.clipboard.writeText(value)}
            className="flex-shrink-0 text-text-tertiary hover:text-text-secondary transition-colors"
            title="Copy"
          >
            <Copy size={10} />
          </button>
        )}
      </div>
    </div>
  )
}
