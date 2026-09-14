import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatRoomsStore } from '../matrix/chat-rooms-store.js'
import type { SnapshotPatch } from '../snapshot-store.js'
import type { RoomState, SyncRoomDelta } from '../matrix/room-state.js'

function seedRoom(over: Partial<RoomState> = {}): SyncRoomDelta {
  // A minimal state-only delta that creates the room via computeRoomState.
  return {
    state: { events: [{ type: 'm.room.name', state_key: '', sender: '@other:hs', content: { name: over.name ?? 'Room' } }] },
  }
}

describe('ChatRoomsStore drafts', () => {
  let dir: string
  let broadcasts: Array<{ service: string; op: string; data: unknown }>
  let store: ChatRoomsStore
  const ctx = { myUserId: '@me:hs', mutedRoomIds: new Set<string>() }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chat-drafts-'))
    broadcasts = []
    store = new ChatRoomsStore({
      path: join(dir, 'chat-rooms.json'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bus: { broadcast: (service: string, op: string, data: unknown) => broadcasts.push({ service, op, data }) } as any,
    })
    store.applySyncDelta({ '!a:hs': seedRoom({ name: 'Alice' }), '!b:hs': seedRoom({ name: 'Bob' }) }, ctx)
    broadcasts = []
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('sets a draft, stamps its time, and broadcasts the patched room', () => {
    expect(store.setRoomDraft('!a:hs', 'hello there', 1234)).toBe(true)
    const room = store.getRoom('!a:hs')!
    expect(room.draft).toBe('hello there')
    expect(room.draftUpdatedAt).toBe(1234)
    expect(broadcasts).toHaveLength(1)
    const patch = broadcasts[0]!.data as SnapshotPatch
    expect((patch.changed['!a:hs'] as RoomState).draft).toBe('hello there')
  })

  it('an identical draft is a no-op; empty/whitespace clears', () => {
    store.setRoomDraft('!a:hs', 'x')
    broadcasts = []
    expect(store.setRoomDraft('!a:hs', 'x')).toBe(false)
    expect(broadcasts).toHaveLength(0)
    expect(store.setRoomDraft('!a:hs', '   ')).toBe(true)
    expect(store.getRoom('!a:hs')!.draft).toBeUndefined()
    expect(store.getRoom('!a:hs')!.draftUpdatedAt).toBeUndefined()
    expect(store.setRoomDraft('!a:hs', undefined)).toBe(false)
  })

  it('an unknown room is refused', () => {
    expect(store.setRoomDraft('!nope:hs', 'x')).toBe(false)
    expect(broadcasts).toHaveLength(0)
  })

  it('a later sync delta carries the draft through unchanged', () => {
    store.setRoomDraft('!a:hs', 'keep me', 5)
    store.applySyncDelta({ '!a:hs': { unread_notifications: { notification_count: 0 } } }, ctx)
    const room = store.getRoom('!a:hs')!
    expect(room.draft).toBe('keep me')
    expect(room.draftUpdatedAt).toBe(5)
  })

  it('mark-read leaves the draft alone — reading is not discarding', () => {
    store.setRoomDraft('!a:hs', 'still here')
    store.setRoomRead('!a:hs', '$ev', 10)
    expect(store.getRoom('!a:hs')!.draft).toBe('still here')
  })

  it('listDrafts returns drafted rooms only, newest edit first', () => {
    store.setRoomDraft('!a:hs', 'older', 100)
    store.setRoomDraft('!b:hs', 'newer', 200)
    expect(store.listDrafts().map((r) => r.id)).toEqual(['!b:hs', '!a:hs'])
    expect(store.listDrafts()[0]).toMatchObject({ name: 'Bob', draft: 'newer', draftUpdatedAt: 200 })
    store.setRoomDraft('!b:hs', '')
    expect(store.listDrafts().map((r) => r.id)).toEqual(['!a:hs'])
  })
})
