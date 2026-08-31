import { describe, it, expect } from 'vitest'
import { computeRoomState, type RoomState, type SyncRoomDelta, type ComputeContext } from '../matrix/room-state.js'

const ctx: ComputeContext = { myUserId: '@me:hs', mutedRoomIds: new Set() }

/** A minimal pre-existing room snapshot (read, has a prior message). */
function baseRoom(over: Partial<RoomState> = {}): RoomState {
  return {
    id: '!r:hs',
    name: 'Room',
    isDirect: true,
    memberCount: 2,
    lastMessageBody: 'hi',
    lastMessageSender: '@other:hs',
    lastMessageTime: 1000,
    isUnread: false,
    isMuted: false,
    isLowPriority: false,
    isEncrypted: false,
    ...over,
  }
}

describe('computeRoomState — manual unread durability', () => {
  // The bug: a manual "mark unread" has no homeserver backing, so any sync that
  // reported notification_count=0 (notably the big catch-up after a hub restart)
  // cleared isUnread and the marker vanished.
  it('keeps a manually-unread room unread when a sync reports notification_count=0', () => {
    const existing = baseRoom({ isUnread: true, manualUnread: true, unreadCount: 1 })
    const delta: SyncRoomDelta = { unread_notifications: { notification_count: 0 } }
    const next = computeRoomState('!r:hs', existing, delta, ctx)
    expect(next.manualUnread).toBe(true)
    expect(next.isUnread).toBe(true)
  })

  it('a genuine (non-manual) read-elsewhere still clears unread on notification_count=0', () => {
    const existing = baseRoom({ isUnread: true, unreadCount: 2 })
    const delta: SyncRoomDelta = { unread_notifications: { notification_count: 0 } }
    const next = computeRoomState('!r:hs', existing, delta, ctx)
    expect(next.manualUnread).toBeUndefined()
    expect(next.isUnread).toBe(false)
  })

  it('does not stamp manualUnread on ordinary rooms', () => {
    const next = computeRoomState('!r:hs', baseRoom(), { unread_notifications: { notification_count: 0 } }, ctx)
    expect(next.manualUnread).toBeUndefined()
  })

  it('preserves manualUnread across an empty (info-less) delta', () => {
    const existing = baseRoom({ isUnread: true, manualUnread: true, unreadCount: 1 })
    const next = computeRoomState('!r:hs', existing, {}, ctx)
    expect(next.manualUnread).toBe(true)
    expect(next.isUnread).toBe(true)
  })
})

describe('computeRoomState — inbound/outbound reply tracking (SLA input)', () => {
  const msg = (sender: string, ts: number) => ({
    type: 'm.room.message', sender, origin_server_ts: ts, content: { body: 'x', msgtype: 'm.text' },
  })

  it('classifies my sends as outbound, others as inbound', () => {
    const delta: SyncRoomDelta = { timeline: { events: [msg('@other:hs', 2000), msg('@me:hs', 3000)] } }
    const next = computeRoomState('!r:hs', baseRoom(), delta, ctx)
    expect(next.lastInboundTs).toBe(2000)
    expect(next.lastOutboundTs).toBe(3000)
  })

  it('is monotone — an out-of-order resume batch cannot roll them back', () => {
    const existing = baseRoom({ lastInboundTs: 5000, lastOutboundTs: 6000 })
    const delta: SyncRoomDelta = { timeline: { events: [msg('@other:hs', 2000), msg('@me:hs', 3000)] } }
    const next = computeRoomState('!r:hs', existing, delta, ctx)
    expect(next.lastInboundTs).toBe(5000)
    expect(next.lastOutboundTs).toBe(6000)
  })

  it('bridge bots do not count as inbound', () => {
    const delta: SyncRoomDelta = { timeline: { events: [msg('@whatsappbot:hs', 9000)] } }
    const next = computeRoomState('!r:hs', baseRoom(), delta, ctx)
    expect(next.lastInboundTs).toBeUndefined()
  })

  it('preserves prior values across deltas with no messages', () => {
    const existing = baseRoom({ lastInboundTs: 5000, lastOutboundTs: 6000 })
    const next = computeRoomState('!r:hs', existing, { unread_notifications: { notification_count: 0 } }, ctx)
    expect(next.lastInboundTs).toBe(5000)
    expect(next.lastOutboundTs).toBe(6000)
  })
})
