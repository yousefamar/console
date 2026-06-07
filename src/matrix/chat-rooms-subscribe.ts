// ============================================================================
// Hub chat-rooms subscriber — mirrors the hub-owned room snapshot into the
// client's local IDB cache. Replaces the in-browser room-state derivation
// that used to live in processJoinedRoom; now every device gets the same
// authoritative view and "mark read on PC → phone updates" works.
//
// Flow:
//   • On hub connect: call `chat-rooms.snapshot` → bulkPut into db.chatRooms,
//     remember `seq`, prune any local rows that vanished server-side.
//   • On each `chat-rooms.delta` broadcast: bulkPut the new snapshot into
//     db.chatRooms (full-snapshot wire format today; if the hub later moves
//     to patches we slot in the seq diffing here).
//   • One-shot migration on first boot of this code: wipe the local
//     chatRooms table so any divergent isUnread / missing rooms from the
//     legacy local-derived era die immediately.
// ============================================================================

import { db, getMeta, setMeta } from '@/db'
import { hubBus } from '@/sync-bus'
import type { DbChatRoom } from '@/matrix/types'

// Wire shape matches server/src/snapshot-store.ts::SnapshotEnvelope<T>.
interface ChatRoomsEnvelope {
  seq: number
  data: Record<string, DbChatRoom>
}

const MIGRATION_KEY = 'console:chatRoomsHubSync:v1'
let lastSeenSeq = 0

async function migrateOnce(): Promise<void> {
  if (await getMeta(MIGRATION_KEY)) return
  // Wipe stale local rooms — they were derived from per-device /sync state and
  // are the reason phones showed unread badges PC had cleared months ago.
  await db.chatRooms.clear()
  await setMeta(MIGRATION_KEY, String(Date.now()))
}

function applyEnvelope(env: ChatRoomsEnvelope): void {
  if (typeof env?.seq !== 'number' || !env.data) return
  if (env.seq <= lastSeenSeq) return
  lastSeenSeq = env.seq
  const rooms = Object.values(env.data)
  // bulkPut performs replace-by-key which matches the hub's "this is the
  // canonical view" semantics. Rooms that vanish server-side aren't deleted
  // here — pruning happens on snapshot fetch, not on every delta, so a
  // transient "this delta only covers a few rooms" payload doesn't blow
  // away the rest.
  void db.chatRooms.bulkPut(rooms).catch(() => {})
}

async function fetchSnapshotAndPrune(): Promise<void> {
  const env = await hubBus.rpc<ChatRoomsEnvelope>('chat-rooms', 'snapshot', undefined)
  if (typeof env?.seq !== 'number' || !env.data) return
  lastSeenSeq = env.seq
  const serverIds = new Set(Object.keys(env.data))
  const localIds = await db.chatRooms.toCollection().primaryKeys() as string[]
  const stale = localIds.filter((id) => !serverIds.has(id))
  if (stale.length > 0) await db.chatRooms.bulkDelete(stale).catch(() => {})
  const rooms = Object.values(env.data)
  if (rooms.length > 0) await db.chatRooms.bulkPut(rooms).catch(() => {})
}

/** Wire the hub chat-rooms subscription. Idempotent — safe to call once on
 *  app boot. Returns an unsubscribe function. */
export function wireChatRoomsSubscription(): () => void {
  let stopped = false
  void migrateOnce().then(() => {
    if (stopped) return
    void fetchSnapshotAndPrune().catch(() => {})
  })

  // Stream live deltas.
  const unsubDelta = hubBus.on('chat-rooms', 'delta', (data) => {
    applyEnvelope(data as ChatRoomsEnvelope)
  })
  // Re-fetch snapshot on every reconnect so we never trust accumulated
  // local state through a disconnection window.
  const unsubConnect = hubBus.onConnect(() => {
    void fetchSnapshotAndPrune().catch(() => {})
  })

  return () => {
    stopped = true
    unsubDelta()
    unsubConnect()
  }
}
