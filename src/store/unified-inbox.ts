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
import { DEFAULT_RULES, itemKey, type FeedRoute, type InboxItem, type InboxRules, type InboxSource, type Route } from '@/inbox/types'
import { useAgentStore } from '@/store/agent'
import { useSpacesStore } from '@/store/spaces'
import { useUiStore } from '@/store/ui'
import { activeLocalSnoozes, unsnoozeItem } from '@/inbox/snooze'
import {
  feedItemToItem, filterByFeedKind, filterByFeedMode, nextAfterHandle, normalizeRules, roomIsLive, roomToItem,
  sessionIsLive, sessionToItem, sortFeed, sortInbox, threadIsLive, threadToItem,
  type FeedMode,
} from '@/inbox/route'
import type { FeedKind } from '@/feeds/feed-kind'

interface UnifiedInboxState {
  rules: InboxRules
  rulesLoaded: boolean
  feedList: InboxItem[]
  /** Everything currently snoozed, across all four sources, soonest-due
   *  first — the Inbox column's "N snoozed" view. Derived like the lists:
   *  mail/chat from their rows' `snoozedUntil`, feed/agent from `itemSnooze`. */
  snoozedList: InboxItem[]
  /** Inbox column shows the snoozed view instead of the live list. Session-
   *  only, like the filters. */
  showSnoozed: boolean
  setShowSnoozed: (v: boolean) => void
  inboxList: InboxItem[]
  /** Feed-column mode: 'default' hides hidden-folder feeds (X); 'x' shows
   *  ONLY those. Session-only — always lands on default. */
  feedMode: FeedMode
  /** Inbox-column source filter (mail | chat | agent), session-only —
   *  a getting-used-to-the-pane affordance, null = everything. */
  inboxFilter: InboxSource | null
  /** Feed-column platform filter (youtube | reddit | …), session-only —
   *  the Feed twin of inboxFilter, null = everything. */
  feedFilter: FeedKind | null
  /** The selected item — held as the ITEM, not a key into the lists: handling
   *  it (reply marks a chat read, archive drops a thread) removes it from the
   *  lists on rebuild, but the viewer must keep showing it until the user
   *  moves on — same semantics as the chat pane's selected room. */
  selected: InboxItem | null

  loadRules: () => Promise<void>
  saveRules: (rules: InboxRules) => Promise<void>
  /** Set one feed's route (feed | inbox | hidden) — the filter UI's verb. */
  setFeedRoute: (feedId: string, route: FeedRoute) => Promise<void>
  /** Move an item's SOURCE to the other list, persisted as a rules override
   *  keyed by routeKey (room id / sender email / feed id) — a judgment about
   *  the source, not the one item. */
  toggleRoute: (item: InboxItem) => Promise<void>
  setFeedMode: (mode: FeedMode) => void
  setInboxFilter: (source: InboxSource | null) => void
  setFeedFilter: (kind: FeedKind | null) => void
  rebuild: () => Promise<void>
  select: (item: InboxItem | null) => void
  selectAdjacent: (list: 'feed' | 'inbox' | 'snoozed', dir: 1 | -1) => void
  /** Which displayed list holds the selection (drives j/k + the verbs). */
  listOf: (key: string | null | undefined) => 'feed' | 'inbox' | 'snoozed'
  /** Handle the selected item and advance to the next one in its list — same
   *  flow as the legacy panes. `done` = archive / mark-read in the owning
   *  store; `snooze` = open the shared picker for it (the picker's commit
   *  path, `applySnooze`, does the dropping). */
  handleSelected: (verb: 'done' | 'snooze') => void
  /** Remove an item from the composed lists NOW and move the selection to its
   *  neighbour. The rebuild would drop it anyway, but that is a 300 ms
   *  trailing debounce that every source-store write resets — a busy agent
   *  fleet writes every few hundred ms, so a handled row could linger for
   *  seconds (the "snooze does nothing" report). Optimistic, like every other
   *  mutation in the app; the next rebuild agrees. */
  dropAndAdvance: (key: string, opts?: { snoozedUntil?: number }) => void
  /** Lift a `dropAndAdvance` suppression (undo) so the next rebuild may list
   *  the item again. */
  restore: (key: string) => void
}

/** Keys handled optimistically that rebuilds must keep out until the source
 *  store has confirmed the change. A rebuild already in flight when the row
 *  is dropped read Dexie BEFORE the source wrote its snooze/read flag and
 *  would re-add the row from that stale read. Time-boxed: the source's own
 *  guards take over well inside this window. */
const HANDLED_SUPPRESS_MS = 5_000
/** Direction matters: a key dropped from the LIVE lists (snoozed/archived)
 *  must stay out of live but may appear in the snoozed view at once; one
 *  dropped from the SNOOZED view (unsnoozed) is the mirror image. */
const handledKeys = new Map<string, { until: number; from: 'live' | 'snoozed' }>()
/** Rebuilds overlap (several awaits each, scheduled from many writers); an
 *  older one finishing after a newer one would publish stale lists — e.g. a
 *  read taken before a snooze landed, erasing the row from the snoozed view
 *  until the next rebuild. Only the newest rebuild may publish. */
let rebuildSeq = 0
function suppressedKeys(now: number, from: 'live' | 'snoozed'): Set<string> {
  for (const [k, h] of handledKeys) if (h.until <= now) handledKeys.delete(k)
  return new Set([...handledKeys].filter(([, h]) => h.from === from).map(([k]) => k))
}

export const useUnifiedInboxStore = create<UnifiedInboxState>((set, get) => ({
  rules: DEFAULT_RULES,
  rulesLoaded: false,
  feedList: [],
  snoozedList: [],
  showSnoozed: false,
  setShowSnoozed: (v) => set({ showSnoozed: v }),
  inboxList: [],
  feedMode: 'default',
  inboxFilter: null,
  feedFilter: null,
  selected: null,

  setFeedMode: (mode) => {
    set({ feedMode: mode })
    void get().rebuild()
  },

  setInboxFilter: (source) => set({ inboxFilter: source }),

  setFeedFilter: (kind) => set({ feedFilter: kind }),

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

  toggleRoute: async (item) => {
    const key = item.routeKey
    if (!key) return // agents don't route
    const r = get().rules
    const target: Route = item.route === 'inbox' ? 'feed' : 'inbox'
    if (item.source === 'chat') {
      const rooms = { ...r.chat.rooms }
      if (target === r.chat.default) delete rooms[key]; else rooms[key] = target
      await get().saveRules({ ...r, chat: { ...r.chat, rooms } })
    } else if (item.source === 'mail') {
      const senders = { ...r.mail.senders }
      if (target === r.mail.default) delete senders[key]; else senders[key] = target
      await get().saveRules({ ...r, mail: { ...r.mail, senders } })
    } else {
      const feeds = { ...r.feeds.feeds }
      if (target === r.feeds.default) delete feeds[key]; else feeds[key] = target
      await get().saveRules({ ...r, feeds: { ...r.feeds, feeds } })
    }
  },

  rebuild: async () => {
    const seq = ++rebuildSeq
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
    const allRooms = await db.chatRooms.toArray()
    const rooms = allRooms
      .filter((r) => roomIsLive(r, now))
      .map((r) => roomToItem(r, effective, now))

    // Feeds: unread items. Reads Dexie directly (the feeds store's items
    // array follows its own pane's feed/folder selection).
    const readSet = new Set((await db.feedRead.toArray()).map((r) => r.itemId))
    // Feed items and agent sessions share the local snooze table, keyed by
    // InboxItem.key — the two sources with no snooze of their own.
    const snoozedKeys = await activeLocalSnoozes(now)
    const feeds = useFeedStore.getState().feeds
    const feedById = new Map(feeds.map((f) => [f.id, f]))
    const feedItems = (await db.feedItems.orderBy('publishedAt').reverse().limit(500).toArray())
      .filter((i) => !readSet.has(i.id))
      .map((i) => feedItemToItem(i, feedById.get(i.feedId), effective))
      .filter((i): i is InboxItem => i !== null)

    // Agents: unread / attention-flagged sessions (Al excluded — he's a
    // standing conversation, not an item to clear). A session whose @key
    // owns an Under Review card is a hand-back — banded beside attention.
    const reviewKeys = new Set(
      useSpacesStore.getState().spaces.flatMap((sp) => sp.reviewAgentKeys ?? []),
    )
    const sessions = useAgentStore.getState().sessions
      .filter(sessionIsLive)
      .map((s) => sessionToItem(s, reviewKeys))

    const suppressedLive = suppressedKeys(now, 'live')
    const all = [...threads, ...rooms, ...feedItems, ...sessions]
      .filter((i) => !snoozedKeys.has(i.key) && !suppressedLive.has(i.key))

    // Snoozed view: the same four sources, inverted — rows whose snooze is
    // still running, stamped with when they come back. Mail reads Dexie here
    // (the store's threads array excludes snoozed threads by construction).
    const stamp = (i: InboxItem | null, until: number | undefined): InboxItem | null =>
      i && until ? { ...i, snoozedUntil: until } : null
    const snoozedThreads = (await db.threads.filter((t) => !!t.snoozedUntil && t.snoozedUntil > now).toArray())
      .map((t) => stamp(threadToItem(t, effective), t.snoozedUntil))
    const snoozedRooms = allRooms
      .filter((r) => !!r.snoozedUntil && r.snoozedUntil > now)
      .map((r) => stamp(roomToItem(r, effective, now), r.snoozedUntil))
    const feedIds = [...snoozedKeys.keys()].filter((k) => k.startsWith('feed:')).map((k) => k.slice(5))
    const snoozedFeed = (await db.feedItems.bulkGet(feedIds))
      .map((i) => i ? stamp(feedItemToItem(i, feedById.get(i.feedId), effective), snoozedKeys.get(itemKey('feed', i.id))) : null)
    const sessionById = new Map(useAgentStore.getState().sessions.map((x) => [x.id, x]))
    const snoozedAgents = [...snoozedKeys.keys()].filter((k) => k.startsWith('agent:')).map((k) => {
      const sess = sessionById.get(k.slice(6))
      return sess ? stamp(sessionToItem(sess, reviewKeys), snoozedKeys.get(k)) : null
    })
    const suppressedSnoozed = suppressedKeys(now, 'snoozed')
    const snoozedList = [...snoozedThreads, ...snoozedRooms, ...snoozedFeed, ...snoozedAgents]
      .filter((i): i is InboxItem => i !== null && !suppressedSnoozed.has(i.key))
      .sort((a, b) => a.snoozedUntil! - b.snoozedUntil!)

    if (seq !== rebuildSeq) return
    set({
      feedList: sortFeed(filterByFeedMode(all.filter((i) => i.route === 'feed'), get().feedMode)),
      inboxList: sortInbox(all.filter((i) => i.route === 'inbox')),
      snoozedList,
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

  listOf: (key) => {
    const { feedList, showSnoozed } = get()
    if (key && feedList.some((i) => i.key === key)) return 'feed'
    // The Inbox column shows ONE of two lists; nav follows what's displayed,
    // even when the selection was carried over from the other view.
    return showSnoozed ? 'snoozed' : 'inbox'
  },

  selectAdjacent: (list, dir) => {
    const items = list === 'feed' ? visibleFeed(get()) : list === 'snoozed' ? get().snoozedList : visibleInbox(get())
    if (items.length === 0) return
    const idx = items.findIndex((i) => i.key === get().selected?.key)
    const next = idx < 0 ? (dir === 1 ? 0 : items.length - 1) : Math.max(0, Math.min(items.length - 1, idx + dir))
    get().select(items[next]!)
  },

  dropAndAdvance: (key, opts) => {
    const { feedList, inboxList, snoozedList, selected } = get()
    const which = get().listOf(key)
    const list = which === 'feed' ? visibleFeed(get()) : which === 'snoozed' ? snoozedList : visibleInbox(get())
    const dropped = list.find((i) => i.key === key)
    // Landing spot from the CURRENT snapshot — the item is gone after this.
    const next = selected?.key === key ? nextAfterHandle(list, key) : null
    handledKeys.set(key, { until: Date.now() + HANDLED_SUPPRESS_MS, from: which === 'snoozed' ? 'snoozed' : 'live' })
    // A snooze moves the row into the snoozed view at once (the rebuild
    // that would list it there is several Dexie reads away).
    const nextSnoozed = which === 'snoozed'
      ? snoozedList.filter((i) => i.key !== key)
      : dropped && opts?.snoozedUntil
        ? [...snoozedList.filter((i) => i.key !== key), { ...dropped, snoozedUntil: opts.snoozedUntil }].sort((a, b) => a.snoozedUntil! - b.snoozedUntil!)
        : snoozedList
    set({
      feedList: which === 'feed' ? feedList.filter((i) => i.key !== key) : feedList,
      inboxList: which === 'inbox' ? inboxList.filter((i) => i.key !== key) : inboxList,
      snoozedList: nextSnoozed,
    })
    // Advance if there's somewhere to go; otherwise STAY on the handled item
    // (the viewer keeps it — an emptied list must not blank the viewer).
    if (next) get().select(next)
  },

  restore: (key) => { handledKeys.delete(key) },

  handleSelected: (verb) => {
    const { selected, snoozedList } = get()
    if (!selected) return
    const which = get().listOf(selected.key)
    const list = which === 'feed' ? visibleFeed(get()) : which === 'snoozed' ? snoozedList : visibleInbox(get())
    const found = list.find((i) => i.key === selected.key)
    // A selection carried into the snoozed view from the live list isn't a
    // snoozed row — there's nothing here to act on.
    if (!found && which === 'snoozed') return
    const item = found ?? selected

    if (verb === 'snooze') {
      // The picker owns the rest: time choice → applySnooze → dropAndAdvance.
      // On a snoozed row this is a re-snooze (new time replaces the old).
      useUiStore.getState().openSnoozePicker({ source: item.source, sourceId: item.sourceId, key: item.key, origin: 'inbox' })
      return
    }

    if (which === 'snoozed') {
      // In the snoozed view "done" means bring it back now.
      get().dropAndAdvance(item.key)
      void unsnoozeItem(item).then(() => { get().restore(item.key); return get().rebuild() })
      return
    }

    get().dropAndAdvance(item.key)
    // `advance: false` — this pane just moved its own selection; the mail
    // store must not step to ITS list neighbour and mark that one read.
    if (item.source === 'mail') useInboxStore.getState().archiveThread(item.sourceId, { advance: false })
    else if (item.source === 'chat') void useChatStore.getState().markRoomRead(item.sourceId)
    else if (item.source === 'agent') useAgentStore.getState().markSessionRead(item.sourceId)
    else void useFeedStore.getState().markRead(item.sourceId)
  },
}))

/** The inbox list as displayed — source-filtered. Nav/handle walk THIS so
 *  j/k and advance-after-handle stay inside the filtered view; the tab badge
 *  deliberately keeps counting the full list. */
export function visibleInbox(s: Pick<UnifiedInboxState, 'inboxList' | 'inboxFilter'>): InboxItem[] {
  return s.inboxFilter ? s.inboxList.filter((i) => i.source === s.inboxFilter) : s.inboxList
}

/** The feed list as displayed — platform-filtered. Same contract as
 *  visibleInbox: nav/handle walk this; the header count shows it too. */
export function visibleFeed(s: Pick<UnifiedInboxState, 'feedList' | 'feedFilter'>): InboxItem[] {
  return filterByFeedKind(s.feedList, s.feedFilter)
}
