import { describe, it, expect } from 'vitest'
import type { DbThread } from '@/gmail/types'
import type { DbChatRoom } from '@/matrix/types'
import type { FeedItem } from '@/store/feeds'
import { DEFAULT_RULES, itemKey, type InboxRules } from '@/inbox/types'
import {
  blockedCardsFor, feedItemToItem, feedKindsPresent, filterByFeedKind, filterByFeedMode, isOverdue, nextAfterHandle, normalizeRules, ownedCardText, reviewHandbacksFor, roomIsLive, roomToItem,
  sessionContext, sessionIsLive, sessionToItem, sortFeed, sortInbox, threadIsLive, threadToItem,
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

  it('feed: header = ARTICLE title, body = feed name (the glyph already names the source)', () => {
    const i = feedItemToItem(feedItem(), { id: 'feed-a', title: 'HN', xmlUrl: '', folder: null, addedAt: '' }, DEFAULT_RULES)
    expect(i?.header).toBe('Post')
    expect(i?.body).toBe('HN')
  })
})

describe('agent sessions', () => {
  function session(over: Partial<AgentSessionLike> = {}): AgentSessionLike {
    return { id: 's1', name: 'Console general', prompt: 'do things', status: 'idle', createdAt: NOW - 5000, ...over }
  }

  it('live = finished-unread or attention, Al excluded', () => {
    expect(sessionIsLive(session())).toBe(false)
    expect(sessionIsLive(session({ hasUnread: true }))).toBe(true)
    expect(sessionIsLive(session({ needsAttention: { ts: NOW, snippet: 'help' } }))).toBe(true)
    expect(sessionIsLive(session({ hasUnread: true, isAl: true }))).toBe(false)
  })

  it('a RUNNING session stays out of the inbox unless it needs attention (^neat-fawn)', () => {
    // Unread text on a running session is a turn still being typed — nothing to act on.
    expect(sessionIsLive(session({ hasUnread: true, status: 'running' }))).toBe(false)
    // A question/approval blocking a running turn IS his to answer.
    expect(sessionIsLive(session({ status: 'running', needsAttention: { ts: NOW, snippet: 'ok to push?' } }))).toBe(true)
    // Ended sessions with unread text still surface (finished, unreviewed).
    expect(sessionIsLive(session({ hasUnread: true, status: 'ended' }))).toBe(true)
  })

  it('a session owning a #blocked card stays live once read, running or not (^sly-lynx)', () => {
    const blocked = new Set(['stuck-fork'])
    expect(sessionIsLive(session({ agentKey: 'stuck-fork' }), blocked)).toBe(true)
    expect(sessionIsLive(session({ agentKey: 'stuck-fork', status: 'running' }), blocked)).toBe(true)
    expect(sessionIsLive(session({ agentKey: 'other' }), blocked)).toBe(false)
    expect(sessionIsLive(session({ agentKey: 'stuck-fork', isAl: true }), blocked)).toBe(false)
  })

  it('adapts: header = name sans (fork), body = attention snippet, always inbox', () => {
    const i = sessionToItem(session({ name: 'Rosy finch (fork)', needsAttention: { ts: NOW, snippet: 'need a review' }, lastActivityAt: NOW - 100 }))
    expect(i.header).toBe('Rosy finch')
    expect(i.body).toBe('need a review')
    expect(i.route).toBe('inbox')
    expect(i.attention).toBe(true)
    expect(i.ts).toBe(NOW - 100)
  })

  it('context = the owning space title — project first, else first area, else none (^glad-finch)', () => {
    const titleOf = (slug: string) => ({ console: 'Console', dev: 'Dev' } as Record<string, string>)[slug]
    expect(sessionContext({ project: 'console', areas: ['dev'] }, titleOf)).toBe('Console')
    expect(sessionContext({ areas: ['dev', 'life'] }, titleOf)).toBe('Dev')
    expect(sessionContext({}, titleOf)).toBeUndefined()
    // Unknown slug (spaces list not loaded yet) falls back to the slug itself.
    expect(sessionContext({ project: 'astera' }, titleOf)).toBe('astera')
    const i = sessionToItem(session({ name: 'Glad finch (fork)', hasUnread: true, project: 'console' }), undefined, titleOf)
    expect(i.context).toBe('Console')
    expect(i.header).toBe('Glad finch')
    expect(sessionToItem(session({ hasUnread: true })).context).toBeUndefined()
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

  it('flags idle + review: turn ended, and @key owns an Under Review card', () => {
    const review = new Set(['console-general-lean-deer-fork'])
    const handback = sessionToItem(session({ hasUnread: true, agentKey: 'console-general-lean-deer-fork' }), review)
    expect(handback.idle).toBe(true)
    expect(handback.review).toBe(true)
    // Still running → not a hand-back yet even if its card sits in review.
    const running = sessionToItem(session({ hasUnread: true, status: 'running', agentKey: 'console-general-lean-deer-fork' }), review)
    expect(running.idle).toBeUndefined()
    expect(running.review).toBeUndefined()
    // Idle but its key owns no review card → plain finished agent.
    const finished = sessionToItem(session({ hasUnread: true, agentKey: 'other' }), review)
    expect(finished.idle).toBe(true)
    expect(finished.review).toBeUndefined()
    // No review set at all (spaces not loaded) → never a hand-back.
    expect(sessionToItem(session({ hasUnread: true, agentKey: 'console-general-lean-deer-fork' })).review).toBeUndefined()
  })

  it('agent tiers: attention → review hand-back → chat+mail → finished (running ones never get this far)', () => {
    const review = new Set(['reviewer'])
    const items = [
      // A running session that still made it in is one needing attention — it bands with attention, not below mail.
      sessionToItem(session({ id: 's-running-attn', status: 'running', needsAttention: { ts: NOW, snippet: 'y' }, lastActivityAt: NOW }), review),
      sessionToItem(session({ id: 's-idle', hasUnread: true, lastActivityAt: NOW }), review),
      threadToItem(thread({ date: NOW - 1000 }), DEFAULT_RULES),
      sessionToItem(session({ id: 's-review', hasUnread: true, agentKey: 'reviewer', lastActivityAt: NOW - 9000 }), review),
      sessionToItem(session({ id: 's-attn', needsAttention: { ts: NOW, snippet: 'x' }, lastActivityAt: NOW - 9000 }), review),
    ]
    expect(sortInbox(items).map((i) => i.sourceId)).toEqual(['s-running-attn', 's-attn', 's-review', 't1', 's-idle'])
  })

  it('attention outranks a review hand-back, and recency orders within a tier', () => {
    const review = new Set(['a', 'b'])
    const items = [
      sessionToItem(session({ id: 'old-review', hasUnread: true, agentKey: 'a', lastActivityAt: NOW - 5000 }), review),
      sessionToItem(session({ id: 'new-review', hasUnread: true, agentKey: 'b', lastActivityAt: NOW }), review),
      sessionToItem(session({ id: 'attn-review', agentKey: 'a', needsAttention: { ts: NOW, snippet: 'x' }, lastActivityAt: NOW - 99999 }), review),
    ]
    expect(sortInbox(items).map((i) => i.sourceId)).toEqual(['attn-review', 'new-review', 'old-review'])
  })

  it('carries the agentKey only when the session has one', () => {
    expect(sessionToItem(session({ agentKey: 'console-general-fork' })).agentKey).toBe('console-general-fork')
    expect(sessionToItem(session())).not.toHaveProperty('agentKey')
  })

  it('a #blocked card flags the session and bands it with attention, running or not (^mild-ibis)', () => {
    const blocked = new Set(['stuck-fork'])
    const idle = sessionToItem(session({ id: 's-blocked', hasUnread: true, agentKey: 'stuck-fork', lastActivityAt: NOW - 50_000 }), undefined, undefined, blocked)
    expect(idle.blocked).toBe(true)
    // Unlike review, blocked is not gated on idle — the stall is the fact.
    expect(sessionToItem(session({ status: 'running', needsAttention: { ts: NOW, snippet: 'x' }, agentKey: 'stuck-fork' }), undefined, undefined, blocked).blocked).toBe(true)
    expect(sessionToItem(session({ hasUnread: true, agentKey: 'other' }), undefined, undefined, blocked)).not.toHaveProperty('blocked')
    expect(sessionToItem(session({ hasUnread: true, agentKey: 'stuck-fork' }))).not.toHaveProperty('blocked')
    const items = [
      sessionToItem(session({ id: 's-review', hasUnread: true, agentKey: 'reviewer', lastActivityAt: NOW }), new Set(['reviewer']), undefined, blocked),
      threadToItem(thread({ date: NOW }), DEFAULT_RULES),
      idle,
      sessionToItem(session({ id: 's-attn', needsAttention: { ts: NOW, snippet: 'x' }, lastActivityAt: NOW - 60_000 }), undefined, undefined, blocked),
    ]
    expect(sortInbox(items).map((i) => i.sourceId)).toEqual(['s-blocked', 's-attn', 's-review', 't1'])
  })
})

describe('blocked cards (^mild-ibis)', () => {
  const spaces = [
    {
      kind: 'project' as const, slug: 'console',
      blockedCards: [
        { blockId: 'sly-hare', text: 'Need creds', agentKey: 'cg-sly-hare-fork' },
        { blockId: null, text: 'Hand-made', agentKey: 'cg-sly-hare-fork' },
        { blockId: 'dry-owl', text: 'Someone else', agentKey: 'other' },
      ],
    },
    { kind: 'area' as const, slug: 'dev', blockedCards: [{ blockId: 'x', text: 'never', agentKey: 'cg-sly-hare-fork' }] },
    { kind: 'project' as const, slug: 'old-hub' },
  ]

  it('joins the agentKey to its blocked cards, ^id first else text', () => {
    expect(blockedCardsFor('cg-sly-hare-fork', spaces)).toEqual([
      { project: 'console', query: '^sly-hare', text: 'Need creds' },
      { project: 'console', query: 'Hand-made', text: 'Hand-made' },
    ])
    expect(blockedCardsFor(undefined, spaces)).toEqual([])
    expect(blockedCardsFor('nobody', spaces)).toEqual([])
  })
})

describe('review hand-backs (^pale-tern)', () => {
  const spaces = [
    {
      kind: 'project' as const, slug: 'console', doneColumn: 'Done',
      reviewCards: [
        { blockId: 'bold-fox', text: 'Ship it', agentKey: 'cg-bold-fox-fork' },
        { blockId: null, text: 'Hand-made card', agentKey: 'cg-bold-fox-fork' },
        { blockId: 'dry-owl', text: 'Someone else', agentKey: 'other' },
      ],
    },
    { kind: 'project' as const, slug: 'astera', doneColumn: null, reviewCards: [{ blockId: 'teal-crab', text: 'Astera thing', agentKey: 'cg-bold-fox-fork' }] },
    { kind: 'area' as const, slug: 'dev', reviewCards: [{ blockId: 'x', text: 'never', agentKey: 'cg-bold-fox-fork' }] },
    { kind: 'project' as const, slug: 'old-hub' },
  ]

  it('joins the agentKey to its review cards across projects, ^id first else text', () => {
    expect(reviewHandbacksFor('cg-bold-fox-fork', spaces)).toEqual([
      { project: 'console', query: '^bold-fox', text: 'Ship it', doneColumn: 'Done' },
      { project: 'console', query: 'Hand-made card', text: 'Hand-made card', doneColumn: 'Done' },
      { project: 'astera', query: '^teal-crab', text: 'Astera thing', doneColumn: null },
    ])
  })

  it('no key, unknown key, or an older hub payload → nothing', () => {
    expect(reviewHandbacksFor(undefined, spaces)).toEqual([])
    expect(reviewHandbacksFor(null, spaces)).toEqual([])
    expect(reviewHandbacksFor('nobody', spaces)).toEqual([])
    expect(reviewHandbacksFor('cg-bold-fox-fork', [{ kind: 'project', slug: 'old-hub' }])).toEqual([])
  })
})

describe('card title as the row header (^jade-kiwi)', () => {
  const spaces = [
    {
      kind: 'project' as const, slug: 'console', doneColumn: 'Done',
      ownedCards: [
        { blockId: 'bold-fox', text: 'Working on the widget', agentKey: 'cg-bold-fox-fork' },
        { blockId: 'sly-hare', text: 'Need creds', agentKey: 'cg-sly-hare-fork' },
        { blockId: 'teal-crab', text: 'Ship it', agentKey: 'cg-teal-crab-fork' },
        { blockId: 'multi-a', text: 'In progress one', agentKey: 'multi' },
        { blockId: 'multi-b', text: 'Review one', agentKey: 'multi' },
      ],
      blockedCards: [{ blockId: 'sly-hare', text: 'Need creds', agentKey: 'cg-sly-hare-fork' }],
      reviewCards: [
        { blockId: 'teal-crab', text: 'Ship it', agentKey: 'cg-teal-crab-fork' },
        { blockId: 'multi-b', text: 'Review one', agentKey: 'multi' },
      ],
    },
    { kind: 'area' as const, slug: 'dev', ownedCards: [{ blockId: 'x', text: 'never', agentKey: 'cg-bold-fox-fork' }] },
    { kind: 'project' as const, slug: 'old-hub' },
  ]

  it('finds the owned card in any live column; blocked/review outrank in-progress for a multi-card owner', () => {
    expect(ownedCardText('cg-bold-fox-fork', spaces)).toBe('Working on the widget')
    expect(ownedCardText('cg-sly-hare-fork', spaces)).toBe('Need creds')
    expect(ownedCardText('cg-teal-crab-fork', spaces)).toBe('Ship it')
    expect(ownedCardText('multi', spaces)).toBe('Review one')
    expect(ownedCardText('nobody', spaces)).toBeUndefined()
    expect(ownedCardText(undefined, spaces)).toBeUndefined()
    expect(ownedCardText('cg-bold-fox-fork', [{ kind: 'project', slug: 'old-hub' }])).toBeUndefined()
  })

  it('the row header becomes the card text; the fork name moves to agentName', () => {
    const cardTextOf = (k: string) => ownedCardText(k, spaces)
    const session = (over: Partial<AgentSessionLike>): AgentSessionLike => ({ id: 's1', prompt: 'do things', status: 'idle', createdAt: NOW, ...over })
    const owned = sessionToItem(session({ name: 'Bold fox (fork)', hasUnread: true, agentKey: 'cg-bold-fox-fork' }), undefined, undefined, undefined, cardTextOf)
    expect(owned.header).toBe('Working on the widget')
    expect(owned.agentName).toBe('Bold fox')
    // No live card (parent role, chat fork, older hub) → the name stays the header, no tooltip.
    const plain = sessionToItem(session({ name: 'Console general', hasUnread: true, agentKey: 'console-general' }), undefined, undefined, undefined, cardTextOf)
    expect(plain.header).toBe('Console general')
    expect(plain).not.toHaveProperty('agentName')
    expect(sessionToItem(session({ name: 'Keyless', hasUnread: true }), undefined, undefined, undefined, cardTextOf).header).toBe('Keyless')
  })
})

describe('SLA / overdue', () => {
  const H = 3_600_000
  const overdueDm = () => room({ lastInboundTs: NOW - 25 * H, lastOutboundTs: NOW - 30 * H })

  it('unread DM unanswered >24h is overdue; replying clears it', () => {
    expect(isOverdue(overdueDm(), DEFAULT_RULES, NOW)).toBe(true)
    expect(isOverdue(room({ lastInboundTs: NOW - 25 * H, lastOutboundTs: NOW - 1 * H }), DEFAULT_RULES, NOW)).toBe(false)
    expect(isOverdue(room({ lastInboundTs: NOW - 2 * H, lastOutboundTs: NOW - 30 * H }), DEFAULT_RULES, NOW)).toBe(false)
  })

  it('a READ thread is never overdue — read means "seen, chose not to reply" (^neat-bass)', () => {
    const read = room({ lastInboundTs: NOW - 25 * H, lastOutboundTs: NOW - 30 * H, isUnread: false })
    expect(isOverdue(read, DEFAULT_RULES, NOW)).toBe(false)
    expect(roomIsLive(read, NOW)).toBe(false)
    expect(roomToItem(read, DEFAULT_RULES, NOW).overdue).toBeUndefined()
    // Manual unread counts as unread.
    expect(isOverdue({ ...read, manualUnread: true }, DEFAULT_RULES, NOW)).toBe(true)
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

  it('an overdue unread DM tops the sort', () => {
    expect(roomIsLive(overdueDm(), NOW)).toBe(true)
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

describe('itemKey', () => {
  it('is the exact key every adapter stamps — the legacy panes mint snooze targets from it', () => {
    const thread = { id: 't1', historyId: '1', snippet: '', subject: 's', from: 'A', fromEmail: 'a@x.io', date: 1, messageCount: 1, isUnread: true, labelIds: ['INBOX'], hasAttachments: false } as DbThread
    expect(threadToItem(thread, DEFAULT_RULES).key).toBe(itemKey('mail', 't1'))
    expect(itemKey('chat', '!r:beeper.local')).toBe('chat:!r:beeper.local')
  })
})
