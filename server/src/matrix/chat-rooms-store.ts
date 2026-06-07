// ============================================================================
// Hub-owned chat room snapshot — the canonical "what every device should
// show in the chat inbox" map. Wraps the generic SnapshotStore primitive so
// that mutations persist atomically and broadcast on the `chat-rooms`
// service over SyncBus. Clients consume `chat-rooms.delta`, drop the data
// straight into their IDB cache, and never compute room metadata locally.
// ============================================================================

import type { SyncBus } from '../sync-bus.js'
import { SnapshotStore } from '../snapshot-store.js'
import type { RoomState, SyncRoomDelta, ComputeContext } from './room-state.js'
import { computeRoomState } from './room-state.js'

export type ChatRoomsSnapshot = Record<string, RoomState>

export class ChatRoomsStore {
  private readonly store: SnapshotStore<ChatRoomsSnapshot>

  constructor(opts: { path: string; bus?: SyncBus; log?: (msg: string) => void }) {
    this.store = new SnapshotStore<ChatRoomsSnapshot>({
      name: 'chat-rooms',
      path: opts.path,
      defaultValue: {},
      bus: opts.bus,
      log: opts.log,
    })
  }

  /** Current `{ seq, data }` envelope — used by `chat-rooms.snapshot` RPC. */
  snapshot() {
    return this.store.get()
  }

  /** Apply an incoming /sync delta. Each room is computed against its prior
   *  state, then upserted. Pure rooms (joined → invited/left) handled by
   *  `removeRoom`. The whole batch lands in a single seq bump so clients
   *  don't see partial updates. */
  applySyncDelta(deltas: Record<string, SyncRoomDelta>, ctx: ComputeContext): void {
    const ids = Object.keys(deltas)
    if (ids.length === 0) return
    this.store.update((draft) => {
      for (const id of ids) {
        const next = computeRoomState(id, draft[id], deltas[id]!, ctx)
        draft[id] = next
      }
    })
  }

  /** Drop a room from the snapshot (e.g. user left). */
  removeRoom(roomId: string): void {
    this.store.update((draft) => {
      if (!(roomId in draft)) return false
      delete draft[roomId]
    })
  }

  /** Authoritative mark-read from any client — sets the receipt-driven
   *  fields immediately so all *other* clients can update before the next
   *  homeserver /sync delta reflects the receipt. Callers (e.g. MatrixSync)
   *  are responsible for the actual homeserver POST. */
  setRoomRead(roomId: string, eventId: string, lastReadTs?: number): void {
    this.store.update((draft) => {
      const room = draft[roomId]
      if (!room) return false
      if (!room.isUnread && room.unreadCount === 0 && room.lastReadEventId === eventId) return false
      draft[roomId] = {
        ...room,
        isUnread: false,
        unreadCount: 0,
        lastReadEventId: eventId,
        lastReadTs: lastReadTs ?? room.lastReadTs,
      }
    })
  }

  /** Mark a room unread again (no homeserver concept — purely a hub flag
   *  surfaced to all clients). */
  setRoomUnread(roomId: string): void {
    this.store.update((draft) => {
      const room = draft[roomId]
      if (!room || room.isUnread) return false
      draft[roomId] = {
        ...room,
        isUnread: true,
        unreadCount: room.unreadCount && room.unreadCount > 0 ? room.unreadCount : 1,
      }
    })
  }

  /** Snooze — also a hub-only concept. */
  setRoomSnoozedUntil(roomId: string, untilMs: number | undefined): void {
    this.store.update((draft) => {
      const room = draft[roomId]
      if (!room) return false
      if (room.snoozedUntil === untilMs) return false
      draft[roomId] = { ...room, snoozedUntil: untilMs }
    })
  }

  /** Update the per-room outbound mute flag (driven by the push-rule set). */
  setMutedRoomIds(mutedRoomIds: Set<string>): void {
    this.store.update((draft) => {
      let touched = false
      for (const id of Object.keys(draft)) {
        const want = mutedRoomIds.has(id)
        if (draft[id]!.isMuted !== want) {
          draft[id] = { ...draft[id]!, isMuted: want }
          touched = true
        }
      }
      if (!touched) return false
    })
  }
}
