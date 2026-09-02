import { describe, it, expect } from 'vitest'
import type { DbThread } from '@/gmail/types'
import type { DbChatRoom } from '@/matrix/types'
import type { FeedItem } from '@/store/feeds'
import { DEFAULT_RULES, type InboxRules } from '@/inbox/types'
import {
  feedItemToItem, feedKindsPresent, filterByFeedKind, filterByFeedMode, isOverdue, nextAfterHandle, normalizeRules, roomIsLive, roomToItem,
  sessionIsLive, sessionToItem, sortFeed, sortInbox, threadIsLive, threadToItem,
  type AgentSessionLike,
} from '@/inbox/route'

const NOW = 1_700_000_000_000

function thread(over: Partial<DbThread> = {}): DbThread {
  return {
    id: 't1', historyId: 'h', snippet: 'snippet', subject: 'Subject',
    from: 'Alice', fromEmail: 'alice@example.com', date: NOW - 1000,
    messageCount: 1, isUnread: true, labelIds: [], hasAttachments: false,
    ...over,
  }
}

function room(over: Partial<DbChatRoom> = {}): DbChatRoom {
  return {
    id: '!r1:hs', name: 'Bob', isDirect: true, memberCount: 2,
    lastMessageTime: NOW - 2000, isUnread: true, isMuted: false,
    isLowPriority: false, isEncrypted: true,
    ...over,
  }
}

function feedItem(over: Partial<FeedItem> = {}): FeedItem {
  return {
    id: 'f1', feedId: 'feed-a', title: 'Post', link: 'https://x', content: '',
    contentSnippet: 'snip', publishedAt: new Date(NOW - 3000).toISOString(),
    ...over,
  }
}

describe('routing', () => {
  it('defaults: mail+chat → inbox, feeds → feed', () => {
    expect(threadToItem(thread(), DEFAULT_RULES).route).toBe('inbox')
    expect(roomToItem(room(), DEFAULT_RULES).route).toBe('inbox')
    expect(feedItemToItem(feedItem(), undefined, DEFAULT_RULES)?.route).toBe('feed')
  })

  it('per-source overrides win over defaults', () => {
    const rules: InboxRules = {
      chat: { default: 'inbox', rooms: { '!r1:hs': 'feed' } },
      mail: { default: 'inbox', senders: { 'alice@example.com': 'feed' } },
      feeds: { default: 'feed', feeds: { 'feed-a': 'inbox' } },
      sla: { dmHours: 24, rooms: {} },
    }
    expect(roomToItem(room(), rules).route).toBe('feed')
    expect(threadToItem(thread(), rules).route).toBe('feed')
    expect(feedItemToItem(feedItem(), undefined, rules)?.route).toBe('inbox')
  })

  it('a hidden-routed feed adapts to null (dropped from the pane)', () => {
    const rules = normalizeRules({ feeds: { feeds: { 'feed-a': 'hidden' } } })
    expect(feedItemToItem(feedItem(), undefined, rules)).toBeNull()
    expect(feedItemToItem(feedItem({ feedId: 'feed-b' }), undefined, rules)).not.toBeNull()
  })

  it('mail sender override matches case-insensitively', () => {
    const rules = normalizeRules({ mail: { senders: { 'alice@example.com': 'feed' } } })
    expect(threadToItem(thread({ fromEmail: 'Alice@Example.com' }), rules).route).toBe('feed')
  })

  it('normalizeRules fills missing branches', () => {
    const r = normalizeRules({ feeds: { default: 'inbox' } })
    expect(r.feeds.default).toBe('inbox')
    expect(r.chat.default).toBe('inbox')
    expect(r.mail.senders).toEqual({})
  })

  it('hidden-FOLDER feeds flag the item (case-insensitive), others do not', () => {
    const xFeed = { id: 'feed-a', title: 'Someone on X', xmlUrl: 'u', folder: 'X', addedAt: '' }
    const other = { id: 'feed-a', title: 'Blog', xmlUrl: 'u', folder: 'tech', addedAt: '' }
    expect(feedItemToItem(feedItem(), xFeed, DEFAULT_RULES)?.hiddenFolder).toBe(true)
    expect(feedItemToItem(feedItem(), other, DEFAULT_RULES)?.hiddenFolder).toBeUndefined()
    expect(feedItemToItem(feedItem(), undefined, DEFAULT_RULES)?.hiddenFolder).toBeUndefined()
  })
})

describe('feed mode', () => {
  const xItem = feedItemToItem(feedItem(), { id: 'feed-a', title: 'X acct', xmlUrl: 'u', folder: 'x', addedAt: '' }, DEFAULT_RULES)!
  const normal = feedItemToItem(feedItem({ id: 'f2', feedId: 'feed-b' }), { id: 'feed-b', title: 'Blog', xmlUrl: 'u', folder: null, addedAt: '' }, DEFAULT_RULES)!

  it('default mode hides hidden-folder items completely', () => {
    expect(filterByFeedMode([xItem, normal], 'default')).toEqual([normal])
  })

  it('x mode shows ONLY hidden-folder items', () => {
    expect(filterByFeedMode([xItem, normal], 'x')).toEqual([xItem])
  })
})

describe('feed kind', () => {
  const yt = { id: 'feed-a', title: 'Chan', xmlUrl: 'https://www.youtube.com/feeds/videos.xml?channel_id=c', folder: 'YouTube', addedAt: '' }
  const blog = { id: 'feed-b', title: 'Blog', xmlUrl: 'https://yaz.in/feed.xml', folder: null, addedAt: '', imageUrl: 'https://yaz.in/icon.png' }
  const ytItem = feedItemToItem(feedItem({ imageUrl: 'https://i.ytimg.com/vi/x/hq.jpg' }), yt, DEFAULT_RULES)!
  const blogItem = feedItemToItem(feedItem({ id: 'f2', feedId: 'feed-b' }), blog, DEFAULT_RULES)!

  it('items carry their feed kind, source icon and item thumbnail', () => {
    expect(ytItem.feedKind).toBe('youtube')
    expect(ytItem.image).toBe('https://i.ytimg.com/vi/x/hq.jpg')
    expect(ytItem.icon).toBeUndefined()
    expect(blogItem.feedKind).toBe('rss')
    expect(blogItem.icon).toBe('https://yaz.in/icon.png')
    expect(blogItem.image).toBeUndefined()
    expect(feedItemToItem(feedItem(), undefined, DEFAULT_RULES)?.feedKind).toBe('rss')
  })

  it('filterByFeedKind narrows to one platform, null = everything', () => {
    const demotedMail = threadToItem(thread(), DEFAULT_RULES)
    expect(filterByFeedKind([ytItem, blogItem, demotedMail], 'youtube')).toEqual([ytItem])
    expect(filterByFeedKind([ytItem, blogItem, demotedMail], 'rss')).toEqual([blogItem])
    expect(filterByFeedKind([ytItem, blogItem, demotedMail], null)).toHaveLength(3)
  })

  it('feedKindsPresent lists kinds in chip order with counts', () => {
    expect(feedKindsPresent([blogItem, ytItem, ytItem])).toEqual([
      { kind: 'youtube', count: 2 },
      { kind: 'rss', count: 1 },
    ])
    expect(feedKindsPresent([threadToItem(thread(), DEFAULT_RULES)])).toEqual([])
  })
})

describe('row shape', () => {
  it('DM: header = person, body drops the redundant sender prefix', () => {
    const i = roomToItem(room({ lastMessageSender: 'Bob', lastMessageBody: 'hey' }), DEFAULT_RULES)
    expect(i.header).toBe('Bob')
    expect(i.body).toBe('hey')
  })

  it('group: header = group name, body keeps the sender prefix', () => {
    const i = roomToItem(room({ name: 'The Gang', isDirect: false, lastMessageSender: 'Bob', lastMessageBody: 'hey' }), DEFAULT_RULES)
    expect(i.header).toBe('The Gang')
    expect(i.body).toBe('Bob: hey')
  })

  it('mail: header = sender, body = subject', () => {
    const i = threadToItem(thread(), DEFAULT_RULES)
    expect(i.header).toBe('Alice')
    expect(i.body).toBe('Subject')
  })

  it('feed: header = feed title, body = item title', () => {
    const i = feedItemToItem(feedItem(), { id: 'feed-a', title: 'HN', xmlUrl: '', folder: null, addedAt: '' }, DEFAULT_RULES)
    expect(i?.header).toBe('HN')
    expect(i?.body).toBe('Post')
  })
})

describe('agent sessions', () => {
  function session(over: Partial<AgentSessionLike> = {}): AgentSessionLike {
    return { id: 's1', name: 'Console general', prompt: 'do things', status: 'idle', createdAt: NOW - 5000, ...over }
  }

  it('live = unread or attention, Al excluded', () => {
    expect(sessionIsLive(session())).toBe(false)
    expect(sessionIsLive(session({ hasUnread: true }))).toBe(true)
    expect(sessionIsLive(session({ needsAttention: { ts: NOW, snippet: 'help' } }))).toBe(true)
    expect(sessionIsLive(session({ hasUnread: true, isAl: true }))).toBe(false)
  })

  it('adapts: header = name sans (fork), body = attention snippet, always inbox', () => {
    const i = sessionToItem(session({ name: 'Rosy finch (fork)', needsAttention: { ts: NOW, snippet: 'need a review' }, lastActivityAt: NOW - 100 }))
    expect(i.header).toBe('Rosy finch')
    expect(i.body).toBe('need a review')
    expect(i.route).toBe('inbox')
    expect(i.attention).toBe(true)
    expect(i.ts).toBe(NOW - 100)
  })

  it('attention sessions band above chat+mail; plain unread below them', () => {
    const items = [
      threadToItem(thread({ date: NOW - 1000 }), DEFAULT_RULES),
      roomToItem(room({ id: '!dm:hs', lastMessageTime: NOW }), DEFAULT_RULES),
      sessionToItem(session({ id: 's-plain', hasUnread: true, lastActivityAt: NOW })),
      sessionToItem(session({ id: 's-attn', needsAttention: { ts: NOW, snippet: 'x' }, lastActivityAt: NOW })),
    ]
    expect(sortInbox(items).map((i) => i.sourceId)).toEqual(['s-attn', '!dm:hs', 't1', 's-plain'])
  })
})

describe('SLA / overdue', () => {
  const H = 3_600_000
  const overdueDm = () => room({ lastInboundTs: NOW - 25 * H, lastOutboundTs: NOW - 30 * H, isUnread: false })

  it('DM unanswered >24h is overdue; replying clears it', () => {
    expect(isOverdue(overdueDm(), DEFAULT_RULES, NOW)).toBe(true)
    expect(isOverdue(room({ lastInboundTs: NOW - 25 * H, lastOutboundTs: NOW - 1 * H }), DEFAULT_RULES, NOW)).toBe(false)
    expect(isOverdue(room({ lastInboundTs: NOW - 2 * H, lastOutboundTs: NOW - 30 * H }), DEFAULT_RULES, NOW)).toBe(false)
  })

  it('groups have no default SLA; per-room override adds one (0 disables)', () => {
    const g = room({ isDirect: false, lastInboundTs: NOW - 48 * H, lastOutboundTs: NOW - 96 * H })
    expect(isOverdue(g, DEFAULT_RULES, NOW)).toBe(false)
    const withRule = normalizeRules({ sla: { rooms: { '!r1:hs': 24 } } })
    expect(isOverdue(g, withRule, NOW)).toBe(true)
    const disabled = normalizeRules({ sla: { rooms: { '!r1:hs': 0 } } })
    expect(isOverdue(overdueDm(), disabled, NOW)).toBe(false)
  })

  it('no inbound recorded (pre-restart rooms) → never overdue', () => {
    expect(isOverdue(room({ isUnread: false }), DEFAULT_RULES, NOW)).toBe(false)
  })

  it('an overdue READ DM re-enters membership; marking it overdue tops the sort', () => {
    expect(roomIsLive(overdueDm(), NOW, DEFAULT_RULES)).toBe(true)
    expect(roomIsLive(room({ isUnread: false }), NOW, DEFAULT_RULES)).toBe(false)
    const items = [
      sessionToItem({ id: 's-attn', name: 'A', prompt: '', status: 'idle', createdAt: NOW, needsAttention: { ts: NOW, snippet: 'x' } }),
      roomToItem(overdueDm(), DEFAULT_RULES, NOW),
      roomToItem(room({ id: '!fresh:hs', lastMessageTime: NOW }), DEFAULT_RULES, NOW),
    ]
    expect(sortInbox(items).map((i) => i.sourceId)).toEqual(['!r1:hs', 's-attn', '!fresh:hs'])
  })
})

describe('membership', () => {
  it('snoozed thread is not live until due', () => {
    expect(threadIsLive(thread({ snoozedUntil: NOW + 60_000 }), NOW)).toBe(false)
    expect(threadIsLive(thread({ snoozedUntil: NOW - 60_000 }), NOW)).toBe(true)
    expect(threadIsLive(thread(), NOW)).toBe(true)
  })

  it('room live = unread OR manualUnread, minus muted/lowpriority/snoozed', () => {
    expect(roomIsLive(room(), NOW)).toBe(true)
    expect(roomIsLive(room({ isUnread: false }), NOW)).toBe(false)
    expect(roomIsLive(room({ isUnread: false, manualUnread: true }), NOW)).toBe(true)
    expect(roomIsLive(room({ isMuted: true }), NOW)).toBe(false)
    expect(roomIsLive(room({ isLowPriority: true }), NOW)).toBe(false)
    expect(roomIsLive(room({ snoozedUntil: NOW + 1000 }), NOW)).toBe(false)
  })
})

describe('ordering', () => {
  it('inbox: chat+mail share one recency band — fresh mail beats stale chats', () => {
    const items = [
      feedItemToItem(feedItem({ id: 'f-new', publishedAt: new Date(NOW).toISOString() }), undefined, normalizeRules({ feeds: { default: 'inbox' } }))!,
      threadToItem(thread({ id: 't-new', date: NOW - 1000 }), DEFAULT_RULES),
      roomToItem(room({ id: '!group-old:hs', isDirect: false, lastMessageTime: NOW - 8000 }), DEFAULT_RULES),
      roomToItem(room({ id: '!dm-old:hs', lastMessageTime: NOW - 5000 }), DEFAULT_RULES),
      roomToItem(room({ id: '!dm-new:hs', lastMessageTime: NOW }), DEFAULT_RULES),
    ]
    const sorted = sortInbox(items).map((i) => i.sourceId)
    expect(sorted).toEqual(['!dm-new:hs', 't-new', '!dm-old:hs', '!group-old:hs', 'f-new'])
  })

  it('feed list is pure reverse-chron', () => {
    const items = [
      feedItemToItem(feedItem({ id: 'a', publishedAt: new Date(NOW - 100).toISOString() }), undefined, DEFAULT_RULES)!,
      feedItemToItem(feedItem({ id: 'b', publishedAt: new Date(NOW).toISOString() }), undefined, DEFAULT_RULES)!,
    ]
    expect(sortFeed(items).map((i) => i.sourceId)).toEqual(['b', 'a'])
  })
})

describe('nextAfterHandle', () => {
  const items = ['a', 'b', 'c'].map((id) =>
    feedItemToItem(feedItem({ id }), undefined, DEFAULT_RULES)!)

  it('advances to the next item', () => {
    expect(nextAfterHandle(items, 'feed:a')?.sourceId).toBe('b')
    expect(nextAfterHandle(items, 'feed:b')?.sourceId).toBe('c')
  })

  it('falls back to the previous item at the end of the list', () => {
    expect(nextAfterHandle(items, 'feed:c')?.sourceId).toBe('b')
  })

  it('returns null for a single-item list or unknown key', () => {
    expect(nextAfterHandle([items[0]!], 'feed:a')).toBeNull()
    expect(nextAfterHandle(items, 'feed:zzz')).toBeNull()
  })
})
