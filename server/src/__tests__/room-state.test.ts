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

describe('computeRoomState — stickers are conversation (^neat-heron)', () => {
  // A bridged WhatsApp sticker arrives as `m.sticker`, not `m.room.message`.
  // The preview loop skipped it, so the thread stayed read, its preview stale,
  // and the SLA clock never saw an inbound.
  const sticker = (sender: string, ts: number, body = '') => ({
    type: 'm.sticker', sender, origin_server_ts: ts,
    content: { body, url: 'mxc://hs/abc', info: { mimetype: 'image/webp' } },
  })

  it('an inbound sticker marks the room unread and advances the preview', () => {
    const delta: SyncRoomDelta = { timeline: { events: [sticker('@other:hs', 5000)] }, unread_notifications: { notification_count: 1 } }
    const next = computeRoomState('!r:hs', baseRoom(), delta, ctx)
    expect(next.isUnread).toBe(true)
    expect(next.lastMessageTime).toBe(5000)
    expect(next.lastMessageBody).toBe('Sticker')
    expect(next.lastInboundTs).toBe(5000)
  })

  it('a sticker with alt text uses it as the preview', () => {
    const delta: SyncRoomDelta = { timeline: { events: [sticker('@other:hs', 5000, '😂 laughing cat')] } }
    const next = computeRoomState('!r:hs', baseRoom(), delta, ctx)
    expect(next.lastMessageBody).toBe('😂 laughing cat')
  })

  it('my own sticker counts as outbound and leaves the room read', () => {
    const delta: SyncRoomDelta = { timeline: { events: [sticker('@me:hs', 5000)] } }
    const next = computeRoomState('!r:hs', baseRoom(), delta, ctx)
    expect(next.isUnread).toBe(false)
    expect(next.lastOutboundTs).toBe(5000)
  })

  it('reactions are still not conversation', () => {
    const delta: SyncRoomDelta = { timeline: { events: [{ type: 'm.reaction', sender: '@other:hs', origin_server_ts: 5000, content: { 'm.relates_to': { key: '👍' } } }] } }
    const next = computeRoomState('!r:hs', baseRoom(), delta, ctx)
    expect(next.isUnread).toBe(false)
    expect(next.lastMessageBody).toBe('hi')
  })
})

describe('computeRoomState — drafts are hub-only and survive every recompute', () => {
  it('carries draft + draftUpdatedAt through a sync delta', () => {
    const existing = baseRoom({ draft: 'unsent reply', draftUpdatedAt: 4242 })
    const delta: SyncRoomDelta = { unread_notifications: { notification_count: 0 } }
    const next = computeRoomState('!r:hs', existing, delta, ctx)
    expect(next.draft).toBe('unsent reply')
    expect(next.draftUpdatedAt).toBe(4242)
  })

  it('an incoming message does not disturb the draft', () => {
    const existing = baseRoom({ draft: 'unsent reply', draftUpdatedAt: 4242 })
    const delta: SyncRoomDelta = { timeline: { events: [{ type: 'm.room.message', sender: '@other:hs', origin_server_ts: 5000, event_id: '$e', content: { msgtype: 'm.text', body: 'ping' } }] } }
    const next = computeRoomState('!r:hs', existing, delta, ctx)
    expect(next.draft).toBe('unsent reply')
    expect(next.isUnread).toBe(true)
  })
})

describe('computeRoomState — a new bridge portal\'s first message (^rare-deer)', () => {
  // George's first WhatsApp message: the bridge created the portal room at
  // 15:37:42.9 (15 state events, my join last at 42.997) and the message landed
  // in the NEXT tick stamped 15:37:41.000 — WhatsApp's original send time, 2 s
  // before the room that carries it. The state-only tick had set lastMessageTime
  // from my join, so the message read as "older than the preview": no preview,
  // no unread. He had to mark the room unread by hand.
  const member = (uid: string, ts: number, displayname?: string) => ({
    type: 'm.room.member', sender: uid, state_key: uid, origin_server_ts: ts,
    content: { membership: 'join', ...(displayname ? { displayname } : {}) },
  })
  const creation = [
    { type: 'm.room.create', sender: '@whatsappbot:hs', state_key: '', origin_server_ts: 1789745862914, content: {} },
    member('@whatsappbot:hs', 1789745862914, 'WhatsApp bridge bot'),
    { type: 'm.room.encryption', sender: '@whatsappbot:hs', state_key: '', origin_server_ts: 1789745862915, content: { algorithm: 'm.megolm.v1.aes-sha2' } },
    member('@whatsapp_lid-1224:hs', 1789745862990, 'George 🌳'),
    member('@me:hs', 1789745862997),
  ]
  const george = {
    type: 'm.room.message', sender: '@whatsapp_lid-1224:hs', event_id: '$g', origin_server_ts: 1789745861000,
    content: { msgtype: 'm.text', body: 'Hi Yousef 👋 My name is George.' },
  }

  it('the first message marks the room unread even though it predates the room state', () => {
    const tick1 = computeRoomState('!g:hs', undefined, { timeline: { events: creation, limited: true }, unread_notifications: { notification_count: 0 } }, ctx)
    expect(tick1.isUnread).toBe(false)
    expect(tick1.lastMessageTime).toBe(1789745862997) // borrowed from my join
    expect(tick1.lastMessageSender).toBe('')

    const tick2 = computeRoomState('!g:hs', tick1, { timeline: { events: [george] }, unread_notifications: { notification_count: 1, highlight_count: 1 } }, ctx)
    expect(tick2.isUnread).toBe(true)
    expect(tick2.unreadCount).toBe(1)
    expect(tick2.lastMessageBody).toBe('Hi Yousef 👋 My name is George.')
    expect(tick2.lastMessageSender).toBe('@whatsapp_lid-1224:hs') // no member event in this delta → raw id
    expect(tick2.lastMessageTime).toBe(1789745861000)
    expect(tick2.lastInboundTs).toBe(1789745861000)
    // The unread divider must not be seeded at my join (which is AFTER the message).
    expect(tick2.lastReadTs).toBeUndefined()
  })

  it('once a real preview exists, an older replayed message still cannot roll it back', () => {
    const existing = baseRoom({ lastMessageTime: 5000, lastMessageBody: 'newest', lastMessageSender: 'George 🌳' })
    const replay = { ...george, origin_server_ts: 4000, content: { msgtype: 'm.text', body: 'older' } }
    const next = computeRoomState('!g:hs', existing, { timeline: { events: [replay] } }, ctx)
    expect(next.lastMessageBody).toBe('newest')
    expect(next.isUnread).toBe(false)
  })

  it('a member join duplicated across state and timeline is counted once', () => {
    const me = member('@me:hs', 1789745862997)
    const next = computeRoomState('!g:hs', undefined, { state: { events: [me] }, timeline: { events: creation } }, ctx)
    expect(next.memberCount).toBe(2)
    expect(next.isDirect).toBe(true)
    expect(next.name).toBe('George 🌳')
  })
})
