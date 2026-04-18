// ============================================================================
// Matrix sync loop — runs on the hub (M2).
//
// Long-polls /sync against the homeserver, feeds crypto-relevant fields into
// the hub OlmMachine, decrypts timeline events, and broadcasts deltas to
// browsers over the SyncBus as {service:'matrix', op:'delta'|'initial'}.
//
// Co-existence with the browser: during M2 the browser still drives its own
// sync loop. This hub loop runs in parallel; broadcasts are advisory. Once
// the browser is flipped to observer (M2b), browsers rely on these deltas
// exclusively. Browser never sees m.room.encrypted — only decrypted payloads.
//
// Persistence: next_batch stored at ~/.config/console/matrix-sync-state.json
// so restarts resume instead of replaying the world.
// ============================================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { MatrixClient } from '../matrix-client.js'
import type { HubMatrixCrypto } from './crypto.js'
import type { AuthStore } from '../auth-store.js'
import type { SyncBus } from '../sync-bus.js'
import type { PushServer } from '../push.js'

type MatrixSyncState = { nextBatch?: string; lastSyncMs?: number }

// Raw Matrix-shape event (as it appears on the wire from the homeserver).
// For delta payloads, m.room.encrypted events are replaced in place: event_id/
// sender/origin_server_ts/state_key/unsigned are preserved; type + content are
// replaced with the decrypted equivalents. An `_decryptFailed: true` flag
// marks events we couldn't decrypt so the browser can still render a placeholder.
export type MatrixEventLike = {
  event_id?: string
  type: string
  content: Record<string, unknown>
  sender?: string
  origin_server_ts?: number
  state_key?: string
  unsigned?: Record<string, unknown>
  _decryptFailed?: boolean
}

// Mirror of browser MatrixJoinedRoom shape — browser calls processJoinedRoom(data)
// directly on this. Fields that were absent in the homeserver response stay absent.
export type MatrixJoinedRoomDelta = {
  timeline?: {
    events?: MatrixEventLike[]
    prev_batch?: string
    limited?: boolean
  }
  state?: { events?: MatrixEventLike[] }
  account_data?: { events?: MatrixEventLike[] }
  ephemeral?: { events?: MatrixEventLike[] }
  unread_notifications?: {
    notification_count?: number
    highlight_count?: number
  }
}

export type MatrixDelta = {
  nextBatch: string
  // Map of roomId → MatrixJoinedRoom-shaped payload (mirrors /sync's rooms.join)
  rooms: Record<string, MatrixJoinedRoomDelta>
  invites?: string[]
  leaves?: string[]
}

export class MatrixSync {
  private state: MatrixSyncState = {}
  private loopTimer: NodeJS.Timeout | null = null
  private stopped = false
  private inflight = false
  private readonly LONG_POLL_MS = 30_000

  constructor(
    private readonly matrix: MatrixClient,
    private readonly crypto: HubMatrixCrypto,
    private readonly auth: AuthStore,
    private readonly bus: SyncBus,
    private readonly push: PushServer,
    private readonly stateFile: string,
    private readonly log: (msg: string) => void,
  ) {
    this.loadState()
  }

  start(): void {
    if (this.loopTimer) return
    this.stopped = false
    this.log('[matrix-sync] starting')
    // First tick shortly after boot so the hub doesn't block startup.
    this.loopTimer = setTimeout(() => { this.runLoop().catch((e) => this.log(`[matrix-sync] loop crashed: ${e}`)) }, 5_000)
  }

  stop(): void {
    this.stopped = true
    if (this.loopTimer) {
      clearTimeout(this.loopTimer)
      this.loopTimer = null
    }
  }

  getState(): { nextBatch?: string; lastSyncMs?: number; cryptoReady: boolean } {
    return {
      nextBatch: this.state.nextBatch,
      lastSyncMs: this.state.lastSyncMs,
      cryptoReady: this.crypto.isReady(),
    }
  }

  // Nonblocking: schedule an immediate tick (if none is inflight).
  async syncNow(): Promise<{ ok: true }> {
    if (!this.inflight) await this.tick()
    return { ok: true }
  }

  // Full snapshot for a fresh client (e.g. APK first launch): hits /sync with
  // no `since` token, decrypts the resulting timeline, and broadcasts the
  // result as 'initial'. Does NOT touch this.state.nextBatch — the main tick
  // loop keeps its own token untouched. Safe to call concurrently with ticks.
  async snapshot(): Promise<{ ok: true }> {
    const cfg = this.auth.getMatrixConfig()
    if (!cfg || !this.crypto.isReady()) return { ok: true }

    const resp = await this.matrix.sync({ since: undefined, timeout: 0 })
    // Skip processSyncCrypto — the main loop already handles device lists /
    // to-device messages on its own token; re-running that machinery here
    // against unrelated state would just churn. decryptRoomEvent uses the
    // keys OlmMachine already has.
    const rooms = await this.decryptJoinedRooms(resp.rooms?.join ?? {})
    const invites = Object.keys(resp.rooms?.invite ?? {})
    const leaves = Object.keys(resp.rooms?.leave ?? {})
    const delta: MatrixDelta = {
      nextBatch: resp.next_batch,
      rooms,
      invites: invites.length ? invites : undefined,
      leaves: leaves.length ? leaves : undefined,
    }
    this.bus.broadcast('matrix', 'initial', delta)
    this.log(`[matrix-sync] snapshot broadcast: ${Object.keys(rooms).length} rooms`)
    return { ok: true }
  }

  // -------- Send path (called via SyncBus RPC from browsers) ---------------
  // Unified send: the hub decides encryption vs. plaintext based on the room's
  // m.room.encryption state. This is the single code path for chat sends,
  // replacing the browser-side encrypt+send that lived in src/matrix/sync.ts.

  /** Returns true if the room has an m.room.encryption state event. */
  private async roomIsEncrypted(roomId: string): Promise<boolean> {
    const state = await this.matrix.getRoomState(roomId) as Array<{ type: string }>
    return state.some((e) => e.type === 'm.room.encryption')
  }

  /** Returns joined member user IDs for key sharing. */
  private async roomJoinedMembers(roomId: string): Promise<string[]> {
    const state = await this.matrix.getRoomState(roomId) as Array<{ type: string; state_key?: string; content?: { membership?: string } }>
    return state
      .filter((e) => e.type === 'm.room.member' && e.content?.membership === 'join' && !!e.state_key)
      .map((e) => e.state_key!)
  }

  /**
   * Send any room event. Encrypts transparently if the room is encrypted.
   * Returns the server-assigned event_id.
   */
  async sendRoomEvent(args: { roomId: string; type: string; content: Record<string, unknown> }): Promise<{ event_id: string }> {
    const cfg = this.auth.getMatrixConfig()
    if (!cfg) throw new Error('no matrix credentials')
    const { roomId, type, content } = args
    if (!roomId || !type || typeof content !== 'object') throw new Error('roomId, type, content required')

    const encrypted = await this.roomIsEncrypted(roomId)
    const txnId = `hub${Date.now()}.${Math.random().toString(36).slice(2)}`

    if (encrypted && this.crypto.isReady()) {
      const members = await this.roomJoinedMembers(roomId)
      await this.crypto.shareRoomKeys(roomId, members, cfg.homeserver, cfg.accessToken)
      const payload = await this.crypto.encryptRoomEventForSend(roomId, type, content)
      if (!payload) throw new Error('encryption failed')
      const url = `${cfg.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.encrypted/${txnId}`
      const resp = await fetch(url, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${cfg.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const text = await resp.text()
      if (!resp.ok) throw new Error(`send failed: ${resp.status} ${text}`)
      return JSON.parse(text) as { event_id: string }
    }

    // Unencrypted: PUT directly
    const url = `${cfg.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/${encodeURIComponent(type)}/${txnId}`
    const resp = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${cfg.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(content),
    })
    const text = await resp.text()
    if (!resp.ok) throw new Error(`send failed: ${resp.status} ${text}`)
    return JSON.parse(text) as { event_id: string }
  }

  /** Redact an event (always unencrypted; redactions are never encrypted). */
  async redactEvent(args: { roomId: string; eventId: string; reason?: string }): Promise<{ event_id: string }> {
    const cfg = this.auth.getMatrixConfig()
    if (!cfg) throw new Error('no matrix credentials')
    const { roomId, eventId, reason } = args
    const txnId = `hub${Date.now()}.${Math.random().toString(36).slice(2)}`
    const url = `${cfg.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(eventId)}/${txnId}`
    const resp = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${cfg.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(reason ? { reason } : {}),
    })
    const text = await resp.text()
    if (!resp.ok) throw new Error(`redact failed: ${resp.status} ${text}`)
    return JSON.parse(text) as { event_id: string }
  }

  /**
   * Paginate room messages. Decrypts m.room.encrypted events in place so the
   * browser receives already-decrypted payloads (mirrors tick's behavior).
   */
  async paginate(args: { roomId: string; from?: string; dir?: 'b' | 'f'; limit?: number }): Promise<{
    chunk: MatrixEventLike[]
    state?: MatrixEventLike[]
    start?: string
    end?: string
  }> {
    const { roomId, from, dir = 'b', limit = 50 } = args
    const resp = await this.matrix.getRoomMessages(roomId, { from, dir, limit }) as {
      chunk?: any[]
      state?: any[]
      start?: string
      end?: string
    }
    const decryptedChunk: MatrixEventLike[] = []
    for (const ev of resp.chunk ?? []) {
      if (ev.type === 'm.room.encrypted' && this.crypto.isReady()) {
        const dec = await this.crypto.decryptRoomEvent(
          {
            type: ev.type,
            content: ev.content,
            event_id: ev.event_id,
            sender: ev.sender,
            origin_server_ts: ev.origin_server_ts,
            room_id: roomId,
          },
          roomId,
        )
        if (dec) {
          decryptedChunk.push({
            event_id: ev.event_id,
            sender: ev.sender,
            origin_server_ts: ev.origin_server_ts,
            state_key: ev.state_key,
            unsigned: ev.unsigned,
            type: dec.type,
            content: dec.content,
          })
        } else {
          decryptedChunk.push({
            event_id: ev.event_id,
            sender: ev.sender,
            origin_server_ts: ev.origin_server_ts,
            state_key: ev.state_key,
            unsigned: ev.unsigned,
            type: ev.type,
            content: ev.content,
            _decryptFailed: true,
          })
        }
      } else {
        decryptedChunk.push(ev as MatrixEventLike)
      }
    }
    return { chunk: decryptedChunk, state: resp.state as MatrixEventLike[] | undefined, start: resp.start, end: resp.end }
  }

  /** Set fully_read + m.read marker and send an m.read receipt. */
  async markRead(args: { roomId: string; eventId: string }): Promise<{ ok: true }> {
    const cfg = this.auth.getMatrixConfig()
    if (!cfg) throw new Error('no matrix credentials')
    const { roomId, eventId } = args
    const markerUrl = `${cfg.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/read_markers`
    const receiptUrl = `${cfg.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/receipt/m.read/${encodeURIComponent(eventId)}`
    const headers = { Authorization: `Bearer ${cfg.accessToken}`, 'Content-Type': 'application/json' }
    const [m, r] = await Promise.all([
      fetch(markerUrl, { method: 'POST', headers, body: JSON.stringify({ 'm.fully_read': eventId, 'm.read': eventId }) }),
      fetch(receiptUrl, { method: 'POST', headers, body: JSON.stringify({}) }),
    ])
    if (!m.ok) this.log(`[matrix-sync] read_markers failed: ${m.status}`)
    if (!r.ok) this.log(`[matrix-sync] receipt failed: ${r.status}`)
    return { ok: true }
  }

  // ---- loop ----

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.tick()
      } catch (e) {
        const err = e as Error & { cause?: unknown }
        const cause = err.cause ? ` (cause: ${(err.cause as Error)?.message ?? String(err.cause)})` : ''
        this.log(`[matrix-sync] tick failed: ${err.message}${cause}`)
        await this.sleep(5_000)
        continue
      }
      // No extra sleep — /sync long-polls on the homeserver. The next tick
      // fires immediately; if there's nothing new, the server holds it open.
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((res) => setTimeout(res, ms))
  }

  private async tick(): Promise<void> {
    if (!this.crypto.isReady()) {
      // Nothing to sync against — back off politely.
      await this.sleep(10_000)
      return
    }
    const cfg = this.auth.getMatrixConfig()
    if (!cfg) {
      await this.sleep(10_000)
      return
    }
    this.inflight = true
    try {
      const resp = await this.matrix.sync({
        since: this.state.nextBatch,
        timeout: this.state.nextBatch ? this.LONG_POLL_MS : 0,
      })

      // 1. Feed crypto bits into OlmMachine + drain outgoing requests.
      await this.crypto.processSyncCrypto(
        {
          to_device: resp.to_device as any,
          device_lists: resp.device_lists as any,
          device_one_time_keys_count: resp.device_one_time_keys_count as any,
        },
        cfg.homeserver,
        cfg.accessToken,
      )

      // 2. Build delta: decrypt timeline events in place, per room.
      //    Mirror the homeserver's rooms.join shape so the browser can feed each
      //    sub-object straight into its existing processJoinedRoom(roomId, data).
      const isInitial = !this.state.nextBatch
      const { rooms, totalEvents, failedDecrypts } = await this.decryptJoinedRoomsWithCounts(resp.rooms?.join ?? {})

      const invites = Object.keys(resp.rooms?.invite ?? {})
      const leaves = Object.keys(resp.rooms?.leave ?? {})

      // 3. Persist next_batch BEFORE broadcast so a crash-after-send still
      //    advances the token (subscribers can re-ask for missed deltas).
      this.state.nextBatch = resp.next_batch
      this.state.lastSyncMs = Date.now()
      this.saveState()

      // 4. Broadcast.
      const delta: MatrixDelta = {
        nextBatch: resp.next_batch,
        rooms,
        invites: invites.length ? invites : undefined,
        leaves: leaves.length ? leaves : undefined,
      }
      const roomCount = Object.keys(rooms).length
      if (isInitial) {
        this.bus.broadcast('matrix', 'initial', delta)
        this.log(`[matrix-sync] initial sync complete: ${roomCount} rooms`)
      } else if (roomCount > 0 || invites.length > 0 || leaves.length > 0) {
        this.bus.broadcast('matrix', 'delta', delta)
        this.log(`[matrix-sync] delta: ${roomCount} rooms, ${totalEvents} events${failedDecrypts ? ` (${failedDecrypts} decrypt-failed)` : ''}`)
      }

      // 5. Push notifications for new messages from other users (not our own).
      if (!isInitial) {
        for (const [, r] of Object.entries(rooms)) {
          const events = r.timeline?.events ?? []
          // Derive a room name for the notification (best effort from state)
          let name: string | undefined
          for (const e of r.state?.events ?? []) {
            if (e.type === 'm.room.name' && (e.content as any)?.name) name = (e.content as any).name
          }
          for (const ev of events) {
            if (ev.sender === cfg.userId) continue
            if (ev.type !== 'm.room.message') continue
            const body = typeof (ev.content as any).body === 'string' ? (ev.content as any).body as string : ''
            if (!body) continue
            this.push.broadcast({
              type: 'chat',
              title: name ?? 'New message',
              body: body.slice(0, 140),
              pane: 'chat',
              id: `matrix:${ev.event_id}`,
            })
          }
        }
      }
    } finally {
      this.inflight = false
    }
  }

  // Decrypt timeline events across all joined rooms, returning a browser-ready
  // per-room delta. Shared by the tick loop (with event counts for logging)
  // and the snapshot RPC (counts discarded).
  private async decryptJoinedRoomsWithCounts(
    joined: Record<string, unknown>,
  ): Promise<{ rooms: Record<string, MatrixJoinedRoomDelta>; totalEvents: number; failedDecrypts: number }> {
    const rooms: Record<string, MatrixJoinedRoomDelta> = {}
    let totalEvents = 0
    let failedDecrypts = 0
    for (const [roomId, room] of Object.entries(joined)) {
      const src = room as {
        timeline?: { events?: any[]; prev_batch?: string; limited?: boolean }
        state?: { events?: any[] }
        ephemeral?: { events?: any[] }
        account_data?: { events?: any[] }
        unread_notifications?: { notification_count?: number; highlight_count?: number }
      }
      const timelineEvents: MatrixEventLike[] = []
      for (const ev of src.timeline?.events ?? []) {
        totalEvents++
        if (ev.type === 'm.room.encrypted') {
          const decrypted = await this.crypto.decryptRoomEvent(
            {
              type: ev.type,
              content: ev.content,
              event_id: ev.event_id,
              sender: ev.sender,
              origin_server_ts: ev.origin_server_ts,
              room_id: roomId,
            },
            roomId,
          )
          if (decrypted) {
            timelineEvents.push({
              event_id: ev.event_id,
              sender: ev.sender,
              origin_server_ts: ev.origin_server_ts,
              state_key: ev.state_key,
              unsigned: ev.unsigned,
              type: decrypted.type,
              content: decrypted.content,
            })
          } else {
            failedDecrypts++
            // Keep the original (browser can retry after key backup restore).
            timelineEvents.push({
              event_id: ev.event_id,
              sender: ev.sender,
              origin_server_ts: ev.origin_server_ts,
              state_key: ev.state_key,
              unsigned: ev.unsigned,
              type: ev.type,
              content: ev.content,
              _decryptFailed: true,
            })
          }
        } else {
          timelineEvents.push({
            event_id: ev.event_id,
            sender: ev.sender,
            origin_server_ts: ev.origin_server_ts,
            state_key: ev.state_key,
            unsigned: ev.unsigned,
            type: ev.type,
            content: ev.content,
          })
        }
      }
      rooms[roomId] = {
        timeline: src.timeline ? {
          events: timelineEvents,
          prev_batch: src.timeline.prev_batch,
          limited: src.timeline.limited,
        } : undefined,
        state: src.state ? { events: src.state.events as MatrixEventLike[] | undefined } : undefined,
        ephemeral: src.ephemeral ? { events: src.ephemeral.events as MatrixEventLike[] | undefined } : undefined,
        account_data: src.account_data ? { events: src.account_data.events as MatrixEventLike[] | undefined } : undefined,
        unread_notifications: src.unread_notifications,
      }
    }
    return { rooms, totalEvents, failedDecrypts }
  }

  private async decryptJoinedRooms(joined: Record<string, unknown>): Promise<Record<string, MatrixJoinedRoomDelta>> {
    const { rooms } = await this.decryptJoinedRoomsWithCounts(joined)
    return rooms
  }

  // ---- persistence ----

  private loadState(): void {
    try {
      if (existsSync(this.stateFile)) {
        this.state = JSON.parse(readFileSync(this.stateFile, 'utf8')) as MatrixSyncState
      }
    } catch (e) {
      this.log(`[matrix-sync] failed to load state: ${e}`)
      this.state = {}
    }
  }

  private saveState(): void {
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true })
      writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2))
    } catch (e) {
      this.log(`[matrix-sync] failed to save state: ${e}`)
    }
  }
}
