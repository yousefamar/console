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
//
// Row anatomy (real-estate over labels): channel ICON only (bridge brand for
// chat, mail/rss glyphs otherwise) + header (person/group/feed) + time, then
// the body (message/subject/item title) below. A DM's body has no sender
// prefix — the header already names them (roomToItem strips it).

import { memo, useRef, useState } from 'react'
import { Bot, Mail, MessageCircle, Rss, SlidersHorizontal } from 'lucide-react'
import { AgentSessionView } from './AgentSessionView'
import { useUnifiedInboxStore } from '@/store/unified-inbox'
import { useFeedStore } from '@/store/feeds'
import { useIsMobile } from '@/hooks/useMediaQuery'
import { ThreadView } from './ThreadView'
import { ChatRoomView } from './ChatRoomView'
import { FeedItemView } from './FeedItemView'
import { InboxDayRail } from './InboxDayRail'
import { NetworkIcon } from './ChatRoomListItem'
import { relativeTime } from '@/utils/date'
import { routeForFeed } from '@/inbox/route'
import type { FeedRoute, InboxItem } from '@/inbox/types'

// Composition wiring (source-store subscriptions → rebuild) lives in
// src/inbox/subscribe.ts, wired at boot from GatedBoot — the tab badge needs
// the lists before this pane ever mounts.

export const InboxTab = memo(function InboxTab() {
  const feedList = useUnifiedInboxStore((s) => s.feedList)
  const inboxList = useUnifiedInboxStore((s) => s.inboxList)
  const selected = useUnifiedInboxStore((s) => s.selected)
  const select = useUnifiedInboxStore((s) => s.select)
  const feedMode = useUnifiedInboxStore((s) => s.feedMode)
  const setFeedMode = useUnifiedInboxStore((s) => s.setFeedMode)
  const selectedKey = selected?.key ?? null
  const [showFilter, setShowFilter] = useState(false)
  const isMobile = useIsMobile()

  return (
    <>
      {/* Feed column */}
      <div className="w-80 flex-shrink-0 border-r border-border flex flex-col overflow-hidden">
        <ColumnHeader
          label={feedMode === 'x' ? 'Feed · X only' : 'Feed'}
          count={feedList.length}
          extra={
            <button
              onClick={() => setFeedMode(feedMode === 'x' ? 'default' : 'x')}
              className={`px-1 text-[10px] font-semibold rounded-sm transition-colors duration-fast ${
                feedMode === 'x' ? 'bg-surface-2 text-text-primary' : 'text-text-tertiary hover:text-text-primary'
              }`}
              title={feedMode === 'x' ? 'Back to the normal feed' : 'Show only X posts'}
            >
              𝕏
            </button>
          }
          action={{
            icon: <SlidersHorizontal size={11} />,
            title: 'Filter feeds',
            onClick: () => setShowFilter((v) => !v),
          }}
        />
        {showFilter && <FeedFilterPanel onClose={() => setShowFilter(false)} />}
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
        {selected?.source === 'agent' && <AgentSessionView />}
        {!selected && (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-text-tertiary">Select an item</p>
          </div>
        )}
      </div>

      {/* Day rail — create events without leaving triage. Desktop only. */}
      {!isMobile && <InboxDayRail />}
    </>
  )
})

// Matches SpacesTab's RailSection header (text-[10px] uppercase tracking-wide
// text-text-tertiary) so the two unified panes read as one family.
function ColumnHeader({ label, count, extra, action }: {
  label: string
  count: number
  extra?: React.ReactNode
  action?: { icon: React.ReactNode; title: string; onClick: () => void }
}) {
  return (
    <div className="flex items-center justify-between border-b border-border px-3 py-1">
      <span className="text-[10px] uppercase tracking-wide text-text-tertiary">{label}</span>
      <span className="flex items-center gap-2">
        <span className="text-[10px] text-text-tertiary">{count}</span>
        {extra}
        {action && (
          <button onClick={action.onClick} className="text-text-tertiary hover:text-text-primary" title={action.title}>
            {action.icon}
          </button>
        )}
      </span>
    </div>
  )
}

function EmptyHint({ text }: { text: string }) {
  return <div className="px-3 py-8 text-center text-sm text-text-tertiary">{text}</div>
}

function ChannelIcon({ item }: { item: InboxItem }) {
  if (item.source === 'mail') return <Mail size={12} />
  if (item.source === 'feed') return <Rss size={12} />
  if (item.source === 'agent') return <Bot size={12} className={item.attention ? 'text-red-500' : undefined} />
  if (item.network) return <NetworkIcon network={item.network} />
  return <MessageCircle size={12} />
}

const ItemRow = memo(function ItemRow({ item, selected, onClick }: {
  item: InboxItem
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-1.5 border-b border-border/50 transition-colors duration-fast ${
        selected ? 'bg-surface-2' : 'hover:bg-surface-1'
      }`}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="text-text-tertiary flex-shrink-0" title={item.network ?? item.source}><ChannelIcon item={item} /></span>
        <span className="truncate text-sm text-text-primary flex-1">{item.header}</span>
        <span className="text-[10px] text-text-tertiary flex-shrink-0">{relativeTime(item.ts)}</span>
      </div>
      {item.body && <div className="truncate text-xs text-text-tertiary mt-0.5">{item.body}</div>}
    </button>
  )
})

// Per-feed route filter: feed (browse) | inbox (must-handle) | hidden (not in
// this pane at all). Writes rules overrides via the store → hub-persisted.
const ROUTE_OPTIONS: Array<{ value: FeedRoute; label: string }> = [
  { value: 'feed', label: 'Feed' },
  { value: 'inbox', label: 'Inbox' },
  { value: 'hidden', label: 'Hidden' },
]

function FeedFilterPanel({ onClose }: { onClose: () => void }) {
  const feeds = useFeedStore((s) => s.feeds)
  const rules = useUnifiedInboxStore((s) => s.rules)
  const setFeedRoute = useUnifiedInboxStore((s) => s.setFeedRoute)
  const panelRef = useRef<HTMLDivElement>(null)
  const sorted = [...feeds].sort((a, b) => a.title.localeCompare(b.title))

  return (
    <div ref={panelRef} className="border-b border-border max-h-72 overflow-y-auto bg-surface-1">
      <div className="flex items-center justify-between px-3 py-1 sticky top-0 bg-surface-1">
        <span className="text-[10px] uppercase tracking-wide text-text-tertiary">Where each feed goes</span>
        <button onClick={onClose} className="text-[10px] text-text-tertiary hover:text-text-primary">done</button>
      </div>
      {sorted.map((f) => {
        const current = routeForFeed(f.id, rules)
        return (
          <div key={f.id} className="flex items-center gap-2 px-3 py-1">
            <span className="truncate text-xs text-text-secondary flex-1" title={f.title}>{f.title}</span>
            <span className="flex gap-0.5 flex-shrink-0">
              {ROUTE_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  onClick={() => void setFeedRoute(f.id, o.value)}
                  className={`px-1.5 py-0.5 text-[10px] rounded-sm transition-colors duration-fast ${
                    current === o.value ? 'bg-surface-2 text-text-primary' : 'text-text-tertiary hover:text-text-secondary'
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </span>
          </div>
        )
      })}
      {sorted.length === 0 && <EmptyHint text="No feeds" />}
    </div>
  )
}
