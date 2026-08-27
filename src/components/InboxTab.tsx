// Unified Inbox pane — Phase 1 (read-only three-column skeleton).
//
// Left: "Feed" (casual browse — no obligation to read). Middle: "Inbox"
// (inbox-zero — everything here gets handled). Right: viewer, reusing the
// existing ThreadView / ChatRoomView / FeedItemView verbatim — they're all
// store-driven, so select() just delegates into the owning source store.
//
// Handling verbs stay with the sources (mail archive, chat mark-read, feed
// mark-read); the lists rebuild from source state, so an item handled here
// OR in its legacy pane drops out identically.

import { memo } from 'react'
import { Mail, MessageCircle, Rss } from 'lucide-react'
import { useUnifiedInboxStore } from '@/store/unified-inbox'
import { ThreadView } from './ThreadView'
import { ChatRoomView } from './ChatRoomView'
import { FeedItemView } from './FeedItemView'
import { relativeTime } from '@/utils/date'
import type { InboxItem } from '@/inbox/types'

// Composition wiring (source-store subscriptions → rebuild) lives in
// src/inbox/subscribe.ts, wired at boot from GatedBoot — the tab badge needs
// the lists before this pane ever mounts.

export const InboxTab = memo(function InboxTab() {
  const feedList = useUnifiedInboxStore((s) => s.feedList)
  const inboxList = useUnifiedInboxStore((s) => s.inboxList)
  const selected = useUnifiedInboxStore((s) => s.selected)
  const select = useUnifiedInboxStore((s) => s.select)
  const selectedKey = selected?.key ?? null

  return (
    <>
      {/* Feed column */}
      <div className="w-80 flex-shrink-0 border-r border-border flex flex-col overflow-hidden">
        <ColumnHeader label="Feed" count={feedList.length} />
        <div className="flex-1 overflow-y-auto">
          {feedList.map((item) => (
            <ItemRow key={item.key} item={item} selected={item.key === selectedKey} onClick={() => select(item)} />
          ))}
          {feedList.length === 0 && <EmptyHint text="Nothing to browse" />}
        </div>
      </div>

      {/* Inbox column */}
      <div className="w-80 flex-shrink-0 border-r border-border flex flex-col overflow-hidden">
        <ColumnHeader label="Inbox" count={inboxList.length} />
        <div className="flex-1 overflow-y-auto">
          {inboxList.map((item) => (
            <ItemRow key={item.key} item={item} selected={item.key === selectedKey} onClick={() => select(item)} />
          ))}
          {inboxList.length === 0 && <EmptyHint text="Inbox zero" />}
        </div>
      </div>

      {/* Viewer column — mounts ONLY the selected source's viewer. ThreadView
          and ChatRoomView pre-render their own hidden children internally;
          mounting all three at once here would double-mount EmailFrames and
          RoomMessages against the legacy panes (both stay mounted in Layout),
          so the display:none trick is deliberately NOT used at this level. */}
      <div className="flex-1 min-w-0 flex flex-col relative overflow-hidden">
        {selected?.source === 'mail' && <ThreadView />}
        {selected?.source === 'chat' && <ChatRoomView />}
        {selected?.source === 'feed' && <FeedItemView />}
        {!selected && (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-text-tertiary">Select an item</p>
          </div>
        )}
      </div>
    </>
  )
})

function ColumnHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
      <span className="text-xs font-medium text-text-secondary uppercase tracking-wider">{label}</span>
      <span className="text-xs text-text-tertiary">{count}</span>
    </div>
  )
}

function EmptyHint({ text }: { text: string }) {
  return <div className="px-3 py-8 text-center text-sm text-text-tertiary">{text}</div>
}

const SOURCE_ICON = {
  mail: <Mail size={12} />,
  chat: <MessageCircle size={12} />,
  feed: <Rss size={12} />,
} as const

const ItemRow = memo(function ItemRow({ item, selected, onClick }: {
  item: InboxItem
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2 border-b border-border/50 transition-colors duration-fast ${
        selected ? 'bg-surface-2' : 'hover:bg-surface-1'
      }`}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="text-text-tertiary flex-shrink-0">{SOURCE_ICON[item.source]}</span>
        <span className="truncate text-xs text-text-tertiary flex-1">{item.origin}</span>
        <span className="text-[10px] text-text-tertiary flex-shrink-0">{relativeTime(item.ts)}</span>
      </div>
      <div className="truncate text-sm text-text-primary mt-0.5">{item.title}</div>
      {item.preview && <div className="truncate text-xs text-text-tertiary mt-0.5">{item.preview}</div>}
    </button>
  )
})
