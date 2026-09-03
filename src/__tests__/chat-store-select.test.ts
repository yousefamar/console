import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Module-scope localStorage reads in the chat store's import graph — must be
// stubbed before the (hoisted) imports evaluate.
vi.hoisted(() => {
  const store = new Map<string, string>()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  }
})

import { db } from '@/db'
import { useChatStore } from '@/store/chat'
import type { DbChatRoom } from '@/matrix/types'

function makeRoom(id: string, overrides: Partial<DbChatRoom> = {}): DbChatRoom {
  return {
    id, name: `Room ${id}`, isUnread: false, unreadCount: 0, memberCount: 2,
    lastMessageTime: 1000, isDirect: true, tags: [],
    ...overrides,
  } as DbChatRoom
}

describe('useChatStore.selectRoom lists an unlisted room', () => {
  beforeEach(async () => {
    await db.chatRooms.clear()
    await db.chatMessages.clear()
    // ensureMessages paginates from the hub — out of scope here (and no hub in node).
    useChatStore.setState({ rooms: [], selectedRoomId: null, ensureMessages: async () => {} })
  })

  it('appends a Dexie room the Chat pane list does not hold (overdue read DM from the Inbox)', async () => {
    await db.chatRooms.bulkPut([makeRoom('a', { isUnread: true }), makeRoom('b')])
    useChatStore.setState({ rooms: [makeRoom('a', { isUnread: true })] })
    await useChatStore.getState().selectRoom('b')
    const s = useChatStore.getState()
    expect(s.selectedRoomId).toBe('b')
    expect(s.rooms.map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('does not duplicate a room already listed', async () => {
    await db.chatRooms.put(makeRoom('a'))
    useChatStore.setState({ rooms: [makeRoom('a')] })
    await useChatStore.getState().selectRoom('a')
    expect(useChatStore.getState().rooms).toHaveLength(1)
  })

  it('selects synchronously when the room is listed (no Dexie hop)', () => {
    useChatStore.setState({ rooms: [makeRoom('a')] })
    void useChatStore.getState().selectRoom('a')
    expect(useChatStore.getState().selectedRoomId).toBe('a')
  })

  it('survives the liveQuery setRooms re-fire — the listed selection is kept', async () => {
    await db.chatRooms.bulkPut([makeRoom('a', { isUnread: true }), makeRoom('b')])
    useChatStore.setState({ rooms: [makeRoom('a', { isUnread: true })] })
    await useChatStore.getState().selectRoom('b')
    useChatStore.getState().setRooms([makeRoom('a', { isUnread: true })])
    const s = useChatStore.getState()
    expect(s.selectedRoomId).toBe('b')
    expect(s.rooms.map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('drops the previously selected read room when moving on', async () => {
    await db.chatRooms.bulkPut([makeRoom('b'), makeRoom('c')])
    useChatStore.setState({ rooms: [] })
    await useChatStore.getState().selectRoom('b')
    await useChatStore.getState().selectRoom('c')
    expect(useChatStore.getState().rooms.map((r) => r.id)).toEqual(['c'])
  })
})
