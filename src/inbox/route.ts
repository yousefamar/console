// Pure routing + prioritisation for the unified Inbox pane.

import type { DbThread } from '@/gmail/types'
import type { DbChatRoom } from '@/matrix/types'
import type { FeedItem, FeedSubscription } from '@/store/feeds'
import { DEFAULT_RULES, type FeedRoute, type InboxItem, type InboxRules, type Route } from './types'

export function routeForRoom(room: DbChatRoom, rules: InboxRules): Route {
  return rules.chat.rooms[room.id] ?? rules.chat.default
}

export function routeForThread(thread: DbThread, rules: InboxRules): Route {
  return rules.mail.senders[thread.fromEmail?.toLowerCase() ?? ''] ?? rules.mail.default
}

export function routeForFeed(feedId: string, rules: InboxRules): FeedRoute {
  return rules.feeds.feeds[feedId] ?? rules.feeds.default
}

/** Fill any missing branches of a partially-persisted rules file. */
export function normalizeRules(raw: unknown): InboxRules {
  const r = (raw ?? {}) as Partial<{
    chat: { default?: Route; rooms?: Record<string, Route> }
    mail: { default?: Route; senders?: Record<string, Route> }
    feeds: { default?: Route; feeds?: Record<string, FeedRoute> }
  }>
  return {
    chat: { default: r.chat?.default ?? DEFAULT_RULES.chat.default, rooms: r.chat?.rooms ?? {} },
    mail: { default: r.mail?.default ?? DEFAULT_RULES.mail.default, senders: r.mail?.senders ?? {} },
    feeds: { default: r.feeds?.default ?? DEFAULT_RULES.feeds.default, feeds: r.feeds?.feeds ?? {} },
  }
}

// ---------------------------------------------------------------------------
// Adapters: source rows → InboxItem. Membership is derived — callers pass
// only rows that are currently "live" per the source's own semantics.
// Row shape: header = who/where (person, group, feed), body = what (message,
// subject, item title). A DM's body drops the redundant sender prefix — the
// header already names them.
// ---------------------------------------------------------------------------

export function threadToItem(t: DbThread, rules: InboxRules): InboxItem {
  return {
    key: `mail:${t.id}`,
    source: 'mail',
    sourceId: t.id,
    header: t.from,
    body: t.subject || '(no subject)',
    ts: t.date,
    route: routeForThread(t, rules),
  }
}

export function roomToItem(r: DbChatRoom, rules: InboxRules): InboxItem {
  const sender = r.lastMessageSender
  const text = r.lastMessageBody ?? ''
  // Group rooms keep the sender prefix (the header names the GROUP); DMs
  // drop it when the sender IS the room's namesake — their name is already
  // the header, repeating it in the body is noise.
  const body = !sender || (r.isDirect && sender === r.name) ? text : `${sender}: ${text}`
  return {
    key: `chat:${r.id}`,
    source: 'chat',
    sourceId: r.id,
    header: r.name,
    body,
    network: r.networkIcon,
    ts: r.lastMessageTime,
    route: routeForRoom(r, rules),
    isDirect: r.isDirect,
  }
}

/** Minimal session shape the adapter needs (mirrors SessionInfo fields). */
export interface AgentSessionLike {
  id: string
  name?: string
  prompt: string
  status: 'running' | 'idle' | 'ended'
  createdAt: number
  lastActivityAt?: number
  hasUnread?: boolean
  needsAttention?: { ts: number; snippet: string } | null
  isAl?: boolean
}

/** Unread agent sessions demand handling (mark read / reply / review), so
 *  they're inbox-shaped by definition — no routing rules apply. */
export function sessionIsLive(s: AgentSessionLike): boolean {
  return !s.isAl && (!!s.hasUnread || !!s.needsAttention)
}

export function sessionToItem(s: AgentSessionLike): InboxItem {
  return {
    key: `agent:${s.id}`,
    source: 'agent',
    sourceId: s.id,
    header: (s.name || s.prompt.slice(0, 40)).replace(/\s\(fork\)$/, ''),
    body: s.needsAttention?.snippet ?? '',
    ts: s.lastActivityAt ?? s.createdAt,
    route: 'inbox',
    attention: !!s.needsAttention,
  }
}

export function feedItemToItem(i: FeedItem, feed: FeedSubscription | undefined, rules: InboxRules): InboxItem | null {
  const route = routeForFeed(i.feedId, rules)
  if (route === 'hidden') return null
  return {
    key: `feed:${i.id}`,
    source: 'feed',
    sourceId: i.id,
    header: feed?.title ?? '',
    body: i.title,
    ts: Date.parse(i.publishedAt) || 0,
    route,
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
// Attention-flagged agents first (they're blocked on Yousef), then chat DMs,
// groups, mail, other unread agents, then promoted/inbox-routed feed
// reading; recency within each band.
// ---------------------------------------------------------------------------

function band(i: InboxItem): number {
  if (i.source === 'agent') return i.attention ? 0 : 4
  if (i.source === 'chat') return i.isDirect ? 1 : 2
  if (i.source === 'mail') return 3
  return 5
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
