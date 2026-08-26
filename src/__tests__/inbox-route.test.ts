import { describe, it, expect } from 'vitest'
import type { DbThread } from '@/gmail/types'
import type { DbChatRoom } from '@/matrix/types'
import type { FeedItem } from '@/store/feeds'
import { DEFAULT_RULES, type InboxRules } from '@/inbox/types'
import {
  feedItemToItem, normalizeRules, roomIsLive, roomToItem, sortFeed, sortInbox,
  threadIsLive, threadToItem,
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
    expect(feedItemToItem(feedItem(), undefined, DEFAULT_RULES).route).toBe('feed')
  })

  it('per-source overrides win over defaults', () => {
    const rules: InboxRules = {
      chat: { default: 'inbox', rooms: { '!r1:hs': 'feed' } },
      mail: { default: 'inbox', senders: { 'alice@example.com': 'feed' } },
      feeds: { default: 'feed', feeds: { 'feed-a': 'inbox' } },
    }
    expect(roomToItem(room(), rules).route).toBe('feed')
    expect(threadToItem(thread(), rules).route).toBe('feed')
    expect(feedItemToItem(feedItem(), undefined, rules).route).toBe('inbox')
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
  it('inbox bands: chat DMs, chat groups, mail, feed reading — recency within', () => {
    const items = [
      feedItemToItem(feedItem({ id: 'f-new', publishedAt: new Date(NOW).toISOString() }), undefined, normalizeRules({ feeds: { default: 'inbox' } })),
      threadToItem(thread({ id: 't-old', date: NOW - 9000 }), DEFAULT_RULES),
      roomToItem(room({ id: '!group:hs', isDirect: false, lastMessageTime: NOW }), DEFAULT_RULES),
      roomToItem(room({ id: '!dm-old:hs', lastMessageTime: NOW - 5000 }), DEFAULT_RULES),
      roomToItem(room({ id: '!dm-new:hs', lastMessageTime: NOW }), DEFAULT_RULES),
    ]
    const sorted = sortInbox(items).map((i) => i.sourceId)
    expect(sorted).toEqual(['!dm-new:hs', '!dm-old:hs', '!group:hs', 't-old', 'f-new'])
  })

  it('feed list is pure reverse-chron', () => {
    const items = [
      feedItemToItem(feedItem({ id: 'a', publishedAt: new Date(NOW - 100).toISOString() }), undefined, DEFAULT_RULES),
      feedItemToItem(feedItem({ id: 'b', publishedAt: new Date(NOW).toISOString() }), undefined, DEFAULT_RULES),
    ]
    expect(sortFeed(items).map((i) => i.sourceId)).toEqual(['b', 'a'])
  })
})
