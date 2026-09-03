// Pure routing + prioritisation for the unified Inbox pane.

import type { DbThread } from '@/gmail/types'
import type { DbChatRoom } from '@/matrix/types'
import type { FeedItem, FeedSubscription } from '@/store/feeds'
import { isHiddenFolder } from '@/feeds/hidden-folders'
import { FEED_KINDS, feedKind, type FeedKind } from '@/feeds/feed-kind'
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
    sla: { dmHours?: number; rooms?: Record<string, number> }
  }>
  return {
    chat: { default: r.chat?.default ?? DEFAULT_RULES.chat.default, rooms: r.chat?.rooms ?? {} },
    mail: { default: r.mail?.default ?? DEFAULT_RULES.mail.default, senders: r.mail?.senders ?? {} },
    feeds: { default: r.feeds?.default ?? DEFAULT_RULES.feeds.default, feeds: r.feeds?.feeds ?? {} },
    sla: { dmHours: r.sla?.dmHours ?? DEFAULT_RULES.sla.dmHours, rooms: r.sla?.rooms ?? {} },
  }
}

/** UNREAD DM unanswered past its SLA window: the other side spoke after my
 *  last reply, and that inbound has aged past the window. Overdue is an
 *  escalation of an unread thread, never a re-admission of a read one —
 *  marking a thread read means "seen, decided not to reply" (Yousef,
 *  ^neat-bass). Groups have no default SLA (per-room override can add one);
 *  window 0 disables. */
export function isOverdue(r: DbChatRoom, rules: InboxRules, now: number): boolean {
  if (!r.isUnread && !r.manualUnread) return false
  const hours = rules.sla.rooms[r.id] ?? (r.isDirect ? rules.sla.dmHours : 0)
  if (!hours) return false
  const inbound = r.lastInboundTs ?? 0
  if (!inbound) return false
  if ((r.lastOutboundTs ?? 0) >= inbound) return false
  return now - inbound > hours * 3_600_000
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
    routeKey: t.fromEmail?.toLowerCase() ?? '',
  }
}

export function roomToItem(r: DbChatRoom, rules: InboxRules, now?: number): InboxItem {
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
    routeKey: r.id,
    isDirect: r.isDirect,
    ...(now !== undefined && isOverdue(r, rules, now) ? { overdue: true } : {}),
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
  lastTextSnippet?: string
  hasUnread?: boolean
  needsAttention?: { ts: number; snippet: string } | null
  isAl?: boolean
  agentKey?: string
}

/** Unread agent sessions demand handling (mark read / reply / review), so
 *  they're inbox-shaped by definition — no routing rules apply. */
export function sessionIsLive(s: AgentSessionLike): boolean {
  return !s.isAl && (!!s.hasUnread || !!s.needsAttention)
}

/** `reviewKeys` = every `@key` owning an Under Review card across all
 *  boards (SpaceSummary.reviewAgentKeys, flattened) — the session's card
 *  being in review is what makes it a hand-back. */
export function sessionToItem(s: AgentSessionLike, reviewKeys?: ReadonlySet<string>): InboxItem {
  const idle = s.status !== 'running'
  return {
    key: `agent:${s.id}`,
    source: 'agent',
    sourceId: s.id,
    header: (s.name || s.prompt.slice(0, 40)).replace(/\s\(fork\)$/, ''),
    body: s.needsAttention?.snippet ?? s.lastTextSnippet ?? '',
    ts: s.lastActivityAt ?? s.createdAt,
    route: 'inbox',
    attention: !!s.needsAttention,
    ...(idle ? { idle: true } : {}),
    ...(idle && s.agentKey && reviewKeys?.has(s.agentKey) ? { review: true } : {}),
    ...(s.agentKey ? { agentKey: s.agentKey } : {}),
  }
}

/** A card this agent owns that is sitting in Under Review, with what the
 *  approve button needs to move it: which project's board, how to address
 *  the card on `/board/:project/move`, and the target column. */
export interface ReviewHandback {
  project: string
  /** `^id` when stamped, else the card text (BoardOps resolves either). */
  query: string
  text: string
  /** Null when the board has no Done-like column — approve is impossible. */
  doneColumn: string | null
}

/** Minimal SpaceSummary shape — the hub fields are optional-guarded because
 *  the SPA reader ships before the hub writer (HMR vs restart). */
export interface SpaceReviewLike {
  kind: 'project' | 'area'
  slug: string
  reviewCards?: Array<{ blockId: string | null; text: string; agentKey: string | null }>
  doneColumn?: string | null
}

/** Under-Review cards owned by `agentKey` across every project board. */
export function reviewHandbacksFor(agentKey: string | null | undefined, spaces: ReadonlyArray<SpaceReviewLike>): ReviewHandback[] {
  if (!agentKey) return []
  const out: ReviewHandback[] = []
  for (const s of spaces) {
    if (s.kind !== 'project') continue
    for (const c of s.reviewCards ?? []) {
      if (c.agentKey !== agentKey) continue
      out.push({ project: s.slug, query: c.blockId ? `^${c.blockId}` : c.text, text: c.text, doneColumn: s.doneColumn ?? null })
    }
  }
  return out
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
    routeKey: i.feedId,
    ...(isHiddenFolder(feed?.folder) ? { hiddenFolder: true } : {}),
    feedKind: feedKind(feed),
    ...(feed?.imageUrl ? { icon: feed.imageUrl } : {}),
    ...(i.imageUrl ? { image: i.imageUrl } : {}),
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
// Inbox ordering. "Blocked on Yousef" bands first — overdue DMs, agents
// asking for him, review hand-backs (turn ended + card Under Review) — then
// chat+mail by recency, then the remaining unread agents split finished
// (idle) above still-running, then promoted/inbox-routed feed reading;
// recency within each band. Agent tiers per Yousef (^lean-deer): a
// hand-back beats a merely-finished agent, which beats one still typing.
// ---------------------------------------------------------------------------

function band(i: InboxItem): number {
  if (i.overdue) return 0
  if (i.source === 'agent') {
    if (i.attention) return 1
    if (i.review) return 2
    return i.idle ? 4 : 5
  }
  // Chat and mail share ONE recency band — fresh mail beats stale chats
  // (a strict chat-above-mail split buried today's mail under week-old
  // group unreads; Yousef's call 2026-08-29).
  if (i.source === 'chat' || i.source === 'mail') return 3
  return 6
}

export function sortInbox(items: InboxItem[]): InboxItem[] {
  return [...items].sort((a, b) => band(a) - band(b) || b.ts - a.ts)
}

export function sortFeed(items: InboxItem[]): InboxItem[] {
  return [...items].sort((a, b) => b.ts - a.ts)
}

/** Feed-column display mode: hidden-folder items (X posts) are suppressed by
 *  default and shown EXCLUSIVELY in 'x' mode. Applies to the feed column
 *  only — an item explicitly routed to inbox was a deliberate override. */
export type FeedMode = 'default' | 'x'

export function filterByFeedMode(items: InboxItem[], mode: FeedMode): InboxItem[] {
  return items.filter((i) => (mode === 'x' ? !!i.hiddenFolder : !i.hiddenFolder))
}

/** Feed-column platform filter (the Feed twin of the Inbox source chips):
 *  null = everything, else only items whose feed is of that kind. Non-feed
 *  items (a chat/mail source demoted to Feed) carry no kind and are kept
 *  only when unfiltered. */
export function filterByFeedKind(items: InboxItem[], kind: FeedKind | null): InboxItem[] {
  return kind ? items.filter((i) => i.feedKind === kind) : items
}

/** Which platform chips to offer: kinds present in the list, in FEED_KINDS
 *  order, with per-kind counts (chip tooltips). */
export function feedKindsPresent(items: InboxItem[]): Array<{ kind: FeedKind; count: number }> {
  const counts = new Map<FeedKind, number>()
  for (const i of items) if (i.feedKind) counts.set(i.feedKind, (counts.get(i.feedKind) ?? 0) + 1)
  return FEED_KINDS.filter((k) => counts.has(k)).map((k) => ({ kind: k, count: counts.get(k)! }))
}

/** The item to land on after handling `key` (archive/read/snooze): the next
 *  one down, else the previous (end of list), else nothing — mirrors the mail
 *  pane's archive-advance. */
export function nextAfterHandle(items: InboxItem[], key: string): InboxItem | null {
  const idx = items.findIndex((i) => i.key === key)
  if (idx < 0) return null
  return items[idx + 1] ?? items[idx - 1] ?? null
}
