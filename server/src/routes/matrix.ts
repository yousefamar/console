// Matrix routes — room list, messages, send, reactions, read receipts
// For now, these proxy directly to the homeserver via MatrixClient.
// In the future, the hub will run a background sync loop for E2E crypto.

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { MatrixClient } from '../matrix-client.js'

export function handleMatrixRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
  matrix: MatrixClient,
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

      // Do a sync with timeout=0 to get current room state
      const syncData = await matrix.sync({ timeout: 0 })
      const rooms: Array<Record<string, unknown>> = []

      const joinedRooms = syncData.rooms?.join || {}
      for (const [roomId, room] of Object.entries(joinedRooms)) {
        const stateEvents = [...(room as any).state.events, ...(room as any).timeline.events.filter((e: any) => e.state_key !== undefined)]

        // Extract room name
        let name = roomId
        for (const e of stateEvents) {
          if (e.type === 'm.room.name' && e.content.name) name = e.content.name as string
        }

        const unread = (room as any).unread_notifications?.notification_count || 0
        const memberCount = (room as any).summary?.['m.joined_member_count'] || 0

        // Apply filter
        if (filter === 'unread' && unread === 0) continue

        rooms.push({
          id: roomId,
          name,
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

      // Convert to simpler format
      const messages = (data as any).chunk
        .filter((e: any) => e.type === 'm.room.message' || e.type === 'm.room.encrypted')
        .map((e: any) => ({
          id: e.event_id,
          sender: e.sender,
          timestamp: e.origin_server_ts,
          type: e.type,
          content: e.content,
          // Note: encrypted messages won't be decrypted here yet
          // Full E2E support requires the hub's OlmMachine (Phase 4 future)
        }))

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

  return false
}
