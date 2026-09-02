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
import { ArrowLeftToLine, ArrowRightToLine, Bot, FolderKanban, Mail, MessageCircle, Rss, SlidersHorizontal } from 'lucide-react'
import { SiReddit, SiSubstack, SiX, SiYcombinator, SiYoutube } from 'react-icons/si'
import { AgentSessionView } from './AgentSessionView'
import { useUnifiedInboxStore } from '@/store/unified-inbox'
import { useFeedStore } from '@/store/feeds'
import { useChatStore } from '@/store/chat'
import { useIsMobile } from '@/hooks/useMediaQuery'
import { ThreadView } from './ThreadView'
import { ChatRoomView } from './ChatRoomView'
import { FeedItemView } from './FeedItemView'
import { InboxDayRail } from './InboxDayRail'
import { NetworkIcon } from './ChatRoomListItem'
import { relativeTime } from '@/utils/date'
import { feedKindsPresent, routeForFeed } from '@/inbox/route'
import { FEED_KIND_LABEL, type FeedKind } from '@/feeds/feed-kind'
import type { FeedRoute, InboxItem, InboxSource } from '@/inbox/types'

// Composition wiring (source-store subscriptions → rebuild) lives in
// src/inbox/subscribe.ts, wired at boot from GatedBoot — the tab badge needs
// the lists before this pane ever mounts.

export const InboxTab = memo(function InboxTab() {
  const fullFeedList = useUnifiedInboxStore((s) => s.feedList)
  const feedFilter = useUnifiedInboxStore((s) => s.feedFilter)
  const setFeedFilter = useUnifiedInboxStore((s) => s.setFeedFilter)
  const feedList = feedFilter ? fullFeedList.filter((i) => i.feedKind === feedFilter) : fullFeedList
  // Chips derive from the UNFILTERED (mode-filtered) list so the active
  // chip stays visible to toggle off; a single-platform list offers none.
  const feedKinds = feedKindsPresent(fullFeedList)
  const fullInboxList = useUnifiedInboxStore((s) => s.inboxList)
  const inboxFilter = useUnifiedInboxStore((s) => s.inboxFilter)
  const setInboxFilter = useUnifiedInboxStore((s) => s.setInboxFilter)
  const inboxList = inboxFilter ? fullInboxList.filter((i) => i.source === inboxFilter) : fullInboxList
  const selected = useUnifiedInboxStore((s) => s.selected)
  const select = useUnifiedInboxStore((s) => s.select)
  const feedMode = useUnifiedInboxStore((s) => s.feedMode)
  const setFeedMode = useUnifiedInboxStore((s) => s.setFeedMode)
  const selectedKey = selected?.key ?? null
  const [showFilter, setShowFilter] = useState(false)
  const isMobile = useIsMobile()

  // Mobile: one screen at a time — an Inbox|Feed segmented toggle picks the
  // visible list; selecting swaps to the viewer; the header back button
  // (mobileGoBack) clears the selection back to the list.
  const [mobileList, setMobileList] = useState<'inbox' | 'feed'>('inbox')
  const showViewer = !isMobile || !!selected
  const showFeedCol = isMobile ? (!selected && mobileList === 'feed') : true
  const showInboxCol = isMobile ? (!selected && mobileList === 'inbox') : true
  const colClass = isMobile ? 'w-full' : 'w-80 flex-shrink-0 border-r border-border'
  const mobileToggle = isMobile ? (
    <span className="flex gap-0.5">
      {(['inbox', 'feed'] as const).map((l) => (
        <button
          key={l}
          onClick={() => setMobileList(l)}
          className={`px-1.5 text-[10px] uppercase tracking-wide rounded-sm ${
            mobileList === l ? 'bg-surface-2 text-text-primary' : 'text-text-tertiary'
          }`}
        >
          {l}
        </button>
      ))}
    </span>
  ) : undefined

  return (
    <>
      {/* Feed column */}
      <div className={`${colClass} ${showFeedCol ? 'flex' : 'hidden'} flex-col overflow-hidden`}>
        <ColumnHeader
          label={feedMode === 'x' ? 'Feed · X only' : 'Feed'}
          count={feedList.length}
          extra={
            <>
              {mobileToggle}
              {feedKinds.length > 1 && (
                <span className="flex gap-1">
                  {feedKinds.map(({ kind, count }) => (
                    <button
                      key={kind}
                      onClick={() => setFeedFilter(feedFilter === kind ? null : kind)}
                      className={`transition-colors duration-fast ${
                        feedFilter === kind ? 'text-text-primary' : 'text-text-tertiary hover:text-text-secondary'
                      }`}
                      title={feedFilter === kind ? 'Show everything' : `${FEED_KIND_LABEL[kind]} only (${count})`}
                    >
                      <FeedKindGlyph kind={kind} size={11} />
                    </button>
                  ))}
                </span>
              )}
              <button
                onClick={() => setFeedMode(feedMode === 'x' ? 'default' : 'x')}
                className={`px-1 text-[10px] font-semibold rounded-sm transition-colors duration-fast ${
                  feedMode === 'x' ? 'bg-surface-2 text-text-primary' : 'text-text-tertiary hover:text-text-primary'
                }`}
                title={feedMode === 'x' ? 'Back to the normal feed' : 'Show only X posts'}
              >
                𝕏
              </button>
            </>
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
      <div className={`${colClass} ${showInboxCol ? 'flex' : 'hidden'} flex-col overflow-hidden`}>
        <ColumnHeader
          label="Inbox"
          count={inboxList.length}
          extra={
            <>
              {mobileToggle}
              <span className="flex gap-1">
                {SOURCE_FILTERS.map(({ source, icon, title }) => (
                  <button
                    key={source}
                    onClick={() => setInboxFilter(inboxFilter === source ? null : source)}
                    className={`transition-colors duration-fast ${
                      inboxFilter === source ? 'text-text-primary' : 'text-text-tertiary hover:text-text-secondary'
                    }`}
                    title={inboxFilter === source ? 'Show everything' : title}
                  >
                    {icon}
                  </button>
                ))}
              </span>
            </>
          }
        />
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
      <div className={`flex-1 min-w-0 ${showViewer ? 'flex' : 'hidden'} flex-col relative overflow-hidden`}>
        {selected?.source === 'mail' && <ThreadView />}
        {selected?.source === 'chat' && <ChatRoomView />}
        {selected?.source === 'feed' && <FeedItemView />}
        {selected?.source === 'agent' && (
          <>
            <div className="flex items-center justify-end border-b border-border px-3 py-0.5">
              <button
                onClick={() => void import('@/store/spaces').then(({ focusSessionInSpaces }) => focusSessionInSpaces(selected.sourceId))}
                className="flex items-center gap-1 text-[10px] text-text-tertiary hover:text-text-primary transition-colors duration-fast"
                title="Open this session in Spaces (o)"
              >
                <FolderKanban size={11} />
                <span>Open in Spaces</span>
              </button>
            </div>
            <AgentSessionView />
          </>
        )}
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

// Inbox-column source filter chips (while getting used to the unified pane).
const SOURCE_FILTERS: Array<{ source: InboxSource; icon: React.ReactNode; title: string }> = [
  { source: 'mail', icon: <Mail size={11} />, title: 'Mail only' },
  { source: 'chat', icon: <MessageCircle size={11} />, title: 'Chat only' },
  { source: 'agent', icon: <Bot size={11} />, title: 'Agents only' },
]

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
      {/* Count rides with the label on the LEFT — the right side is controls. */}
      <span className="flex items-center gap-1.5">
        <span className="text-[10px] uppercase tracking-wide text-text-tertiary">{label}</span>
        <span className="text-[10px] text-text-tertiary">{count}</span>
      </span>
      <span className="flex items-center gap-2">
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

// Platform glyph per feed kind — brand marks from react-icons (the chat
// column's NetworkIcon precedent), generic RSS for the long tail.
function FeedKindGlyph({ kind, size }: { kind: FeedKind; size: number }) {
  if (kind === 'youtube') return <SiYoutube size={size} />
  if (kind === 'reddit') return <SiReddit size={size} />
  if (kind === 'hn') return <SiYcombinator size={size} />
  if (kind === 'substack') return <SiSubstack size={size} />
  if (kind === 'x') return <SiX size={size} />
  return <Rss size={size} />
}

// A plain-RSS feed with a favicon shows THAT (blogs are recognisable by
// their mark, not by a generic glyph); a broken favicon falls back to Rss.
function FeedSourceIcon({ item }: { item: InboxItem }) {
  const [broken, setBroken] = useState(false)
  const kind = item.feedKind ?? 'rss'
  if (kind === 'rss' && item.icon && !broken) {
    return (
      <img
        src={item.icon}
        alt=""
        loading="lazy"
        onError={() => setBroken(true)}
        className="h-3 w-3 rounded-[2px] object-contain"
      />
    )
  }
  return <FeedKindGlyph kind={kind} size={12} />
}

function ChannelIcon({ item }: { item: InboxItem }) {
  if (item.source === 'mail') return <Mail size={12} />
  if (item.source === 'feed') return <FeedSourceIcon item={item} />
  if (item.source === 'agent') return <Bot size={12} className={item.attention ? 'text-red-500' : undefined} />
  if (item.network) return <NetworkIcon network={item.network} />
  return <MessageCircle size={12} />
}

const ItemRow = memo(function ItemRow({ item, selected, onClick }: {
  item: InboxItem
  selected: boolean
  onClick: () => void
}) {
  const promote = item.route === 'feed'
  return (
    <div
      onClick={onClick}
      className={`group w-full text-left px-3 py-1.5 border-b border-border/50 transition-colors duration-fast cursor-pointer ${
        selected ? 'bg-surface-2' : 'hover:bg-surface-1'
      }`}
    >
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-text-tertiary flex-shrink-0" title={item.feedKind ? FEED_KIND_LABEL[item.feedKind] : item.network ?? item.source}><ChannelIcon item={item} /></span>
            <span className="truncate text-sm text-text-primary flex-1">{item.header}</span>
            {item.overdue && <span className="text-[9px] uppercase tracking-wide text-amber-500 flex-shrink-0" title="Unanswered past SLA">overdue</span>}
            {item.routeKey && (
              <button
                onClick={(e) => { e.stopPropagation(); void useUnifiedInboxStore.getState().toggleRoute(item) }}
                className="hidden group-hover:inline text-text-tertiary hover:text-text-primary flex-shrink-0"
                title={promote ? 'Promote this source to Inbox' : 'Demote this source to Feed'}
              >
                {promote ? <ArrowRightToLine size={11} /> : <ArrowLeftToLine size={11} />}
              </button>
            )}
            <span className="text-[10px] text-text-tertiary flex-shrink-0">{relativeTime(item.ts)}</span>
          </div>
          {item.body && <div className="truncate text-xs text-text-tertiary mt-0.5">{item.body}</div>}
        </div>
        {item.image && <ItemThumb src={item.image} />}
      </div>
    </div>
  )
})

// Item thumbnail (video still / post image), sized to the two-line row so
// it never grows the row; a dead URL just disappears.
function ItemThumb({ src }: { src: string }) {
  const [broken, setBroken] = useState(false)
  if (broken) return null
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      onError={() => setBroken(true)}
      className="h-9 aspect-video object-cover rounded-sm bg-surface-2 flex-shrink-0"
    />
  )
}

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
      <RouteOverrides />
    </div>
  )
}

// Chat-room + mail-sender routing overrides (written by the per-item
// promote/demote gesture) — listed here so they're inspectable and clearable.
function RouteOverrides() {
  const rules = useUnifiedInboxStore((s) => s.rules)
  const saveRules = useUnifiedInboxStore((s) => s.saveRules)
  const rooms = useChatStore((s) => s.rooms)
  const chatEntries = Object.entries(rules.chat.rooms)
  const mailEntries = Object.entries(rules.mail.senders)
  if (chatEntries.length === 0 && mailEntries.length === 0) return null

  const clearChat = (id: string) => {
    const { [id]: _, ...rest } = rules.chat.rooms
    void saveRules({ ...rules, chat: { ...rules.chat, rooms: rest } })
  }
  const clearMail = (email: string) => {
    const { [email]: _, ...rest } = rules.mail.senders
    void saveRules({ ...rules, mail: { ...rules.mail, senders: rest } })
  }

  return (
    <>
      <div className="px-3 py-1 sticky top-0 bg-surface-1">
        <span className="text-[10px] uppercase tracking-wide text-text-tertiary">Chat & mail overrides</span>
      </div>
      {chatEntries.map(([id, route]) => (
        <div key={id} className="flex items-center gap-2 px-3 py-1">
          <span className="truncate text-xs text-text-secondary flex-1" title={id}>{rooms.find((r) => r.id === id)?.name ?? id}</span>
          <span className="text-[10px] text-text-tertiary">→ {route}</span>
          <button onClick={() => clearChat(id)} className="text-[10px] text-text-tertiary hover:text-text-primary">clear</button>
        </div>
      ))}
      {mailEntries.map(([email, route]) => (
        <div key={email} className="flex items-center gap-2 px-3 py-1">
          <span className="truncate text-xs text-text-secondary flex-1">{email}</span>
          <span className="text-[10px] text-text-tertiary">→ {route}</span>
          <button onClick={() => clearMail(email)} className="text-[10px] text-text-tertiary hover:text-text-primary">clear</button>
        </div>
      ))}
    </>
  )
}
