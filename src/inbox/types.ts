// Unified Inbox pane — shared types.
//
// The pane composes three existing sources (mail threads, chat rooms, feed
// items) into two lists: "feed" (casual browse, no obligation) and "inbox"
// (inbox-zero: everything here must be handled). Membership is DERIVED from
// each source's existing semantics — no new read/done state anywhere:
//   mail  → unarchived + unsnoozed threads
//   chat  → unread rooms (incl. manual-unread; marking read = handled)
//   feeds → unread items
// Routing decides WHICH list a source's items land in.

import type { FeedKind } from '@/feeds/feed-kind'

export type InboxSource = 'mail' | 'chat' | 'feed' | 'agent'
export type Route = 'feed' | 'inbox'
/** Feeds get a third option: hidden from this pane entirely (the legacy
 *  Feeds tab still shows them — a display filter, not read state). */
export type FeedRoute = Route | 'hidden'

export interface InboxItem {
  /** `${source}:${sourceId}` — unique across sources. */
  key: string
  source: InboxSource
  /** Thread id / room id / feed-item id in the source store. */
  sourceId: string
  /** Row header: the person (DM/mail sender), group name, or feed title. */
  header: string
  /** Row body: message text, mail subject, or feed-item title. For group
   *  chats the sender prefixes here (`Sender: text`), since the header
   *  carries the group name. */
  body: string
  /** Chat bridge network (whatsapp/slack/…) — drives the channel icon. */
  network?: string
  ts: number
  route: Route
  /** Chat only: DM vs group — drives inbox ordering. */
  isDirect?: boolean
  /** Agent only: session flagged @amar / pending question — tops the inbox. */
  attention?: boolean
  /** Chat only: DM unanswered past its SLA window — tops the inbox. */
  overdue?: boolean
  /** The rules-override key this item's SOURCE routes by (room id / sender
   *  email / feed id) — what promote/demote writes. Absent for agents (they
   *  don't route). */
  routeKey?: string
  /** Feed only: the feed lives in a hidden FOLDER (store/feeds HIDDEN_FOLDERS,
   *  e.g. X) — suppressed from the Feed column by default, shown exclusively
   *  in its opt-in mode. Distinct from the 'hidden' FeedRoute (dropped from
   *  the pane entirely). */
  hiddenFolder?: boolean
  /** Feed only: platform the feed comes from (youtube/reddit/hn/…) — drives
   *  the Feed column's source-filter chips and the row glyph. */
  feedKind?: FeedKind
  /** Feed only: the SOURCE's favicon/logo (feed.imageUrl) — the row glyph
   *  for plain-RSS feeds that have one. */
  icon?: string
  /** Feed only: the ITEM's thumbnail (video still, post image). */
  image?: string
}

/** Per-source routing rules, persisted hub-side (inbox-rules.json).
 *  Overrides are keyed by source id (room id, feed id, mail sender email).
 *  Absent everything → DEFAULT_RULES. */
export interface InboxRules {
  chat: { default: Route; rooms: Record<string, Route> }
  mail: { default: Route; senders: Record<string, Route> }
  feeds: { default: Route; feeds: Record<string, FeedRoute> }
  /** SLA windows (hours). A DM whose last inbound outdates my last reply by
   *  more than dmHours is OVERDUE — banded to the very top. Per-room
   *  overrides in `rooms` (0 = no SLA for that room). */
  sla: { dmHours: number; rooms: Record<string, number> }
}

/** Conservative defaults: nothing silently drops out of "must handle".
 *  Chat keeps its inbox-zero (all rooms → inbox) and mail is inbox by
 *  definition; feeds are browse-casual. Opt sources OUT via overrides. */
export const DEFAULT_RULES: InboxRules = {
  chat: { default: 'inbox', rooms: {} },
  mail: { default: 'inbox', senders: {} },
  feeds: { default: 'feed', feeds: {} },
  sla: { dmHours: 24, rooms: {} },
}
