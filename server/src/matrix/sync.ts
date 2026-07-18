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
import type { ChatRoomsStore } from './chat-rooms-store.js'
import type { MessageArchive } from './message-archive.js'
import type { SyncRoomDelta } from './room-state.js'

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
  // Present on initial sync and any delta where `m.push_rules` arrived in
  // account_data — reflects the *full* current set of room-scoped muted rooms.
  // Client treats this as authoritative and resets `isMuted` across all known
  // rooms whenever the field is defined. Omitted when push rules didn't change.
  mutedRoomIds?: string[]
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
  /** roomIds with an active `room`-kind push rule set to `dont_notify`. */
  private mutedRooms = new Set<string>()
  /** Whether the most recent sync tick carried an `m.push_rules` event. */
  private pushRulesChangedThisTick = false
  /** roomIds with at least one outstanding push notification on the APK.
   *  In-memory only — on hub restart we forget; stale APK notifs survive
   *  until tapped. Used to fire a cancel when notification_count drops
   *  (message read elsewhere). */
  private readonly pushedRooms = new Set<string>()

  constructor(
    private readonly matrix: MatrixClient,
    private readonly crypto: HubMatrixCrypto,
    private readonly auth: AuthStore,
    private readonly bus: SyncBus,
    private readonly push: PushServer,
    private readonly stateFile: string,
    private readonly log: (msg: string) => void,
    /** Hub-owned canonical room snapshot. When provided, every /sync delta is
     *  computed into a RoomState and written here, making the hub the source
     *  of truth for room metadata across all connected clients. */
    private readonly chatRoomsStore?: ChatRoomsStore,
    /** Append-only archive of every decrypted event — the soft-delete-only
     *  guarantee. See message-archive.ts. */
    private readonly archive?: MessageArchive,
  ) {
    this.loadState()
  }

  start(): void {
    if (this.loopTimer) return
    this.stopped = false
    this.log('[matrix-sync] starting')
    // One-shot push-rules fetch on boot. Matrix only re-sends m.push_rules in
    // /sync's account_data when they *change*, so a warm hub restart starts
    // with an empty mutedRooms set until the next mute edit. Seeding here
    // keeps `mutedRoomIds` on the next resume() response accurate.
    this.refreshPushRules().catch((e) => this.log(`[matrix-sync] push-rules seed failed: ${e}`))
    // First tick shortly after boot so the hub doesn't block startup.
    this.loopTimer = setTimeout(() => { this.runLoop().catch((e) => this.log(`[matrix-sync] loop crashed: ${e}`)) }, 5_000)
  }

  private async refreshPushRules(): Promise<void> {
    if (!this.auth.getMatrixConfig()) return
    const rules = await this.matrix.getPushRules()
    const roomRules = rules.global?.room ?? []
    const next = new Set<string>()
    for (const r of roomRules) {
      if (r.enabled === false) continue
      const actions = r.actions ?? []
      const notifies = actions.some((a) => a === 'notify')
      const mutes = actions.some((a) => a === 'dont_notify')
      if (mutes && !notifies) next.add(r.rule_id)
    }
    this.mutedRooms = next
    this.log(`[matrix-sync] push rules seeded: ${next.size} muted rooms`)
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
    // Update the canonical room snapshot from this resume payload too. The
    // resume path is per-client point-to-point, but the snapshot it produces
    // is identical to what the tick path computes — so we get the latest
    // server state into the store regardless of which path delivered it.
    if (this.chatRoomsStore && Object.keys(rooms).length > 0) {
      this.chatRoomsStore.applySyncDelta(rooms as Record<string, SyncRoomDelta>, {
        myUserId: cfg.userId,
        mutedRoomIds: this.mutedRooms,
      })
    }
    if (this.chatRoomsStore && leaves.length > 0) {
      for (const id of leaves) this.chatRoomsStore.removeRoom(id)
    }
    return {
      nextBatch: resp.next_batch,
      rooms,
      invites: invites.length ? invites : undefined,
      leaves: leaves.length ? leaves : undefined,
      // Always send the full mute set on resume — the client just reconnected
      // and needs the current state regardless of whether push_rules appeared
      // in this particular response (they only come in when they change).
      mutedRoomIds: Array.from(this.mutedRooms),
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
   *
   * `txnId` (optional) is a client-supplied idempotency key used verbatim as
   * the Matrix transaction id: the homeserver dedups same-token PUTs on the
   * same access token, and the hub keeps its own txnId→event_id LRU as
   * belt-and-braces past the homeserver's txn window. This is what makes an
   * offline outbox safe — N retries of one queued send land exactly one event.
   */
  async sendRoomEvent(args: { roomId: string; type: string; content: Record<string, unknown>; txnId?: string }): Promise<{ event_id: string }> {
    const cfg = this.auth.getMatrixConfig()
    if (!cfg) throw new Error('no matrix credentials')
    const { roomId, type, content } = args
    if (!roomId || !type || typeof content !== 'object') throw new Error('roomId, type, content required')

    const clientTxn = typeof args.txnId === 'string' && /^[A-Za-z0-9._~-]{1,255}$/.test(args.txnId) ? args.txnId : undefined
    if (clientTxn) {
      const cached = this.sentTxnIds.get(clientTxn)
      if (cached) return { event_id: cached }
    }

    const encrypted = await this.roomIsEncrypted(roomId)
    const txnId = clientTxn ?? `hub${Date.now()}.${Math.random().toString(36).slice(2)}`

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
      const result = JSON.parse(text) as { event_id: string }
      if (clientTxn) this.rememberTxn(clientTxn, result.event_id)
      return result
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
    const result = JSON.parse(text) as { event_id: string }
    if (clientTxn) this.rememberTxn(clientTxn, result.event_id)
    return result
  }

  /** Client-txnId → event_id memo (insertion-ordered Map as LRU, cap 200).
   *  Outlives the homeserver's own txn dedup window for long-offline queues. */
  private readonly sentTxnIds = new Map<string, string>()
  private rememberTxn(txnId: string, eventId: string): void {
    this.sentTxnIds.delete(txnId)
    this.sentTxnIds.set(txnId, eventId)
    while (this.sentTxnIds.size > 200) {
      const oldest = this.sentTxnIds.keys().next().value
      if (oldest === undefined) break
      this.sentTxnIds.delete(oldest)
    }
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

  /**
   * Recover from a bridge FAIL_RETRIABLE (com.beeper.undecryptable_event):
   * the outbound Megolm session wedged, the bridge couldn't decrypt our
   * message, and the hub won't re-share the key on its own because it thinks
   * the bridge already has it. This fetches the failed event, decrypts it
   * (while we still hold the session), rotates the room key, then resends the
   * SAME plaintext as a fresh event — which forces a clean re-share. Returns
   * the new event_id so the caller can drop the wedged duplicate.
   *
   * Order is load-bearing: decrypt BEFORE rotate, or invalidating the session
   * would leave us unable to read our own failed message.
   */
  async resendAfterRotate(args: { roomId: string; eventId: string }): Promise<{ ok: true; eventId: string } | { ok: false; reason: string }> {
    const cfg = this.auth.getMatrixConfig()
    if (!cfg) throw new Error('no matrix credentials')
    const { roomId, eventId } = args
    if (!roomId || !eventId) throw new Error('roomId and eventId required')

    // 1. Fetch the failed event from the homeserver.
    let raw: Record<string, unknown>
    try {
      raw = await this.matrix.getEvent(roomId, eventId) as Record<string, unknown>
    } catch (e) {
      return { ok: false, reason: `fetch failed: ${(e as Error).message}` }
    }

    // 2. Recover the plaintext content + type. Encrypted → decrypt; if the
    //    event came back already-plaintext (unencrypted room), use it directly.
    let type: string
    let content: Record<string, unknown>
    if (raw.type === 'm.room.encrypted') {
      const dec = await this.crypto.decryptRoomEvent(raw, roomId)
      if (!dec) return { ok: false, reason: 'could not decrypt failed event to resend' }
      type = dec.type
      content = dec.content
    } else if (typeof raw.type === 'string' && raw.content && typeof raw.content === 'object') {
      type = raw.type
      content = raw.content as Record<string, unknown>
    } else {
      return { ok: false, reason: 'unexpected event shape' }
    }

    // Don't resend an already-redacted / empty event.
    if (!content || Object.keys(content).length === 0) {
      return { ok: false, reason: 'event has no content (redacted?)' }
    }

    // 3. Throw away the wedged outbound session.
    await this.crypto.invalidateRoomKey(roomId)

    // 4. Resend the plaintext — sendRoomEvent re-shares the fresh key to all
    //    members, including the bridge bot, before encrypting.
    const result = await this.sendRoomEvent({ roomId, type, content })
    return { ok: true, eventId: result.event_id }
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
    // Archive paginated history too — history loads are how older messages
    // (sent before the archive existed, or before the hub was watching a
    // room) get their pre-redaction copies preserved.
    if (this.archive) {
      try {
        this.archive.archiveEvents(args.roomId, decryptedChunk as unknown as Array<Record<string, unknown>>)
      } catch { /* best effort */ }
    }
    return { chunk: decryptedChunk, state: resp.state as MatrixEventLike[] | undefined, start: resp.start, end: resp.end }
  }

  /** Set fully_read + m.read marker and send an m.read receipt. */
  async markRead(args: { roomId: string; eventId: string }): Promise<{ ok: true }> {
    const cfg = this.auth.getMatrixConfig()
    if (!cfg) throw new Error('no matrix credentials')
    const { roomId, eventId } = args
    // Optimistic: flip the snapshot now so every connected client sees the
    // room as read immediately — no need to wait for the next homeserver
    // /sync delta to round-trip our own receipt back to us.
    this.chatRoomsStore?.setRoomRead(roomId, eventId)
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

  /** Mark a room as unread again — hub-only state (Matrix has no API for it).
   *  Broadcast immediately so every device flips the badge in lockstep. */
  async markUnread(args: { roomId: string }): Promise<{ ok: true }> {
    if (!args?.roomId) throw new Error('roomId required')
    this.chatRoomsStore?.setRoomUnread(args.roomId)
    return { ok: true }
  }

  /** Snooze a room until a future time. Local-only (Matrix has no API for
   *  it either) — but hub-owned so every device snoozes / unsnoozes together. */
  async snooze(args: { roomId: string; untilMs?: number }): Promise<{ ok: true }> {
    if (!args?.roomId) throw new Error('roomId required')
    this.chatRoomsStore?.setRoomSnoozedUntil(args.roomId, args.untilMs)
    return { ok: true }
  }

  /**
   * Re-derive a room's metadata (name, memberCount, isDirect, avatar) from its
   * FULL current state. Incremental /sync uses lazy_load_members, so these
   * fields only recompute when a delta happens to carry m.room.create —
   * otherwise a stale value (e.g. an inflated memberCount from a WhatsApp
   * re-link transient) sticks forever. Fetching /state gives the complete
   * member list (incl. m.room.create), so computeRoomState's `hasFullMembers`
   * branch recomputes correctly. Everything else (unread, preview, tags,
   * receipts) is preserved because the synthetic delta carries only state.
   */
  async refreshRoomState(args: { roomId: string }): Promise<{ ok: true; memberCount: number; isDirect: boolean; name: string }> {
    const cfg = this.auth.getMatrixConfig()
    if (!cfg) throw new Error('no matrix credentials')
    if (!this.chatRoomsStore) throw new Error('chat rooms store not configured')
    const { roomId } = args
    if (!roomId) throw new Error('roomId required')
    const state = await this.matrix.getRoomState(roomId) as MatrixEventLike[]
    this.chatRoomsStore.applySyncDelta(
      { [roomId]: { state: { events: state } } } as Record<string, SyncRoomDelta>,
      { myUserId: cfg.userId, mutedRoomIds: this.mutedRooms },
    )
    const room = this.chatRoomsStore.snapshot().data[roomId]
    return { ok: true, memberCount: room?.memberCount ?? 0, isDirect: room?.isDirect ?? false, name: room?.name ?? roomId }
  }

  /**
   * One-shot sweep that finds DMs whose cached memberCount got inflated by a
   * bridge re-link and re-derives them from full state. Cheap pre-filter: a
   * lean summary /sync gives `m.joined_member_count` per room without member
   * state; a room with ≤3 joined (me + contact + bridge bot) but a cached
   * memberCount > 2 is an inflated DM. Only those get a full /state fetch,
   * throttled, so we touch a few dozen rooms instead of every bridge group.
   * Gated by the caller (runs once per deploy via a version marker).
   */
  async refreshStaleDmRooms(): Promise<{ scanned: number; refreshed: number }> {
    const cfg = this.auth.getMatrixConfig()
    if (!cfg || !this.chatRoomsStore) return { scanned: 0, refreshed: 0 }
    // Lean summary sync — timeline limit 0, no state/account_data, just the
    // room summary (joined_member_count) + the joined-room set.
    const filter = JSON.stringify({
      room: {
        timeline: { limit: 1 },
        state: { lazy_load_members: true, types: ['m.room.create'] },
        ephemeral: { types: [] },
        account_data: { types: [] },
      },
      account_data: { types: [] },
      presence: { types: [] },
    })
    const url = `${cfg.homeserver}/_matrix/client/v3/sync?timeout=0&filter=${encodeURIComponent(filter)}`
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${cfg.accessToken}` } })
    if (!resp.ok) {
      this.log(`[matrix-sync] refreshStaleDmRooms: summary sync failed ${resp.status}`)
      return { scanned: 0, refreshed: 0 }
    }
    const data = await resp.json() as { rooms?: { join?: Record<string, { summary?: { 'm.joined_member_count'?: number } }> } }
    const joined = data.rooms?.join ?? {}
    const snapshot = this.chatRoomsStore.snapshot().data
    const candidates: string[] = []
    for (const [roomId, r] of Object.entries(joined)) {
      const cached = snapshot[roomId]
      if (!cached) continue
      const joinedCount = r.summary?.['m.joined_member_count']
      // Inflated DM: server says ≤3 joined (me + contact + bot) but cache
      // thinks it's a >2-member group.
      if (typeof joinedCount === 'number' && joinedCount <= 3 && cached.memberCount > 2) {
        candidates.push(roomId)
      }
    }
    this.log(`[matrix-sync] refreshStaleDmRooms: ${candidates.length} inflated DM(s) of ${Object.keys(joined).length} rooms`)
    let refreshed = 0
    const BATCH = 5
    for (let i = 0; i < candidates.length; i += BATCH) {
      const batch = candidates.slice(i, i + BATCH)
      await Promise.all(batch.map(async (roomId) => {
        try {
          await this.refreshRoomState({ roomId })
          refreshed++
        } catch (e) {
          this.log(`[matrix-sync] refreshStaleDmRooms: ${roomId} failed: ${(e as Error).message}`)
        }
      }))
      if (i + BATCH < candidates.length) await this.sleep(250)
    }
    this.log(`[matrix-sync] refreshStaleDmRooms: refreshed ${refreshed}/${candidates.length}`)
    return { scanned: candidates.length, refreshed }
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

      // 4. Broadcast. Only carry `mutedRoomIds` when push rules changed this
      // tick — clients treat a defined array as authoritative across all
      // known rooms, so omitting it when unchanged avoids needless IDB writes.
      const delta: MatrixDelta = {
        nextBatch: resp.next_batch,
        rooms,
        invites: invites.length ? invites : undefined,
        leaves: leaves.length ? leaves : undefined,
        mutedRoomIds: (isInitial || this.pushRulesChangedThisTick)
          ? Array.from(this.mutedRooms)
          : undefined,
      }
      this.pushRulesChangedThisTick = false
      const roomCount = Object.keys(rooms).length
      if (isInitial) {
        this.bus.broadcast('matrix', 'initial', delta)
        this.log(`[matrix-sync] initial sync complete: ${roomCount} rooms`)
      } else if (roomCount > 0 || invites.length > 0 || leaves.length > 0) {
        this.bus.broadcast('matrix', 'delta', delta)
        this.log(`[matrix-sync] delta: ${roomCount} rooms, ${totalEvents} events${failedDecrypts ? ` (${failedDecrypts} decrypt-failed)` : ''}`)
      }

      // Update hub-owned room snapshot — derives the canonical inbox view
      // (name, isUnread, memberCount, …) and broadcasts on `chat-rooms.delta`
      // so every connected client converges to the same state.
      if (this.chatRoomsStore && roomCount > 0) {
        const userId = cfg.userId
        this.chatRoomsStore.applySyncDelta(rooms as Record<string, SyncRoomDelta>, {
          myUserId: userId,
          mutedRoomIds: this.mutedRooms,
        })
      }
      if (this.chatRoomsStore && this.pushRulesChangedThisTick) {
        // Re-sync mute flag across all rooms whenever push rules changed —
        // handled in addition to the per-room delta above so muted-state flips
        // on rooms that didn't appear in this tick still propagate.
        this.chatRoomsStore.setMutedRoomIds(this.mutedRooms)
      }
      if (this.chatRoomsStore) {
        for (const leftId of leaves) this.chatRoomsStore.removeRoom(leftId)
      }

      // 5. Push notifications for new messages from other users (not our own).
      if (!isInitial) {
        for (const [roomId, r] of Object.entries(rooms)) {
          // Dismiss-on-caught-up FIRST — before the empty-timeline guard.
          // Marking a room read produces a receipt-only delta: updated
          // unread_notifications, ZERO new timeline events. The old code
          // `continue`d on empty timeline before reaching the dismiss, so a
          // read on the PC never cleared the phone's notification.
          //
          // Gate on an EXPLICIT zero: an ABSENT unread_notifications means
          // "no change to my unread state" (e.g. someone else's read receipt
          // arriving as an ephemeral-only delta) and must NOT clear a
          // notification I haven't read — mirrors the absent≠zero rule in
          // room-state.ts. An explicit 0 means I caught up here or elsewhere.
          //
          // Broadcast the cancel UNCONDITIONALLY (no pushedRooms gate): that
          // set is in-memory, so a hub restart would otherwise orphan every
          // notification pushed before it, forever. A cancel for a room with
          // no live notification is a harmless no-op on the APK.
          const explicitNotif = r.unread_notifications?.notification_count
          if (explicitNotif === 0) {
            this.pushedRooms.delete(roomId)
            this.push.broadcast({ type: 'chat', cancel: true, roomId })
            continue
          }

          const events = r.timeline?.events ?? []
          if (events.length === 0) continue

          // Mute detection:
          //   * server's push rules muted this room → notification_count is 0
          //   * room tagged m.lowpriority / m.archive → only notify on mentions
          //   * room muted in Console (push-rule) → never notify
          const notifCount = r.unread_notifications?.notification_count ?? 0
          const highlightCount = r.unread_notifications?.highlight_count ?? 0
          // Absent count (the only way to reach here with notifCount 0, since
          // explicit-0 was handled above) → no new unread info; don't push.
          if (notifCount === 0) continue

          // Low-priority / mute must come from the CANONICAL snapshot, not the
          // delta's account_data. `m.tag` is only delivered when a tag CHANGES,
          // so a room marked low-priority long ago carries no m.tag in a routine
          // message delta — the old per-delta check saw undefined and notified
          // anyway (the bug). The snapshot persists isLowPriority/isMuted and is
          // always current. Fall back to the delta's m.tag only if the room
          // isn't in the snapshot yet (first sight).
          const snapshotRoom = this.chatRoomsStore?.snapshot().data[roomId]
          let isLowPriority: boolean
          if (snapshotRoom) {
            isLowPriority = snapshotRoom.isLowPriority
            if (snapshotRoom.isMuted) continue // muted → never notify
          } else {
            const tagEvent = (r.account_data?.events ?? []).find((e) => e.type === 'm.tag')
            const tags = (tagEvent?.content as any)?.tags as Record<string, unknown> | undefined
            isLowPriority = !!(tags?.['m.lowpriority'] || tags?.['m.archive'])
          }
          if (isLowPriority && highlightCount === 0) continue

          const cache = this.roomState.get(roomId)
          // Prefer the canonical, persisted chat-rooms snapshot for
          // name/isDirect/avatar. The local `roomState` cache only learns a
          // room's name from `m.room.name` state events, which Matrix replays
          // on initial sync (or when the name changes) — so after a hub restart
          // an incremental sync delivering a group message carries no name, the
          // cache stays empty, and the notification falls back to the sender's
          // name (looks like a DM). The chat-rooms snapshot resolves names via
          // heroes/bridge-member fallbacks and is persisted to disk, so it's
          // correct across restarts.
          const canonical = this.chatRoomsStore?.snapshot().data[roomId]
          const isDirect = canonical?.isDirect ?? cache?.isDirect ?? this.directRooms.has(roomId)
          const roomName = canonical?.name ?? cache?.name
          const roomAvatarMxc = canonical?.avatar ?? cache?.avatarMxc

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
              roomAvatarMxc,
              isDirect,
              timestamp: ev.origin_server_ts,
            })
            this.pushedRooms.add(roomId)
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
      if (e.type === 'm.direct' && e.content) {
        // m.direct content is { userId: [roomId, ...], ... }
        const next = new Set<string>()
        for (const rooms of Object.values(e.content as Record<string, unknown>)) {
          if (!Array.isArray(rooms)) continue
          for (const r of rooms) if (typeof r === 'string') next.add(r)
        }
        this.directRooms = next
      } else if (e.type === 'm.push_rules' && e.content) {
        // Top-level m.push_rules event carries the full ruleset on every change.
        // We only care about the `room` kind (per-room overrides) — Element's
        // "Mute" uses `override`, but Beeper's bridges use `room`, and the
        // homeserver's actual notif_count respects both. Reading `room` here
        // keeps our UI label in sync with whatever WhatsApp/Signal mutes
        // propagate via Beeper's double-puppet.
        const global = (e.content as { global?: { room?: unknown[] } }).global
        const roomRules = Array.isArray(global?.room) ? global.room : []
        const next = new Set<string>()
        for (const r of roomRules as Array<{ rule_id?: string; enabled?: boolean; actions?: unknown[] }>) {
          if (!r.rule_id || r.enabled === false) continue
          const actions = r.actions ?? []
          // dont_notify can appear as a bare string or nested object — treat
          // any actions that don't include `notify` as muted.
          const notifies = actions.some((a) => a === 'notify' || (typeof a === 'object' && a !== null && (a as { set_tweak?: string }).set_tweak === 'sound'))
          const mutes = actions.some((a) => a === 'dont_notify')
          if (mutes && !notifies) next.add(r.rule_id)
        }
        this.mutedRooms = next
        this.pushRulesChangedThisTick = true
      }
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
      // Soft-delete guarantee: archive every decrypted message-bearing event
      // BEFORE anything downstream sees it, and rescue media the moment a
      // redaction is observed. Append-only; the archive has no delete API.
      if (this.archive) {
        try {
          this.archive.archiveEvents(roomId, timelineEvents as unknown as Array<Record<string, unknown>>)
        } catch (e) {
          this.log(`[archive] archiveEvents failed for ${roomId}: ${(e as Error).message}`)
        }
        for (const ev of timelineEvents) {
          // Two redaction shapes: explicit m.room.redaction events, and
          // encrypted tombstones (m.room.encrypted with stripped ciphertext).
          let targetId: string | undefined
          let redactedBy: string | undefined
          if (ev.type === 'm.room.redaction') {
            targetId = ((ev.content as any)?.redacts as string) || ((ev as any).redacts as string)
            redactedBy = ev.sender
          } else if (ev.type === 'm.room.encrypted' && typeof (ev.content as any)?.ciphertext !== 'string' && ev.event_id) {
            targetId = ev.event_id
            redactedBy = ((ev.unsigned as any)?.redacted_because?.sender as string) ?? ev.sender
          }
          if (targetId) {
            void this.archive.recordRedaction(roomId, targetId, redactedBy, (mxc) => this.fetchMediaBlob(mxc))
              .then((file) => { if (file) this.log(`[archive] rescued media for redacted ${targetId} → ${file}`) })
              .catch(() => {})
          }
        }
      }
    }
    return { rooms, totalEvents, failedDecrypts }
  }

  /** Download a raw media blob from the homeserver (authenticated MSC3916
   *  endpoint with legacy fallback). Used by the archive's media rescue. */
  private async fetchMediaBlob(mxcUrl: string): Promise<Buffer | undefined> {
    const cfg = this.auth.getMatrixConfig()
    if (!cfg || !mxcUrl.startsWith('mxc://')) return undefined
    const [server, mediaId] = mxcUrl.slice(6).split('/', 2)
    if (!server || !mediaId) return undefined
    const urls = [
      `${cfg.homeserver}/_matrix/client/v1/media/download/${encodeURIComponent(server)}/${encodeURIComponent(mediaId)}`,
      `${cfg.homeserver}/_matrix/media/v3/download/${encodeURIComponent(server)}/${encodeURIComponent(mediaId)}`,
    ]
    for (const url of urls) {
      try {
        const resp = await fetch(url, { headers: { Authorization: `Bearer ${cfg.accessToken}` } })
        if (resp.ok) return Buffer.from(await resp.arrayBuffer())
      } catch { /* try next */ }
    }
    return undefined
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
