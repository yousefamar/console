// ============================================================================
// Hub chat-rooms subscriber — mirrors the hub-owned room snapshot into the
// client's local IDB cache. Replaces the in-browser room-state derivation
// that used to live in processJoinedRoom; now every device gets the same
// authoritative view and "mark read on PC → phone updates" works.
//
// Flow:
//   • On hub connect: call `chat-rooms.snapshotSince {since}` with our last
//     seen seq → either a coalesced patch (apply keys) or a full snapshot
//     (bulkPut + prune stale local rows). First boot has no seq → full.
//   • On each `chat-rooms.delta` broadcast: a per-key patch
//     `{seq, partial, changed, removed}` (hub ships patches since 2026-07;
//     the legacy full `{seq, data}` shape is still accepted).
//   • One-shot migration on first boot of this code: wipe the local
//     chatRooms table so any divergent isUnread / missing rooms from the
//     legacy local-derived era die immediately.
// ============================================================================

import { db, getMeta, setMeta } from '@/db'
import { hubBus } from '@/sync-bus'
import type { DbChatRoom } from '@/matrix/types'

// Wire shapes match server/src/snapshot-store.ts.
interface ChatRoomsEnvelope {
  seq: number
  data: Record<string, DbChatRoom>
}
interface ChatRoomsPatch {
  seq: number
  partial: true
  changed: Record<string, DbChatRoom>
  removed: string[]
}
type ChatRoomsDelta = ChatRoomsEnvelope | ChatRoomsPatch

const MIGRATION_KEY = 'console:chatRoomsHubSync:v1'
const SEQ_KEY = 'console:chatRoomsSeq'
let lastSeenSeq = 0

async function migrateOnce(): Promise<void> {
  if (await getMeta(MIGRATION_KEY)) return
  // Wipe stale local rooms — they were derived from per-device /sync state and
  // are the reason phones showed unread badges PC had cleared months ago.
  await db.chatRooms.clear()
  await setMeta(MIGRATION_KEY, String(Date.now()))
}

function isPatch(d: ChatRoomsDelta): d is ChatRoomsPatch {
  return (d as ChatRoomsPatch).partial === true
}

async function applyDelta(delta: ChatRoomsDelta): Promise<void> {
  if (typeof delta?.seq !== 'number') return
  if (delta.seq <= lastSeenSeq) return

  if (isPatch(delta)) {
    // A patch is only safe to apply if we haven't missed anything between our
    // seq and its seq. Live deltas arrive one per seq bump, so a gap means a
    // missed broadcast — fall back to a snapshotSince round-trip.
    if (lastSeenSeq > 0 && delta.seq > lastSeenSeq + 1) {
      void reconcileFromHub().catch(() => {})
      return
    }
    lastSeenSeq = delta.seq
    const changed = Object.values(delta.changed)
    if (changed.length > 0) await db.chatRooms.bulkPut(changed).catch(() => {})
    if (delta.removed.length > 0) await db.chatRooms.bulkDelete(delta.removed).catch(() => {})
  } else {
    if (!delta.data) return
    lastSeenSeq = delta.seq
    // Legacy full-snapshot delta: replace-by-key, no pruning (a transient
    // partial payload must not blow away the rest).
    const rooms = Object.values(delta.data)
    if (rooms.length > 0) await db.chatRooms.bulkPut(rooms).catch(() => {})
  }
  void setMeta(SEQ_KEY, String(lastSeenSeq))
}

/** Connect-time reconcile: send our seq, get back a patch (cheap) or a full
 *  snapshot (authoritative — prune local rows the hub no longer has). */
async function reconcileFromHub(): Promise<void> {
  const since = lastSeenSeq > 0 ? lastSeenSeq : undefined
  const result = await hubBus.rpc<ChatRoomsDelta>('chat-rooms', 'snapshotSince', { since })
  if (typeof result?.seq !== 'number') return

  if (isPatch(result)) {
    lastSeenSeq = result.seq
    const changed = Object.values(result.changed)
    if (changed.length > 0) await db.chatRooms.bulkPut(changed).catch(() => {})
    if (result.removed.length > 0) await db.chatRooms.bulkDelete(result.removed).catch(() => {})
  } else {
    if (!result.data) return
    lastSeenSeq = result.seq
    const serverIds = new Set(Object.keys(result.data))
    const localIds = await db.chatRooms.toCollection().primaryKeys() as string[]
    const stale = localIds.filter((id) => !serverIds.has(id))
    if (stale.length > 0) await db.chatRooms.bulkDelete(stale).catch(() => {})
    const rooms = Object.values(result.data)
    if (rooms.length > 0) await db.chatRooms.bulkPut(rooms).catch(() => {})
  }
  void setMeta(SEQ_KEY, String(lastSeenSeq))
}

/** Wire the hub chat-rooms subscription. Idempotent — safe to call once on
 *  app boot. Returns an unsubscribe function. */
export function wireChatRoomsSubscription(): () => void {
  let stopped = false
  void migrateOnce().then(async () => {
    if (stopped) return
    // Restore the persisted seq so a page reload can reconcile with a patch
    // instead of re-downloading the full snapshot.
    const saved = await getMeta(SEQ_KEY)
    const n = Number(saved)
    if (Number.isFinite(n) && n > lastSeenSeq) lastSeenSeq = n
    void reconcileFromHub().catch(() => {})
  })

  // Stream live deltas.
  const unsubDelta = hubBus.on('chat-rooms', 'delta', (data) => {
    void applyDelta(data as ChatRoomsDelta)
  })
  // Re-reconcile on every reconnect so we never trust accumulated
  // local state through a disconnection window.
  const unsubConnect = hubBus.onConnect(() => {
    void reconcileFromHub().catch(() => {})
  })

  return () => {
    stopped = true
    unsubDelta()
    unsubConnect()
  }
}
