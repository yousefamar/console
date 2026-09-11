import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, vi } from 'vitest'

// The unified Inbox must compose offline exactly like Mail and Chat do
// (^spry-wren): its routing rules live hub-side, so a hub that never
// answers must neither blank the lists nor lose the last-known rules.

const ls = vi.hoisted(() => {
  const store = new Map<string, string>()
  const shim = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  }
  ;(globalThis as { localStorage?: unknown }).localStorage = shim
  return store
})
vi.stubGlobal('document', { documentElement: { classList: { toggle: vi.fn() } } })
vi.mock('@/dialog', () => ({ showAlert: vi.fn(async () => {}) }))

// A hub that is DOWN: every request hangs until its timeout aborts it. The
// real timeout lives inside hub.ts (mocked away here), so the stand-in
// aborts after a short delay — long enough that a rebuild waiting on it
// would be visibly late, short enough for the test.
const HANG_MS = 150
const hub = vi.hoisted(() => ({
  mode: 'hang' as 'hang' | 'ok',
  rules: null as unknown,
  posts: [] as unknown[],
  timeouts: [] as (number | undefined)[],
}))
vi.mock('@/hub', () => ({
  hubFetchRaw: vi.fn((_path: string, opts?: { method?: string; body?: string; timeoutMs?: number }) => {
    if (opts?.method === 'POST') hub.posts.push(JSON.parse(opts.body!))
    if (hub.mode === 'hang') {
      hub.timeouts.push(opts?.timeoutMs)
      return new Promise<Response>((_, reject) => {
        setTimeout(() => reject(new DOMException('hubFetch timeout', 'TimeoutError')), HANG_MS)
      })
    }
    if (opts?.method === 'POST') return Promise.resolve(new Response('{}', { status: 200 }))
    return Promise.resolve(new Response(JSON.stringify(hub.rules ?? {}), { status: 200 }))
  }),
  hubFetch: vi.fn(),
  getHubUrl: () => 'http://hub.test',
  getHubWsUrl: () => 'ws://hub.test',
}))

import { db } from '@/db'
import { useUnifiedInboxStore } from '@/store/unified-inbox'
import { useChatStore } from '@/store/chat'
import { DEFAULT_RULES } from '@/inbox/types'
import type { DbChatRoom } from '@/matrix/types'

/** Let a hanging fetch time out so no in-flight load leaks into the next test. */
const settle = () => new Promise((r) => setTimeout(r, HANG_MS + 50))

const room = (id: string, over: Partial<DbChatRoom> = {}): DbChatRoom => ({
  id, name: `Room ${id}`, isDirect: true, memberCount: 2, lastMessageBody: 'hi', lastMessageTime: Date.now(),
  isUnread: true, isMuted: false, isLowPriority: false, isEncrypted: false, ...over,
})

beforeEach(async () => {
  await db.chatRooms.clear()
  await db.threads.clear()
  await db.feedItems.clear()
  await db.itemSnooze.clear()
  hub.mode = 'hang'
  hub.rules = null
  hub.posts = []
  hub.timeouts = []
  useUnifiedInboxStore.setState({ rules: DEFAULT_RULES, feedList: [], inboxList: [], snoozedList: [], selected: null })
  useChatStore.setState({ rooms: [] })
})

describe('unified Inbox offline', () => {
  it('composes from Dexie at once while the rules fetch hangs', async () => {
    await db.chatRooms.bulkPut([room('!a'), room('!b')])
    const started = Date.now()
    await useUnifiedInboxStore.getState().rebuild()
    expect(Date.now() - started).toBeLessThan(HANG_MS)
    expect(useUnifiedInboxStore.getState().inboxList.map((i) => i.sourceId).sort()).toEqual(['!a', '!b'])
    // The real fetch must be bounded too — a DOWN hub hangs a bare fetch for the TCP connect timeout.
    expect(hub.timeouts.every((t) => (t ?? 0) > 0)).toBe(true)
    await settle()
  })

  it('routes by the mirrored rules when the hub is unreachable', async () => {
    ls.set('console:inbox-rules', JSON.stringify({ chat: { default: 'inbox', rooms: { '!a': 'feed' } } }))
    // A fresh store instance reads the mirror at creation — emulate by
    // re-seeding state the way the module initialiser does.
    vi.resetModules()
    const { useUnifiedInboxStore: fresh } = await import('@/store/unified-inbox')
    await db.chatRooms.bulkPut([room('!a'), room('!b')])
    await fresh.getState().rebuild()
    expect(fresh.getState().inboxList.map((i) => i.sourceId)).toEqual(['!b'])
    expect(fresh.getState().feedList.map((i) => i.sourceId)).toEqual(['!a'])
    await settle()
  })

  it('applies the hub rules once they arrive and mirrors them', async () => {
    hub.mode = 'ok'
    hub.rules = { chat: { default: 'inbox', rooms: { '!b': 'feed' } } }
    await db.chatRooms.bulkPut([room('!a'), room('!b')])
    await useUnifiedInboxStore.getState().loadRules()
    await useUnifiedInboxStore.getState().rebuild()
    expect(useUnifiedInboxStore.getState().inboxList.map((i) => i.sourceId)).toEqual(['!a'])
    expect(JSON.parse(ls.get('console:inbox-rules')!).chat.rooms).toEqual({ '!b': 'feed' })
  })

  it('a save made offline is pushed on reconnect instead of being overwritten by the hub copy', async () => {
    // Offline: the POST times out; local state + mirror already hold the change.
    await useUnifiedInboxStore.getState().saveRules({ ...DEFAULT_RULES, chat: { default: 'inbox', rooms: { '!x': 'feed' } } })
    expect(useUnifiedInboxStore.getState().rules.chat.rooms).toEqual({ '!x': 'feed' })
    expect(JSON.parse(ls.get('console:inbox-rules')!).chat.rooms).toEqual({ '!x': 'feed' })

    // Reconnect: the hub still has stale rules; loadRules must PUSH ours, not pull theirs.
    hub.mode = 'ok'
    hub.rules = { chat: { default: 'inbox', rooms: {} } }
    hub.posts = []
    await useUnifiedInboxStore.getState().loadRules()
    expect(hub.posts).toHaveLength(1)
    expect((hub.posts[0] as { chat: { rooms: unknown } }).chat.rooms).toEqual({ '!x': 'feed' })
    expect(useUnifiedInboxStore.getState().rules.chat.rooms).toEqual({ '!x': 'feed' })

    // Next pull is a plain GET again.
    await useUnifiedInboxStore.getState().loadRules()
    expect(hub.posts).toHaveLength(1)
  })
})
