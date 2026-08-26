// Pure routing + prioritisation for the unified Inbox pane.

import type { DbThread } from '@/gmail/types'
import type { DbChatRoom } from '@/matrix/types'
import type { FeedItem, FeedSubscription } from '@/store/feeds'
import { DEFAULT_RULES, type InboxItem, type InboxRules, type Route } from './types'

export function routeForRoom(room: DbChatRoom, rules: InboxRules): Route {
  return rules.chat.rooms[room.id] ?? rules.chat.default
}

export function routeForThread(thread: DbThread, rules: InboxRules): Route {
  return rules.mail.senders[thread.fromEmail?.toLowerCase() ?? ''] ?? rules.mail.default
}

export function routeForFeed(feedId: string, rules: InboxRules): Route {
  return rules.feeds.feeds[feedId] ?? rules.feeds.default
}

/** Fill any missing branches of a partially-persisted rules file. */
export function normalizeRules(raw: unknown): InboxRules {
  const r = (raw ?? {}) as Partial<Record<keyof InboxRules, { default?: Route; rooms?: Record<string, Route>; senders?: Record<string, Route>; feeds?: Record<string, Route> }>>
  return {
    chat: { default: r.chat?.default ?? DEFAULT_RULES.chat.default, rooms: r.chat?.rooms ?? {} },
    mail: { default: r.mail?.default ?? DEFAULT_RULES.mail.default, senders: r.mail?.senders ?? {} },
    feeds: { default: r.feeds?.default ?? DEFAULT_RULES.feeds.default, feeds: r.feeds?.feeds ?? {} },
  }
}

// ---------------------------------------------------------------------------
// Adapters: source rows → InboxItem. Membership is derived — callers pass
// only rows that are currently "live" per the source's own semantics.
// ---------------------------------------------------------------------------

export function threadToItem(t: DbThread, rules: InboxRules): InboxItem {
  return {
    key: `mail:${t.id}`,
    source: 'mail',
    sourceId: t.id,
    title: t.subject || '(no subject)',
    preview: t.snippet,
    origin: t.from,
    ts: t.date,
    route: routeForThread(t, rules),
  }
}

export function roomToItem(r: DbChatRoom, rules: InboxRules): InboxItem {
  return {
    key: `chat:${r.id}`,
    source: 'chat',
    sourceId: r.id,
    title: r.name,
    preview: r.lastMessageSender ? `${r.lastMessageSender}: ${r.lastMessageBody ?? ''}` : (r.lastMessageBody ?? ''),
    origin: r.networkIcon ?? 'matrix',
    ts: r.lastMessageTime,
    route: routeForRoom(r, rules),
    isDirect: r.isDirect,
  }
}

export function feedItemToItem(i: FeedItem, feed: FeedSubscription | undefined, rules: InboxRules): InboxItem {
  return {
    key: `feed:${i.id}`,
    source: 'feed',
    sourceId: i.id,
    title: i.title,
    preview: i.contentSnippet,
    origin: feed?.title ?? '',
    ts: Date.parse(i.publishedAt) || 0,
    route: routeForFeed(i.feedId, rules),
  }
}

// ---------------------------------------------------------------------------
// Membership predicates — one place per source, mirroring existing semantics.
// ---------------------------------------------------------------------------

export function threadIsLive(t: DbThread, now: number): boolean {
  // ThreadList shows unarchived threads; snoozed hide until due. The Dexie
  // `threads` table only holds inbox threads (archive deletes the row), so
  // presence + unsnoozed is the whole test.
  return !t.snoozedUntil || t.snoozedUntil <= now
}

export function roomIsLive(r: DbChatRoom, now: number): boolean {
  if (r.snoozedUntil && r.snoozedUntil > now) return false
  if (r.isLowPriority || r.isMuted) return false
  return r.isUnread || !!r.manualUnread
}

// ---------------------------------------------------------------------------
// Inbox ordering (Phase 1: simple, deterministic — SLA engine is Phase 3).
// Chat DMs first, then group chats, then mail, then promoted/inbox-routed
// feed reading; recency within each band.
// ---------------------------------------------------------------------------

function band(i: InboxItem): number {
  if (i.source === 'chat') return i.isDirect ? 0 : 1
  if (i.source === 'mail') return 2
  return 3
}

export function sortInbox(items: InboxItem[]): InboxItem[] {
  return [...items].sort((a, b) => band(a) - band(b) || b.ts - a.ts)
}

export function sortFeed(items: InboxItem[]): InboxItem[] {
  return [...items].sort((a, b) => b.ts - a.ts)
}

/** The item to land on after handling `key` (archive/read/snooze): the next
 *  one down, else the previous (end of list), else nothing — mirrors the mail
 *  pane's archive-advance. */
export function nextAfterHandle(items: InboxItem[], key: string): InboxItem | null {
  const idx = items.findIndex((i) => i.key === key)
  if (idx < 0) return null
  return items[idx + 1] ?? items[idx - 1] ?? null
}
