// Matrix routes — room list, messages, send, reactions, read receipts
// For now, these proxy directly to the homeserver via MatrixClient.
// In the future, the hub will run a background sync loop for E2E crypto.

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { MatrixClient } from '../matrix-client.js'
import type { KeyBackupStore, KeyBackupBlob } from '../matrix/key-backup-store.js'
import type { HubMatrixCrypto } from '../matrix/crypto.js'
import type { AuthStore } from '../auth-store.js'
import type { MatrixSync } from '../matrix/sync.js'
import { matrixPasswordLogin } from '../matrix/login.js'
import { restoreFromRecoveryKey, restoreCrossSigningFromRecoveryKey } from '../matrix/backup-restore.js'

// Bridge detection — mirrored from src/matrix/sync.ts (browser side). Looks
// at joined ghost user IDs first, then bridge-bot IDs as a fallback for
// channels/broadcasts that have no ghost members. Returns a normalized
// network slug (`linkedin`, `whatsapp`, `slack`, etc.) or undefined.
const GHOST_RE = /^@(whatsapp|signal|telegram|discord(?:go)?|slack(?:go)?|instagram(?:go)?|facebook|twitter|linkedin|googlechat|gmessages|imessage(?:cloud)?)_/i
const BOT_RE = /^@(whatsapp|signal|telegram|discord(?:go)?|slack(?:go)?|instagram(?:go)?|facebook|twitter|linkedin|googlechat|gmessages|imessage(?:cloud)?)bot:/i

function networkFromUserId(userId: string, re: RegExp): string | undefined {
  const m = userId.match(re)
  if (!m) return undefined
  const raw = m[1]!.toLowerCase()
  if (raw === 'imessagecloud') return 'imessage'
  return raw.replace(/go$/, '')
}

function detectBridgeNetwork(stateEvents: any[]): string | undefined {
  const joined = stateEvents.filter(
    (e) => e.type === 'm.room.member' && e.content?.membership === 'join',
  )
  let botNetwork: string | undefined
  for (const ev of joined) {
    const uid = (ev.state_key as string) ?? ''
    const ghost = networkFromUserId(uid, GHOST_RE)
    if (ghost) return ghost
    if (!botNetwork) botNetwork = networkFromUserId(uid, BOT_RE)
  }
  return botNetwork
}

function isBridgeBot(userId: string): boolean {
  return BOT_RE.test(userId)
}

// Compute a human room name. Mirrors src/matrix/sync.ts:getRoomName — uses
// m.room.name when set, else canonical_alias, else falls back to joined
// non-self / non-bot member display names (deduped). Returns the roomId only
// when no usable signal exists.
function computeRoomName(stateEvents: any[], roomId: string, myUserId: string): string {
  for (const e of stateEvents) {
    if (e.type === 'm.room.name' && e.state_key === '' && e.content?.name) {
      return e.content.name as string
    }
  }
  for (const e of stateEvents) {
    if (e.type === 'm.room.canonical_alias' && e.state_key === '' && e.content?.alias) {
      return e.content.alias as string
    }
  }
  const joined = stateEvents.filter(
    (e) => e.type === 'm.room.member' && e.content?.membership === 'join',
  )
  const others = joined.filter((e) => {
    const uid = (e.state_key as string) ?? ''
    return uid !== myUserId && !isBridgeBot(uid)
  })
  if (others.length === 0) return roomId
  const names = Array.from(new Set(
    others.map((e) => (e.content?.displayname as string) || (e.state_key as string) || '?'),
  ))
  return names.slice(0, 3).join(', ')
}

export function handleMatrixRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
  matrix: MatrixClient,
  keyBackup: KeyBackupStore,
  hubCrypto: HubMatrixCrypto,
  authStore: AuthStore,
  matrixSync: MatrixSync,
  readBody: (req: IncomingMessage) => Promise<string>,
): boolean {
  const json = (data: unknown, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }

  const error = (status: number, message: string) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: message }))
  }

  const handleAsync = (fn: () => Promise<void>) => {
    fn().catch((err: Error) => {
      const status = (err as any).status || 500
      error(status, err.message)
    })
    return true
  }

  // GET /matrix/rooms
  if (path === '/matrix/rooms' && req.method === 'GET') {
    return handleAsync(async () => {
      const filter = url.searchParams.get('filter') || 'all'
      const networkFilter = url.searchParams.get('network')?.toLowerCase()

      // Do a sync with timeout=0 to get current room state
      const syncData = await matrix.sync({ timeout: 0 })
      const rooms: Array<Record<string, unknown>> = []

      const myUserId = authStore.getMatrixConfig()?.userId ?? ''
      const joinedRooms = syncData.rooms?.join || {}
      for (const [roomId, room] of Object.entries(joinedRooms)) {
        const stateEvents = [...(room as any).state.events, ...(room as any).timeline.events.filter((e: any) => e.state_key !== undefined)]

        const name = computeRoomName(stateEvents, roomId, myUserId)
        const unread = (room as any).unread_notifications?.notification_count || 0
        const memberCount = (room as any).summary?.['m.joined_member_count'] || 0
        const network = detectBridgeNetwork(stateEvents)

        // Apply filters
        if (filter === 'unread' && unread === 0) continue
        if (networkFilter && network !== networkFilter) continue

        rooms.push({
          id: roomId,
          name,
          network,
          unreadCount: unread,
          memberCount,
          lastActivity: (room as any).timeline.events.at(-1)?.origin_server_ts,
        })
      }

      // Sort by last activity
      rooms.sort((a, b) => ((b.lastActivity as number) || 0) - ((a.lastActivity as number) || 0))
      json(rooms)
    })
  }

  // GET /matrix/rooms/:id/messages
  const messagesMatch = path.match(/^\/matrix\/rooms\/([^/]+)\/messages$/)
  if (messagesMatch && req.method === 'GET') {
    return handleAsync(async () => {
      const roomId = decodeURIComponent(messagesMatch[1]!)
      const limit = parseInt(url.searchParams.get('limit') || '50', 10)
      const before = url.searchParams.get('before') || undefined

      const data = await matrix.getRoomMessages(roomId, { from: before, limit })

      // Decrypt encrypted events through the hub's OlmMachine. Anything that
      // can't be decrypted (key still missing, etc.) falls through to its
      // raw form so callers see at least the event id + timestamp; the CLI
      // marker `decryptFailed: true` lets consumers tell ciphertext apart
      // from genuine plaintext events.
      const cryptoReady = hubCrypto.isReady()
      const messages = await Promise.all(
        (data as any).chunk
          .filter((e: any) => e.type === 'm.room.message' || e.type === 'm.room.encrypted')
          .map(async (e: any) => {
            if (e.type === 'm.room.encrypted' && cryptoReady) {
              const dec = await hubCrypto.decryptRoomEvent(e, roomId)
              if (dec) {
                return {
                  id: e.event_id,
                  sender: e.sender,
                  timestamp: e.origin_server_ts,
                  type: dec.type,
                  content: dec.content,
                }
              }
              return {
                id: e.event_id,
                sender: e.sender,
                timestamp: e.origin_server_ts,
                type: e.type,
                content: e.content,
                decryptFailed: true,
              }
            }
            return {
              id: e.event_id,
              sender: e.sender,
              timestamp: e.origin_server_ts,
              type: e.type,
              content: e.content,
            }
          }),
      )

      json({
        messages,
        prevBatch: (data as any).end,
      })
    })
  }

  // POST /matrix/rooms/:id/send
  const sendMatch = path.match(/^\/matrix\/rooms\/([^/]+)\/send$/)
  if (sendMatch && req.method === 'POST') {
    return handleAsync(async () => {
      const roomId = decodeURIComponent(sendMatch[1]!)
      const body = JSON.parse(await readBody(req))

      const result = await matrix.sendMessage(
        roomId,
        body.body,
        body.html ? body.body : undefined,
      )

      json(result)
    })
  }

  // POST /matrix/rooms/:id/send-file
  const sendFileMatch = path.match(/^\/matrix\/rooms\/([^/]+)\/send-file$/)
  if (sendFileMatch && req.method === 'POST') {
    return handleAsync(async () => {
      const roomId = decodeURIComponent(sendFileMatch[1]!)
      const body = JSON.parse(await readBody(req))

      // Upload the file
      const fileData = Buffer.from(body.content, 'base64')
      const contentType = body.mimeType || 'application/octet-stream'
      const upload = await matrix.uploadMedia(fileData, contentType, body.filename)

      // Send as m.image or m.file based on content type
      const msgtype = contentType.startsWith('image/') ? 'm.image' : 'm.file'

      const content: Record<string, unknown> = {
        msgtype,
        body: body.caption || body.filename,
        filename: body.filename,
        url: upload.content_uri,
        info: { mimetype: contentType, size: fileData.length },
      }

      const result = await matrix.sendRoomEvent(roomId, 'm.room.message', content)
      json(result)
    })
  }

  // POST /matrix/rooms/:id/react
  const reactMatch = path.match(/^\/matrix\/rooms\/([^/]+)\/react$/)
  if (reactMatch && req.method === 'POST') {
    return handleAsync(async () => {
      const roomId = decodeURIComponent(reactMatch[1]!)
      const body = JSON.parse(await readBody(req))
      const result = await matrix.sendReaction(roomId, body.eventId, body.emoji)
      json(result)
    })
  }

  // POST /matrix/rooms/:id/read
  const readMatch = path.match(/^\/matrix\/rooms\/([^/]+)\/read$/)
  if (readMatch && req.method === 'POST') {
    return handleAsync(async () => {
      const roomId = decodeURIComponent(readMatch[1]!)

      // Get the latest event to mark as read
      const messages = await matrix.getRoomMessages(roomId, { limit: 1 })
      const latestEvent = (messages as any).chunk?.[0]

      if (latestEvent?.event_id) {
        await matrix.setReadMarker(roomId, latestEvent.event_id)
        await matrix.sendReadReceipt(roomId, latestEvent.event_id)
      }

      json({ ok: true })
    })
  }

  // POST /matrix/rooms/:id/unread (client-side state only — no Matrix API for this)
  const unreadMatch = path.match(/^\/matrix\/rooms\/([^/]+)\/unread$/)
  if (unreadMatch && req.method === 'POST') {
    json({ ok: true, note: 'Unread state is client-managed' })
    return true
  }

  // POST /matrix/rooms/:id/snooze (client-side state only)
  const snoozeMatch = path.match(/^\/matrix\/rooms\/([^/]+)\/snooze$/)
  if (snoozeMatch && req.method === 'POST') {
    json({ ok: true, note: 'Snooze state is client-managed' })
    return true
  }

  // GET /matrix/rooms/:id/info
  const infoMatch = path.match(/^\/matrix\/rooms\/([^/]+)\/info$/)
  if (infoMatch && req.method === 'GET') {
    return handleAsync(async () => {
      const roomId = decodeURIComponent(infoMatch[1]!)
      const state = await matrix.getRoomState(roomId)

      let name = roomId
      let topic = ''
      let isEncrypted = false
      let memberCount = 0
      const members: Array<{ userId: string; displayName: string }> = []

      for (const event of state as any[]) {
        if (event.type === 'm.room.name') name = event.content.name
        if (event.type === 'm.room.topic') topic = event.content.topic
        if (event.type === 'm.room.encryption') isEncrypted = true
        if (event.type === 'm.room.member' && event.content.membership === 'join') {
          memberCount++
          members.push({ userId: event.state_key, displayName: event.content.displayname || event.state_key })
        }
      }

      json({ id: roomId, name, topic, isEncrypted, memberCount, members })
    })
  }

  // GET /matrix/rooms/:id/state — raw CS-API state events (for the browser's
  // roomIsEncrypted / member-list checks on the send path).
  const stateMatch = path.match(/^\/matrix\/rooms\/([^/]+)\/state$/)
  if (stateMatch && req.method === 'GET') {
    return handleAsync(async () => {
      const roomId = decodeURIComponent(stateMatch[1]!)
      const state = await matrix.getRoomState(roomId)
      json(state)
    })
  }

  // GET /matrix/rooms/:id/event/:eventId — single event lookup (backfill).
  const eventMatch = path.match(/^\/matrix\/rooms\/([^/]+)\/event\/([^/]+)$/)
  if (eventMatch && req.method === 'GET') {
    return handleAsync(async () => {
      const roomId = decodeURIComponent(eventMatch[1]!)
      const eventId = decodeURIComponent(eventMatch[2]!)
      const event = await matrix.getEvent(roomId, eventId)
      json(event)
    })
  }

  // GET /matrix/url-preview?url=... — proxy /_matrix/media/v3/preview_url.
  if (path === '/matrix/url-preview' && req.method === 'GET') {
    return handleAsync(async () => {
      const previewUrl = url.searchParams.get('url')
      if (!previewUrl) return error(400, 'url param required')
      try {
        const data = await matrix.urlPreview(previewUrl)
        json(data)
      } catch (e) {
        const err = e as { status?: number; message: string }
        if (err.status === 404) return json({}) // server doesn't support preview_url
        throw e
      }
    })
  }

  // POST /matrix/media/upload?filename=... — binary body → mxc://
  if (path === '/matrix/media/upload' && req.method === 'POST') {
    return handleAsync(async () => {
      const filename = url.searchParams.get('filename') ?? undefined
      const contentType = (req.headers['content-type'] as string | undefined) ?? 'application/octet-stream'
      // Collect the raw request body as a Buffer (avoid readBody — that assumes text)
      const chunks: Buffer[] = []
      await new Promise<void>((resolve, reject) => {
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () => resolve())
        req.on('error', reject)
      })
      const buf = Buffer.concat(chunks)
      const result = await matrix.uploadMedia(buf, contentType, filename)
      json(result)
    })
  }

  // GET /matrix/media/download/:server/:mediaId — stream through the homeserver.
  const dlMatch = path.match(/^\/matrix\/media\/download\/([^/]+)\/([^/?]+)$/)
  if (dlMatch && req.method === 'GET') {
    return handleAsync(async () => {
      const server = decodeURIComponent(dlMatch[1]!)
      const mediaId = decodeURIComponent(dlMatch[2]!)
      const resp = await matrix.mediaFetch(`/_matrix/media/v3/download/${encodeURIComponent(server)}/${encodeURIComponent(mediaId)}`)
      if (!resp.ok) return error(resp.status, `media download failed: ${resp.status}`)
      const headers: Record<string, string> = {}
      const ct = resp.headers.get('content-type')
      if (ct) headers['Content-Type'] = ct
      const cd = resp.headers.get('content-disposition')
      if (cd) headers['Content-Disposition'] = cd
      const cl = resp.headers.get('content-length')
      if (cl) headers['Content-Length'] = cl
      headers['Cache-Control'] = 'private, max-age=3600'
      res.writeHead(200, headers)
      const buf = Buffer.from(await resp.arrayBuffer())
      res.end(buf)
    })
  }

  // GET /matrix/media/thumbnail/:server/:mediaId?width=&height=&method=
  const thumbMatch = path.match(/^\/matrix\/media\/thumbnail\/([^/]+)\/([^/?]+)$/)
  if (thumbMatch && req.method === 'GET') {
    return handleAsync(async () => {
      const server = decodeURIComponent(thumbMatch[1]!)
      const mediaId = decodeURIComponent(thumbMatch[2]!)
      const w = url.searchParams.get('width') ?? '48'
      const h = url.searchParams.get('height') ?? '48'
      const method = url.searchParams.get('method') ?? 'crop'
      const resp = await matrix.mediaFetch(
        `/_matrix/media/v3/thumbnail/${encodeURIComponent(server)}/${encodeURIComponent(mediaId)}?width=${w}&height=${h}&method=${method}`,
      )
      if (!resp.ok) return error(resp.status, `thumbnail failed: ${resp.status}`)
      const headers: Record<string, string> = {}
      const ct = resp.headers.get('content-type')
      if (ct) headers['Content-Type'] = ct
      headers['Cache-Control'] = 'private, max-age=86400'
      res.writeHead(200, headers)
      const buf = Buffer.from(await resp.arrayBuffer())
      res.end(buf)
    })
  }

  // GET /matrix/whoami
  if (path === '/matrix/whoami' && req.method === 'GET') {
    return handleAsync(async () => {
      const data = await matrix.whoami()
      json(data)
    })
  }

  // POST /matrix/undo (client-side state only)
  if (path === '/matrix/undo' && req.method === 'POST') {
    json({ ok: false, message: 'Undo is managed by the client' })
    return true
  }

  // --- M0 safety-net key backup ---------------------------------------------
  // Browser POSTs its OlmMachine room-key export here periodically so the hub
  // always has a copy needed to decrypt historical encrypted messages.

  // POST /matrix/keys/backup-blob   body: { userId, deviceId, keys (JSON str) }
  if (path === '/matrix/keys/backup-blob' && req.method === 'POST') {
    return handleAsync(async () => {
      const body = JSON.parse(await readBody(req)) as Partial<KeyBackupBlob>
      if (!body.userId || !body.deviceId || typeof body.keys !== 'string') {
        return error(400, 'userId, deviceId, keys are required')
      }
      // Validate + compute keyCount
      let keyCount = 0
      try {
        const parsed = JSON.parse(body.keys)
        if (!Array.isArray(parsed)) throw new Error('keys must be a JSON array')
        keyCount = parsed.length
      } catch (e) {
        return error(400, `invalid keys JSON: ${(e as Error).message}`)
      }
      keyBackup.save({
        userId: body.userId,
        deviceId: body.deviceId,
        exportedAt: Date.now(),
        keyCount,
        keys: body.keys,
      })
      json({ ok: true, keyCount })
    })
  }

  // GET /matrix/keys/backup-status
  if (path === '/matrix/keys/backup-status' && req.method === 'GET') {
    json(keyBackup.status())
    return true
  }

  // POST /matrix/decrypt-event — retry decryption of a previously-undecryptable
  // event using the hub's current OlmMachine state. Used after a key import
  // (local backup / recovery-key restore) to resurrect "🔒 Encrypted message"
  // placeholders in the browser's IDB.
  if (path === '/matrix/decrypt-event' && req.method === 'POST') {
    return handleAsync(async () => {
      const body = JSON.parse(await readBody(req)) as { roomId?: string; event?: unknown; eventId?: string }
      if (!body.roomId) return error(400, 'roomId required')
      let ev: any = body.event
      if (!ev && body.eventId) {
        ev = await matrix.getEvent(body.roomId, body.eventId)
      }
      if (!ev) return error(400, 'event or eventId required')
      const dec = await hubCrypto.decryptRoomEvent(ev, body.roomId)
      if (!dec) return error(422, 'still undecryptable (key still missing or wrong session)')
      json({ ok: true, type: dec.type, content: dec.content })
    })
  }

  // POST /matrix/keys/restore-from-recovery-key
  // Decodes an `EsU…`-style recovery key, fetches the matching server-side
  // key backup (/room_keys/keys), decrypts every Megolm session, and imports
  // them into the hub OlmMachine. The recovery key is not persisted.
  if (path === '/matrix/keys/restore-from-recovery-key' && req.method === 'POST') {
    return handleAsync(async () => {
      const cfg = authStore.getMatrixConfig()
      if (!cfg) return error(400, 'matrix not configured')
      const body = JSON.parse(await readBody(req)) as { recoveryKey?: string }
      if (!body.recoveryKey) return error(400, 'recoveryKey required')
      const result = await restoreFromRecoveryKey({
        homeserver: cfg.homeserver,
        accessToken: cfg.accessToken,
        userId: cfg.userId,
        recoveryKey: body.recoveryKey,
        hubCrypto,
        log: (m) => console.log(m),
      })
      json({ ok: true, ...result })
    })
  }

  // POST /matrix/keys/restore-cross-signing
  // Decrypts the three cross-signing private keys (MSK/SSK/USK) from
  // SSSS-encrypted secrets in account_data using the user-supplied recovery
  // key, imports them into the hub OlmMachine, and signs this hub device with
  // the SSK. Required after hub migration — Beeper bridges reject Olm traffic
  // from uncross-signed devices (CLAUDE.md Known Issues).
  if (path === '/matrix/keys/restore-cross-signing' && req.method === 'POST') {
    return handleAsync(async () => {
      const cfg = authStore.getMatrixConfig()
      if (!cfg) return error(400, 'matrix not configured')
      const body = JSON.parse(await readBody(req)) as { recoveryKey?: string }
      if (!body.recoveryKey) return error(400, 'recoveryKey required')
      const result = await restoreCrossSigningFromRecoveryKey({
        homeserver: cfg.homeserver,
        accessToken: cfg.accessToken,
        userId: cfg.userId,
        recoveryKey: body.recoveryKey,
        hubCrypto,
        log: (m) => console.log(m),
      })
      json({ ok: true, ...result })
    })
  }

  // POST /matrix/keys/import-local-backup
  // Force-imports the on-disk M0 key backup into the hub's current OlmMachine.
  // Used when the hub was initialized with an existing snapshot but the legacy
  // browser-exported keys never got merged in (common after the hub-centric
  // migration — see CLAUDE.md Known Issues).
  if (path === '/matrix/keys/import-local-backup' && req.method === 'POST') {
    return handleAsync(async () => {
      const backup = keyBackup.get()
      if (!backup) return error(404, 'no local key backup on disk')
      const cfg = authStore.getMatrixConfig()
      if (!cfg) return error(400, 'matrix not configured')
      if (backup.userId !== cfg.userId) {
        return error(400, `backup is for ${backup.userId} but hub is logged in as ${cfg.userId}`)
      }
      const r = await hubCrypto.importRoomKeys(backup.keys)
      json({ ok: true, imported: r.imported, total: r.total, backupDevice: backup.deviceId, hubDevice: cfg.deviceId })
    })
  }

  // --- M1 hub-as-Matrix-client ---------------------------------------------

  // POST /matrix/hub/login   body: { homeserver, userId, password }
  // Logs the hub in as a new device, initializes OlmMachine, imports M0 blob.
  if (path === '/matrix/hub/login' && req.method === 'POST') {
    return handleAsync(async () => {
      const body = JSON.parse(await readBody(req)) as {
        homeserver?: string
        userId?: string
        password?: string
      }
      if (!body.homeserver || !body.userId || !body.password) {
        return error(400, 'homeserver, userId, password required')
      }
      // 1. Login → new device_id + access_token
      const login = await matrixPasswordLogin(body.homeserver, body.userId, body.password)

      // 2. Initialize hub OlmMachine with the new device_id
      await hubCrypto.init(login.userId, login.deviceId)

      // 3. Persist credentials in auth.json
      authStore.setMatrixConfig({
        homeserver: login.homeserver,
        userId: login.userId,
        deviceId: login.deviceId,
        accessToken: login.accessToken,
      })

      // 4. Import the M0 safety-net room keys (if we have them for this user)
      const backup = keyBackup.get()
      let imported = 0
      let total = 0
      if (backup && backup.userId === login.userId) {
        const r = await hubCrypto.importRoomKeys(backup.keys)
        imported = r.imported
        total = r.total
      }

      // 5. Kick the sync loop so it picks up the new credentials immediately
      matrixSync.start()

      const identity = hubCrypto.identity()
      json({
        ok: true,
        userId: login.userId,
        deviceId: login.deviceId,
        identity,
        importedRoomKeys: imported,
        totalRoomKeysInBackup: total,
      })
    })
  }

  // POST /matrix/hub/logout
  // Invalidates the homeserver session, tears down OlmMachine + sync loop,
  // clears credentials from auth.json. Browser calls this instead of hitting
  // the homeserver directly.
  if (path === '/matrix/hub/logout' && req.method === 'POST') {
    return handleAsync(async () => {
      const cfg = authStore.getMatrixConfig()
      if (cfg) {
        // 1. Best-effort homeserver logout
        try {
          await fetch(`${cfg.homeserver}/_matrix/client/v3/logout`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${cfg.accessToken}`,
              'Content-Type': 'application/json',
            },
          })
        } catch {
          // ignore — we're clearing local state anyway
        }
      }
      // 2. Stop sync loop and crypto
      matrixSync.stop()
      await hubCrypto.stop()
      // 3. Clear credentials
      authStore.clearMatrixConfig()
      json({ ok: true })
    })
  }

  // POST /matrix/hub/decrypt-test   body: { roomId, limit? }
  // Verifies M1 by fetching recent encrypted events as the hub device and
  // attempting decryption. Returns per-event success flags + a sample plaintext.
  if (path === '/matrix/hub/decrypt-test' && req.method === 'POST') {
    return handleAsync(async () => {
      if (!hubCrypto.isReady()) return error(409, 'hub crypto not initialized — run /matrix/hub/login first')
      const body = JSON.parse(await readBody(req)) as { roomId?: string; limit?: number }
      if (!body.roomId) return error(400, 'roomId required')
      const limit = Math.min(Math.max(body.limit ?? 20, 1), 100)

      const msgs = await matrix.getRoomMessages(body.roomId, { limit, dir: 'b' }) as {
        chunk: Array<{ event_id: string; type: string; sender: string; origin_server_ts: number; content: Record<string, unknown> }>
      }
      const encrypted = msgs.chunk.filter((e) => e.type === 'm.room.encrypted')
      const results: Array<{ event_id: string; sender: string; success: boolean; type?: string; bodyPreview?: string }> = []
      let decryptedCount = 0
      for (const ev of encrypted) {
        const decrypted = await hubCrypto.decryptRoomEvent(
          { type: ev.type, content: ev.content, event_id: ev.event_id, sender: ev.sender, origin_server_ts: ev.origin_server_ts, room_id: body.roomId },
          body.roomId,
        )
        if (decrypted) {
          decryptedCount++
          const bodyStr = typeof (decrypted.content as { body?: unknown }).body === 'string'
            ? ((decrypted.content as { body: string }).body).slice(0, 80)
            : undefined
          results.push({ event_id: ev.event_id, sender: ev.sender, success: true, type: decrypted.type, bodyPreview: bodyStr })
        } else {
          results.push({ event_id: ev.event_id, sender: ev.sender, success: false })
        }
      }
      json({
        roomId: body.roomId,
        fetched: msgs.chunk.length,
        encrypted: encrypted.length,
        decrypted: decryptedCount,
        results,
      })
    })
  }

  // POST /matrix/hub/rooms/:id/send   body: { body, html?, dryRun? }
  // Encrypts via OlmMachine and sends as m.room.encrypted. For M1-verify.
  const hubSendMatch = path.match(/^\/matrix\/hub\/rooms\/([^/]+)\/send$/)
  if (hubSendMatch && req.method === 'POST') {
    return handleAsync(async () => {
      if (!hubCrypto.isReady()) return error(409, 'hub crypto not initialized — run /matrix/hub/login first')
      const matrixAuth = authStore.getMatrixConfig()
      if (!matrixAuth) return error(409, 'no matrix credentials in auth store')

      const roomId = decodeURIComponent(hubSendMatch[1]!)
      const body = JSON.parse(await readBody(req)) as {
        body?: string
        html?: string
        dryRun?: boolean
        expectRoomName?: string
      }
      if (!body.body) return error(400, 'body (message text) required')

      // Safety: fetch room state, enforce authorized target by room name
      const state = await matrix.getRoomState(roomId) as Array<{ type: string; content: any }>
      let roomName = roomId
      let isEncrypted = false
      const members: string[] = []
      for (const ev of state) {
        if (ev.type === 'm.room.name' && ev.content?.name) roomName = ev.content.name as string
        if (ev.type === 'm.room.encryption') isEncrypted = true
        if (ev.type === 'm.room.member' && ev.content?.membership === 'join') {
          members.push((ev as any).state_key)
        }
      }
      if (body.expectRoomName && roomName !== body.expectRoomName) {
        return error(412, `room name mismatch: expected "${body.expectRoomName}", got "${roomName}"`)
      }
      if (!isEncrypted) return error(400, `room ${roomName} is not encrypted`)

      if (body.dryRun) {
        json({ ok: true, dryRun: true, roomId, roomName, memberCount: members.length, members })
        return
      }

      // 1. Share the Megolm session with all joined members
      await hubCrypto.shareRoomKeys(roomId, members, matrixAuth.homeserver, matrixAuth.accessToken)

      // 2. Encrypt the content
      const content: Record<string, unknown> = { msgtype: 'm.text', body: body.body }
      if (body.html) {
        content.format = 'org.matrix.custom.html'
        content.formatted_body = body.html
      }
      const encrypted = await hubCrypto.encryptRoomEventForSend(roomId, 'm.room.message', content)
      if (!encrypted) return error(500, 'encryption failed (see hub logs)')

      // 3. Send as m.room.encrypted
      const txnId = `hub${Date.now()}.${Math.random().toString(36).slice(2)}`
      const url = `${matrixAuth.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.encrypted/${txnId}`
      const sendRes = await fetch(url, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${matrixAuth.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(encrypted),
      })
      const respText = await sendRes.text()
      if (!sendRes.ok) return error(sendRes.status, `send failed: ${respText}`)
      const parsed = JSON.parse(respText) as { event_id: string }
      json({ ok: true, roomId, roomName, memberCount: members.length, event_id: parsed.event_id })
    })
  }

  // PUT|DELETE /matrix/rooms/:id/tags/:tag — toggle a user-scoped room tag
  // (e.g. `m.favourite`, `m.lowpriority`). Used by the chat-room context menu
  // to pin / demote rooms; updates flow back via sync's account_data.
  const tagMatch = path.match(/^\/matrix\/rooms\/([^/]+)\/tags\/([^/]+)$/)
  if (tagMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
    return handleAsync(async () => {
      const roomId = decodeURIComponent(tagMatch[1]!)
      const tag = decodeURIComponent(tagMatch[2]!)
      if (req.method === 'DELETE') {
        await matrix.deleteRoomTag(roomId, tag)
      } else {
        const raw = await readBody(req)
        const body = raw ? (JSON.parse(raw) as { order?: number }) : {}
        await matrix.setRoomTag(roomId, tag, body.order)
      }
      json({ ok: true })
    })
  }

  // PUT|DELETE /matrix/rooms/:id/mute — toggle a `room`-kind push rule with
  // `dont_notify`. Matches the rule shape Beeper's bridges use for WhatsApp /
  // Signal mute propagation, so writes round-trip cleanly.
  const muteMatch = path.match(/^\/matrix\/rooms\/([^/]+)\/mute$/)
  if (muteMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
    return handleAsync(async () => {
      const roomId = decodeURIComponent(muteMatch[1]!)
      if (req.method === 'DELETE') {
        await matrix.unsetRoomMuted(roomId)
      } else {
        await matrix.setRoomMuted(roomId)
      }
      // Nudge sync so the updated push_rules event flows through quickly
      // instead of waiting for the next long-poll to land.
      void matrixSync.syncNow().catch(() => {})
      json({ ok: true })
    })
  }

  // GET /matrix/hub/status
  if (path === '/matrix/hub/status' && req.method === 'GET') {
    const identity = hubCrypto.identity()
    const matrixAuth = authStore.getMatrixConfig()
    json({
      cryptoReady: hubCrypto.isReady(),
      identity,
      hasCredentials: !!matrixAuth,
      userId: matrixAuth?.userId,
      deviceId: matrixAuth?.deviceId,
      homeserver: matrixAuth?.homeserver,
    })
    return true
  }

  return false
}
