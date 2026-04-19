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

// Lightweight server-side cache of room state so push notifications can carry
// sender display names, avatars, and direct-chat flags without re-fetching
// state on every message.
type MemberInfo = { displayname?: string; avatarMxc?: string }
type RoomStateCache = {
  name?: string
  avatarMxc?: string
  isDirect?: boolean
  members: Map<string, MemberInfo>
}

export class MatrixSync {
  private state: MatrixSyncState = {}
  private loopTimer: NodeJS.Timeout | null = null
  private stopped = false
  private inflight = false
  private readonly LONG_POLL_MS = 30_000
  /** roomId → cached state, built progressively from sync. */
  private readonly roomState = new Map<string, RoomStateCache>()
  /** roomIds flagged as DMs in global account_data (`m.direct`). */
  private directRooms = new Set<string>()

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

  // Point-to-point resume: the caller supplies its own last-seen `since` token
  // (persisted client-side) and the hub runs `/sync?since=...&timeout=0` on
  // the homeserver, decrypts the result, and returns it directly. Without a
  // `since`, this degrades to a cold-start initial sync. If the server rejects
  // the token (M_UNKNOWN_TOKEN etc.), we transparently fall back to initial
  // and mark the response as `isInitial` so the client can treat it as a
  // reset rather than an incremental merge.
  //
  // Does NOT touch this.state.nextBatch — the main tick loop keeps its own
  // cursor untouched. Safe to call concurrently with ticks; `decryptRoomEvent`
  // uses keys the OlmMachine already has from the main loop.
  async resume(args?: { since?: string }): Promise<MatrixDelta & { isInitial?: boolean }> {
    const cfg = this.auth.getMatrixConfig()
    if (!cfg || !this.crypto.isReady()) {
      return { nextBatch: '', rooms: {}, isInitial: !args?.since }
    }

    const wantedSince = args?.since
    let resp
    let isInitial = !wantedSince
    try {
      resp = await this.matrix.sync({ since: wantedSince, timeout: 0 })
    } catch (e) {
      const msg = (e as Error).message
      if (wantedSince && /M_UNKNOWN_TOKEN|400|invalid/i.test(msg)) {
        this.log(`[matrix-sync] resume: homeserver rejected since token (${msg}); falling back to initial`)
        resp = await this.matrix.sync({ since: undefined, timeout: 0 })
        isInitial = true
      } else {
        throw e
      }
    }
    const allRooms = await this.decryptJoinedRooms(resp.rooms?.join ?? {})
    this.ingestAccountData(resp.account_data)
    for (const [roomId, r] of Object.entries(allRooms)) {
      this.ingestRoomState(roomId, r)
    }
    if (!isInitial) await this.backfillLimitedTimelines(allRooms, 'resume')
    // Cold-start: cut the 1000+ joined-rooms list down to ones the user is
    // likely to care about right now — anything with unread notifications, or
    // any timeline activity in the last 30 days. The rest (dead Beeper bridges,
    // abandoned DMs) stay invisible until a live delta brings them back to
    // life, at which point processJoinedRoom creates the room record on demand.
    // `nextBatch` covers ALL rooms, so subsequent `since` queries still catch
    // any room that wakes up.
    const COLD_RECENT_MS = 30 * 24 * 60 * 60 * 1000
    const cutoff = Date.now() - COLD_RECENT_MS
    const rooms = isInitial
      ? Object.fromEntries(
          Object.entries(allRooms).filter(([, r]) => {
            const unread = (r.unread_notifications?.notification_count ?? 0)
              + (r.unread_notifications?.highlight_count ?? 0)
            if (unread > 0) return true
            const events = r.timeline?.events ?? []
            return events.some((e) => (e.origin_server_ts ?? 0) >= cutoff)
          }),
        )
      : allRooms
    const invites = Object.keys(resp.rooms?.invite ?? {})
    const leaves = Object.keys(resp.rooms?.leave ?? {})
    const eventCount = Object.values(rooms).reduce(
      (n, r) => n + (r.timeline?.events?.length ?? 0), 0,
    )
    this.log(
      `[matrix-sync] resume${wantedSince ? ` since=${wantedSince.slice(0, 12)}…` : ' (cold)'}`
      + `: ${Object.keys(rooms).length}/${Object.keys(allRooms).length} rooms, ${eventCount} events`,
    )
    return {
      nextBatch: resp.next_batch,
      rooms,
      invites: invites.length ? invites : undefined,
      leaves: leaves.length ? leaves : undefined,
      isInitial,
    }
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

  /**
   * Force-rotate the outbound Megolm session for a room. Next sendRoomEvent
   * will create a fresh session and re-share with all current members.
   * Surface-exposed via `matrix.rotateRoomKey` RPC — the UI can call this
   * on a failed send to recover without waiting for the automatic retry
   * interval baked into the OlmMachine rotation policy.
   */
  async rotateRoomKey(args: { roomId: string }): Promise<{ ok: true }> {
    if (!args?.roomId) throw new Error('roomId required')
    await this.crypto.invalidateRoomKey(args.roomId)
    return { ok: true }
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
   * Close the gap when `/sync` returns `limited: true` for a room. The
   * homeserver default timeline limit (~10 events/room) means a client that
   * misses enough messages in one room between two sync points silently
   * loses everything but the latest 10. Here we paginate backward from
   * `prev_batch` and prepend the missed events so the browser's idempotent
   * `bulkPut(event_id)` ingestion picks them up. Runs in parallel across rooms.
   */
  private async backfillLimitedTimelines(
    rooms: Record<string, MatrixJoinedRoomDelta>,
    source: 'resume' | 'tick',
  ): Promise<void> {
    const GAP_LIMIT_PER_ROOM = 100
    await Promise.all(
      Object.entries(rooms).map(async ([roomId, r]) => {
        if (!r.timeline?.limited || !r.timeline.prev_batch) return
        try {
          const gap = await this.paginate({
            roomId,
            from: r.timeline.prev_batch,
            dir: 'b',
            limit: GAP_LIMIT_PER_ROOM,
          })
          // /messages with dir=b returns newest-first; reverse to chronological
          // order before prepending to the existing timeline events.
          const gapEvents = (gap.chunk ?? []).slice().reverse()
          r.timeline.events = [...gapEvents, ...(r.timeline.events ?? [])]
          this.log(
            `[matrix-sync] ${source}: backfilled ${gapEvents.length} events for ${roomId} (limited gap)`,
          )
        } catch (e) {
          this.log(`[matrix-sync] ${source}: backfill failed for ${roomId}: ${(e as Error).message}`)
        }
      }),
    )
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

      // 2a. Update server-side room-state cache + direct-room set so push
      //     notifications can be enriched with sender name / avatar / DM flag.
      this.ingestAccountData(resp.account_data)
      for (const [roomId, r] of Object.entries(rooms)) {
        this.ingestRoomState(roomId, r)
      }

      // 2b. Backfill any rooms whose timeline came back `limited` (gap > ~10
      //     events in a single tick). Safe because bulkPut on event_id is
      //     idempotent browser-side.
      if (!isInitial) await this.backfillLimitedTimelines(rooms, 'tick')

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
        for (const [roomId, r] of Object.entries(rooms)) {
          const events = r.timeline?.events ?? []
          if (events.length === 0) continue

          // Mute detection — mirror the browser's logic:
          //   * server's push rules muted this room → notification_count is 0
          //   * room tagged m.lowpriority / m.archive → only notify on mentions
          const notifCount = r.unread_notifications?.notification_count ?? 0
          const highlightCount = r.unread_notifications?.highlight_count ?? 0
          if (notifCount === 0) continue
          const tagEvent = (r.account_data?.events ?? []).find((e) => e.type === 'm.tag')
          const tags = (tagEvent?.content as any)?.tags as Record<string, unknown> | undefined
          const isLowPriority = !!(tags?.['m.lowpriority'] || tags?.['m.archive'])
          if (isLowPriority && highlightCount === 0) continue

          const cache = this.roomState.get(roomId)
          const isDirect = cache?.isDirect ?? this.directRooms.has(roomId)
          const roomName = cache?.name

          for (const ev of events) {
            if (ev.sender === cfg.userId) continue
            if (ev.type !== 'm.room.message') continue
            const content = ev.content as any
            const body = typeof content.body === 'string' ? (content.body as string) : ''
            if (!body) continue

            const member = ev.sender ? cache?.members.get(ev.sender) : undefined
            const senderName = member?.displayname || ev.sender || 'Unknown'
            // Display title: DM → sender name; group → room name (fall back to sender)
            const title = isDirect ? senderName : (roomName || senderName)

            this.push.broadcast({
              type: 'chat',
              title,
              body: body.slice(0, 280),
              pane: 'chat',
              id: `matrix:${ev.event_id}`,
              roomId,
              roomName,
              senderName,
              senderId: ev.sender,
              senderAvatarMxc: member?.avatarMxc,
              roomAvatarMxc: cache?.avatarMxc,
              isDirect,
              timestamp: ev.origin_server_ts,
            })
          }
        }
      }
    } finally {
      this.inflight = false
    }
  }

  // ---- room-state cache (for push-notification enrichment) ---------------

  /** Update the direct-room set from global `m.direct` account data. */
  private ingestAccountData(accountData: unknown): void {
    const events = (accountData as { events?: Array<{ type?: string; content?: any }> })?.events
    if (!events) return
    for (const e of events) {
      if (e.type !== 'm.direct' || !e.content) continue
      // m.direct content is { userId: [roomId, ...], ... }
      const next = new Set<string>()
      for (const rooms of Object.values(e.content as Record<string, unknown>)) {
        if (!Array.isArray(rooms)) continue
        for (const r of rooms) if (typeof r === 'string') next.add(r)
      }
      this.directRooms = next
    }
  }

  /** Merge state events + timeline state into the per-room cache. */
  private ingestRoomState(roomId: string, r: MatrixJoinedRoomDelta): void {
    let cache = this.roomState.get(roomId)
    if (!cache) {
      cache = { members: new Map() }
      this.roomState.set(roomId, cache)
    }
    const stateEvents = r.state?.events ?? []
    // Timeline events can carry state-event shapes (e.g. m.room.member set by
    // the sender for their own join). Matrix lazy-load often only delivers
    // the sender's member event that way on subsequent syncs.
    const timelineEvents = r.timeline?.events ?? []
    for (const src of [stateEvents, timelineEvents]) {
      for (const e of src) {
        const content = e.content as any
        if (!content) continue
        switch (e.type) {
          case 'm.room.name':
            if (typeof content.name === 'string' && content.name) cache.name = content.name
            break
          case 'm.room.avatar':
            if (typeof content.url === 'string') cache.avatarMxc = content.url
            break
          case 'm.room.canonical_alias':
            if (!cache.name && typeof content.alias === 'string') cache.name = content.alias
            break
          case 'm.room.member':
            if (e.state_key) {
              const info: MemberInfo = {
                displayname: typeof content.displayname === 'string' ? content.displayname : undefined,
                avatarMxc: typeof content.avatar_url === 'string' ? content.avatar_url : undefined,
              }
              cache.members.set(e.state_key, info)
            }
            break
        }
      }
    }
    if (cache.isDirect === undefined && this.directRooms.has(roomId)) {
      cache.isDirect = true
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
