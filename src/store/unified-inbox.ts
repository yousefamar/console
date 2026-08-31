// Unified Inbox pane store. Named unified-inbox because store/inbox.ts is
// the MAIL store (predates this pane).
//
// This store owns NO source data — it composes the mail/chat/feeds stores
// into two routed lists and tracks which item is selected. Selection
// delegates to the source store (selectThread/selectRoom/selectItem) so the
// reused viewers (ThreadView/ChatRoomView/FeedItemView) light up unchanged.

import { create } from 'zustand'
import { db } from '@/db'
import { hubFetchRaw as hubFetch } from '@/hub'
import { useInboxStore } from '@/store/inbox'
import { useChatStore } from '@/store/chat'
import { useFeedStore } from '@/store/feeds'
import { DEFAULT_RULES, type FeedRoute, type InboxItem, type InboxRules } from '@/inbox/types'
import { useAgentStore } from '@/store/agent'
import {
  feedItemToItem, nextAfterHandle, normalizeRules, roomIsLive, roomToItem,
  sessionIsLive, sessionToItem, sortFeed, sortInbox, threadIsLive, threadToItem,
} from '@/inbox/route'

interface UnifiedInboxState {
  rules: InboxRules
  rulesLoaded: boolean
  feedList: InboxItem[]
  inboxList: InboxItem[]
  /** The selected item — held as the ITEM, not a key into the lists: handling
   *  it (reply marks a chat read, archive drops a thread) removes it from the
   *  lists on rebuild, but the viewer must keep showing it until the user
   *  moves on — same semantics as the chat pane's selected room. */
  selected: InboxItem | null

  loadRules: () => Promise<void>
  saveRules: (rules: InboxRules) => Promise<void>
  /** Set one feed's route (feed | inbox | hidden) — the filter UI's verb. */
  setFeedRoute: (feedId: string, route: FeedRoute) => Promise<void>
  rebuild: () => Promise<void>
  select: (item: InboxItem | null) => void
  selectAdjacent: (list: 'feed' | 'inbox', dir: 1 | -1) => void
  /** Handle the selected item (e = archive/mark-read, b = snooze) and advance
   *  to the next one in its list — same flow as the legacy panes. */
  handleSelected: (verb: 'done' | 'snooze') => void
}

export const useUnifiedInboxStore = create<UnifiedInboxState>((set, get) => ({
  rules: DEFAULT_RULES,
  rulesLoaded: false,
  feedList: [],
  inboxList: [],
  selected: null,

  loadRules: async () => {
    try {
      const res = await hubFetch('/inbox/rules')
      if (res.ok) set({ rules: normalizeRules(await res.json()), rulesLoaded: true })
    } catch {
      // Hub unreachable — defaults stand; retry happens on next rebuild.
    }
  },

  saveRules: async (rules) => {
    set({ rules })
    await hubFetch('/inbox/rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rules),
    }).catch(() => {})
    void get().rebuild()
  },

  setFeedRoute: async (feedId, route) => {
    const r = get().rules
    const feeds = { ...r.feeds.feeds }
    if (route === r.feeds.default) delete feeds[feedId]
    else feeds[feedId] = route
    await get().saveRules({ ...r, feeds: { ...r.feeds, feeds } })
  },

  rebuild: async () => {
    const { rules, rulesLoaded } = get()
    if (!rulesLoaded) await get().loadRules()
    const effective = get().rulesLoaded ? get().rules : rules
    const now = Date.now()

    // Mail: the store's threads array IS the live inbox (archive removes).
    const threads = useInboxStore.getState().threads
      .filter((t) => threadIsLive(t, now))
      .map((t) => threadToItem(t, effective))

    // Chat: unread/manual-unread rooms, straight from Dexie (the chat store's
    // rooms array drops read rooms lazily; Dexie is the durable mirror).
    const rooms = (await db.chatRooms.toArray())
      .filter((r) => roomIsLive(r, now))
      .map((r) => roomToItem(r, effective))

    // Feeds: unread items. Reads Dexie directly (the feeds store's items
    // array follows its own pane's feed/folder selection).
    const readSet = new Set((await db.feedRead.toArray()).map((r) => r.itemId))
    const feeds = useFeedStore.getState().feeds
    const feedById = new Map(feeds.map((f) => [f.id, f]))
    const feedItems = (await db.feedItems.orderBy('publishedAt').reverse().limit(500).toArray())
      .filter((i) => !readSet.has(i.id))
      .map((i) => feedItemToItem(i, feedById.get(i.feedId), effective))
      .filter((i): i is InboxItem => i !== null)

    // Agents: unread / attention-flagged sessions (Al excluded — he's a
    // standing conversation, not an item to clear).
    const sessions = useAgentStore.getState().sessions
      .filter(sessionIsLive)
      .map(sessionToItem)

    const all = [...threads, ...rooms, ...feedItems, ...sessions]
    set({
      feedList: sortFeed(all.filter((i) => i.route === 'feed')),
      inboxList: sortInbox(all.filter((i) => i.route === 'inbox')),
    })
  },

  select: (item) => {
    set({ selected: item })
    if (!item) return
    // Delegate to the owning source store so the reused viewer renders it
    // (and the source's own read-marking side effects run).
    if (item.source === 'mail') void useInboxStore.getState().selectThread(item.sourceId)
    else if (item.source === 'chat') void useChatStore.getState().selectRoom(item.sourceId)
    else if (item.source === 'agent') useAgentStore.getState().selectSession(item.sourceId)
    else useFeedStore.getState().selectItem(item.sourceId)
  },

  selectAdjacent: (list, dir) => {
    const items = list === 'feed' ? get().feedList : get().inboxList
    if (items.length === 0) return
    const idx = items.findIndex((i) => i.key === get().selected?.key)
    const next = idx < 0 ? (dir === 1 ? 0 : items.length - 1) : Math.max(0, Math.min(items.length - 1, idx + dir))
    get().select(items[next]!)
  },

  handleSelected: (verb) => {
    const { feedList, inboxList, selected } = get()
    if (!selected) return
    const inFeed = feedList.some((i) => i.key === selected.key)
    const list = inFeed ? feedList : inboxList
    const item = list.find((i) => i.key === selected.key) ?? selected

    // Compute the landing spot BEFORE the verb fires — the handled item drops
    // from the list on the next rebuild, so "next" must come from the current
    // snapshot (the legacy mail pane does the same inside archiveThread).
    const next = nextAfterHandle(list, selected.key)

    if (verb === 'done') {
      if (item.source === 'mail') useInboxStore.getState().archiveThread(item.sourceId)
      else if (item.source === 'chat') void useChatStore.getState().markRoomRead(item.sourceId)
      else if (item.source === 'agent') useAgentStore.getState().markSessionRead(item.sourceId)
      else void useFeedStore.getState().markRead(item.sourceId)
    } else {
      if (item.source === 'mail') useInboxStore.getState().snoozeThread('tomorrow', undefined, item.sourceId)
      else if (item.source === 'chat') void useChatStore.getState().snoozeRoom('tomorrow')
      else return // feed items and agent sessions have no snooze (Phase 2+)
    }

    // Advance if there's somewhere to go; otherwise STAY on the handled item
    // (the viewer keeps it — an emptied list must not blank the viewer).
    if (next) get().select(next)
  },
}))
