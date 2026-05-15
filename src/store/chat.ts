import { create } from 'zustand'
import { db } from '@/db'
import { enqueue } from '@/db/sync-queue'
import type { DbChatRoom, DbChatMessage } from '@/matrix/types'
import type { MatrixRoomEvent } from '@/matrix/types'
import { useUiStore } from './ui'
import { getSnoozeTime } from '@/utils/date'
import * as matrixApi from '@/matrix/api'
import { buildMessageFromContent } from '@/matrix/sync'
import { notify } from '@/notifications'

const INITIAL_PAGE_SIZE = 20
const OLDER_PAGE_SIZE = 30

// Build a DbChatMessage from event + content, with sender info overlay.
// Delegates to the shared buildMessageFromContent (single source of truth for msgtype handling).
function buildChatMessage(
  event: MatrixRoomEvent,
  roomId: string,
  content: Record<string, unknown>,
  senderName: string,
  senderAvatar?: string,
): DbChatMessage | null {
  const msg = buildMessageFromContent(event, roomId, content)
  if (!msg) return null
  msg.senderName = senderName
  msg.senderAvatar = senderAvatar
  return msg
}

// Shared: convert Matrix room events to DbChatMessages (with decryption)
// Also processes reactions, redactions, and edits from paginated results
async function eventsToMessages(
  events: MatrixRoomEvent[],
  roomId: string,
  memberInfo?: Map<string, { name: string; avatar?: string }>,
): Promise<DbChatMessage[]> {
  const messages: DbChatMessage[] = []
  // Deferred events: reactions/redactions/edits that reference other messages.
  // Processed in a second pass so that targets from the same batch (especially
  // in backward pagination where reactions appear before their targets) can be found.
  const deferred: MatrixRoomEvent[] = []

  // --- Pass 1: Build messages + decrypt, collect deferred events ---
  for (const event of events) {
    const info = memberInfo?.get(event.sender)
    const senderName = info?.name || event.sender.split(':')[0]?.slice(1) || event.sender
    const senderAvatar = info?.avatar

    // Hub delivers already-decrypted events. m.room.encrypted here means
    // either (a) the hub couldn't decrypt it (missing Megolm session) — render
    // a placeholder; or (b) it's a redaction tombstone (WhatsApp / Signal
    // delete), which Matrix strips to `content: {}` with `unsigned.redacted_because`
    // — render as a deleted message instead of a lock-emoji placeholder.
    if (event.type === 'm.room.encrypted') {
      const isTombstone = typeof event.content?.ciphertext !== 'string'
      if (isTombstone) {
        const redaction = (event.unsigned as Record<string, unknown> | undefined)
          ?.redacted_because as { sender?: string } | undefined
        messages.push({
          id: event.event_id,
          roomId,
          senderId: event.sender,
          senderName,
          senderAvatar,
          body: '',
          timestamp: event.origin_server_ts,
          type: 'text',
          isEdited: false,
          isDeleted: true,
          deletedBy: redaction?.sender ?? event.sender ?? undefined,
        })
        continue
      }
      messages.push({
        id: event.event_id,
        roomId,
        senderId: event.sender,
        senderName,
        senderAvatar,
        body: '\u{1F512} Encrypted message',
        timestamp: event.origin_server_ts,
        type: 'text',
        isEdited: false,
        encryptedEvent: JSON.stringify(event),
      })
      continue
    }

    // Messages and stickers → chat bubbles
    if (event.type === 'm.room.message') {
      // Check if this is an edit (has m.replace relation) — defer to pass 2
      const relates = event.content['m.relates_to'] as Record<string, unknown> | undefined
      if (relates?.rel_type === 'm.replace' && relates.event_id) {
        deferred.push(event)
      } else {
        const msg = buildChatMessage(event, roomId, event.content, senderName, senderAvatar)
        if (msg) messages.push(msg)
      }
    } else if (event.type === 'm.sticker') {
      const msg = buildChatMessage(event, roomId, { ...event.content, msgtype: 'm.image' }, senderName, senderAvatar)
      if (msg) messages.push(msg)
    } else if (event.type === 'm.reaction' || event.type === 'm.room.redaction') {
      deferred.push(event)
    }
  }

  // --- Pass 2: Process reactions, redactions, edits (targets now findable in messages array) ---
  for (const event of deferred) {
    // Reactions → update target message
    if (event.type === 'm.reaction') {
      const relates = event.content['m.relates_to'] as Record<string, unknown> | undefined
      if (relates?.rel_type === 'm.annotation' && relates.event_id && relates.key) {
        const targetId = relates.event_id as string
        const emoji = relates.key as string
        const sender = event.sender ?? ''
        // Check in-flight messages first (same batch, not yet persisted), then DB
        const inFlight = messages.find((m) => m.id === targetId)
        const target = inFlight ?? await db.chatMessages.get(targetId)
        if (target) {
          const reactions = target.reactions ?? {}
          const senders = reactions[emoji] ?? []
          if (!senders.includes(sender)) {
            reactions[emoji] = [...senders, sender]
            if (inFlight) {
              inFlight.reactions = reactions
            } else {
              await db.chatMessages.update(targetId, { reactions })
            }
          }
        }
      }
    }

    // Redactions → mark as deleted (keep message for diff view)
    if (event.type === 'm.room.redaction') {
      const targetId = (event.content.redacts as string) || (event as unknown as Record<string, unknown>).redacts as string
      if (targetId) {
        await db.chatMessages.update(targetId, {
          isDeleted: true,
          deletedBy: event.sender ?? undefined,
        })
      }
    }

    // Edits → store original body, update to new body
    if (event.type === 'm.room.message') {
      const relates = event.content['m.relates_to'] as Record<string, unknown> | undefined
      if (relates?.rel_type === 'm.replace' && relates.event_id) {
        const targetId = relates.event_id as string
        const newContent = event.content['m.new_content'] as Record<string, unknown> | undefined
        if (newContent) {
          const inFlight = messages.find((m) => m.id === targetId)
          const target = inFlight ?? await db.chatMessages.get(targetId)
          if (inFlight) {
            inFlight.originalBody = inFlight.originalBody ?? inFlight.body
            inFlight.body = (newContent.body as string) ?? ''
            inFlight.formattedBody = newContent.formatted_body as string | undefined
            inFlight.isEdited = true
          } else {
            await db.chatMessages.update(targetId, {
              originalBody: target?.originalBody ?? target?.body,
              body: (newContent.body as string) ?? '',
              formattedBody: newContent.format === 'org.matrix.custom.html'
                ? (newContent.formatted_body as string)
                : undefined,
              isEdited: true,
            })
          }
        }
      }
    }
  }

  // Second pass: populate replyTo.body and replyTo.sender from batch or DB
  for (const msg of messages) {
    if (msg.replyTo && !msg.replyTo.body) {
      const batchTarget = messages.find((m) => m.id === msg.replyTo!.eventId)
      if (batchTarget) {
        msg.replyTo.body = batchTarget.body
        msg.replyTo.sender = batchTarget.senderName
      } else {
        const dbTarget = await db.chatMessages.get(msg.replyTo.eventId)
        if (dbTarget) {
          msg.replyTo.body = dbTarget.body
          msg.replyTo.sender = dbTarget.senderName
        }
      }
    }
  }

  return messages
}

// Backfill lastReadTs from lastReadEventId if missing
async function backfillLastReadTs(roomId: string) {
  const room = await db.chatRooms.get(roomId)
  if (!room || room.lastReadTs || !room.lastReadEventId) return
  const msg = await db.chatMessages.get(room.lastReadEventId)
  if (msg) {
    await db.chatRooms.update(roomId, { lastReadTs: msg.timestamp })
  }
}

// Cache room member info (fetched once per room per session)
const roomMemberCache = new Map<string, Map<string, { name: string; avatar?: string }>>()

async function getRoomMemberInfo(roomId: string): Promise<Map<string, { name: string; avatar?: string }>> {
  if (roomMemberCache.has(roomId)) return roomMemberCache.get(roomId)!
  const info = new Map<string, { name: string; avatar?: string }>()
  try {
    const stateEvents = await matrixApi.getRoomState(roomId)
    for (const event of stateEvents) {
      if (event.type === 'm.room.member' && event.state_key) {
        info.set(event.state_key, {
          name: (event.content.displayname as string) || event.state_key.split(':')[0]?.slice(1) || event.state_key,
          avatar: event.content.avatar_url as string | undefined,
        })
      }
    }
  } catch { /* non-critical */ }
  roomMemberCache.set(roomId, info)
  return info
}

// Fetch a page of messages via the hub (decrypted server-side) and store in DB.
async function fetchAndStoreMessages(
  roomId: string,
  opts: { from?: string; limit: number },
): Promise<{ messages: DbChatMessage[]; end?: string }> {
  const { hubBus } = await import('@/sync-bus')
  const response = await hubBus.rpc<{
    chunk: MatrixRoomEvent[]
    state?: MatrixRoomEvent[]
    start?: string
    end?: string
  }>('matrix', 'paginate', { roomId, from: opts.from, dir: 'b', limit: opts.limit })

  // Build member info: prefer /messages state, fall back to room state
  const memberInfo = new Map<string, { name: string; avatar?: string }>()
  for (const event of response.state ?? []) {
    if (event.type === 'm.room.member' && event.state_key) {
      memberInfo.set(event.state_key, {
        name: (event.content.displayname as string) || event.state_key.split(':')[0]?.slice(1) || event.state_key,
        avatar: event.content.avatar_url as string | undefined,
      })
    }
  }
  // If /messages didn't return member state, fetch room state (already cached via hub deltas)
  if (memberInfo.size === 0) {
    const roomInfo = await getRoomMemberInfo(roomId)
    for (const [k, v] of roomInfo) memberInfo.set(k, v)
  }

  // For DM rooms, use room name as fallback for unresolved bridge senders
  const room = await db.chatRooms.get(roomId)
  if (room?.isDirect && room.name) {
    const myUserId = localStorage.getItem('matrix_user_id') ?? ''
    for (const event of response.chunk) {
      if (event.sender && event.sender !== myUserId && !memberInfo.has(event.sender)) {
        memberInfo.set(event.sender, { name: room.name })
      }
    }
  }

  const messages = await eventsToMessages(response.chunk, roomId, memberInfo)
  if (messages.length > 0) {
    await db.chatMessages.bulkPut(messages)
  }

  return { messages, end: response.end }
}

interface ChatState {
  rooms: DbChatRoom[]
  selectedRoomId: string | null
  replyingTo: { eventId: string; body: string; senderName: string } | null
  // The message currently being edited. Compose input pre-fills with `body`
  // and submits an `m.replace` event referencing `eventId` instead of a new
  // message. Null when not in edit mode.
  editingMessage: { eventId: string; body: string; roomId: string } | null

  // Actions
  setRooms: (rooms: DbChatRoom[]) => void
  selectRoom: (roomId: string | null) => void
  selectNextRoom: () => void
  selectPrevRoom: () => void
  ensureMessages: (roomId: string) => Promise<void>
  loadOlderMessages: (roomId: string) => Promise<boolean>
  preloadAllRooms: () => Promise<void>

  // Triage (inbox-zero for chat)
  markRoomRead: (roomId?: string) => Promise<void>
  markRoomUnread: (roomId?: string) => Promise<void>
  snoozeRoom: (option: 'laterToday' | 'tomorrow' | 'nextWeek' | 'custom', customDate?: Date) => Promise<void>

  // Send
  sendMessage: (roomId: string, body: string, formattedBody?: string) => Promise<void>
  sendImage: (roomId: string, file: File, caption?: string) => Promise<void>
  sendFile: (roomId: string, file: File, caption?: string) => Promise<void>

  // Reply & React
  setReplyingTo: (msg: DbChatMessage | null) => void
  sendReaction: (roomId: string, eventId: string, emoji: string) => Promise<void>

  // Edit
  setEditingMessage: (msg: DbChatMessage | null) => void
  editMessage: (roomId: string, eventId: string, newBody: string) => Promise<void>

  // Undo
  undoMarkRead: (room: DbChatRoom) => Promise<void>
}

// Rooms removed optimistically (before DB confirms) — filtered from live query results
const optimisticallyRemoved = new Set<string>()

export const useChatStore = create<ChatState>((set, get) => ({
  rooms: [],
  selectedRoomId: null,
  replyingTo: null,
  editingMessage: null,

  setRooms: (rooms) => {
    const filtered = optimisticallyRemoved.size > 0
      ? rooms.filter((r) => !optimisticallyRemoved.has(r.id))
      : rooms
    set((s) => {
      // Keep the currently selected room in the list even if the live query dropped it
      // (e.g., user replied and room became read — it stays until they navigate away)
      if (s.selectedRoomId && !filtered.some((r) => r.id === s.selectedRoomId)) {
        const kept = s.rooms.find((r) => r.id === s.selectedRoomId)
        if (kept) {
          return { rooms: [...filtered, kept] }
        }
        // Selected room gone from both lists — clear selection
        if (filtered.length > 0) {
          return { rooms: filtered, selectedRoomId: null }
        }
      }
      return { rooms: filtered }
    })
  },

  selectRoom: async (roomId) => {
    // When switching away from a room, let read rooms drop from the list
    const prev = get().selectedRoomId
    set({ selectedRoomId: roomId })
    if (prev && prev !== roomId) {
      const prevRoom = get().rooms.find((r) => r.id === prev)
      if (prevRoom && !prevRoom.isUnread && !prevRoom.tags?.includes('m.favourite')) {
        set((s) => ({ rooms: s.rooms.filter((r) => r.id !== prev) }))
      }
    }
    if (roomId) {
      await get().ensureMessages(roomId)
    }
  },

  selectNextRoom: () => {
    const { rooms, selectedRoomId } = get()
    if (rooms.length === 0) return
    if (!selectedRoomId) {
      get().selectRoom(rooms[0]!.id)
      return
    }
    const idx = rooms.findIndex((r) => r.id === selectedRoomId)
    if (idx < rooms.length - 1) {
      get().selectRoom(rooms[idx + 1]!.id)
    }
  },

  selectPrevRoom: () => {
    const { rooms, selectedRoomId } = get()
    if (rooms.length === 0) return
    if (!selectedRoomId) {
      get().selectRoom(rooms[rooms.length - 1]!.id)
      return
    }
    const idx = rooms.findIndex((r) => r.id === selectedRoomId)
    if (idx > 0) {
      get().selectRoom(rooms[idx - 1]!.id)
    }
  },

  // Fetch messages from server if not cached locally (live query handles display)
  ensureMessages: async (roomId) => {
    const count = await db.chatMessages.where('roomId').equals(roomId).count()
    if (count > 0) return

    try {
      const result = await fetchAndStoreMessages(roomId, { limit: INITIAL_PAGE_SIZE })
      if (result.end) {
        await db.chatRooms.update(roomId, { prevBatch: result.end })
      }
      if (result.messages.length > 0) {
        const latest = result.messages.reduce((a, b) => a.timestamp > b.timestamp ? a : b)
        await db.chatRooms.update(roomId, {
          lastMessageBody: latest.body,
          lastMessageSender: latest.senderName,
          lastMessageTime: latest.timestamp,
        })
      }
      await backfillLastReadTs(roomId)
    } catch (err) {
      // Expected during preload — room may lack prev_batch or be inaccessible
    }
  },

  loadOlderMessages: async (roomId) => {
    const room = await db.chatRooms.get(roomId)
    if (!room?.prevBatch) return false

    try {
      const result = await fetchAndStoreMessages(roomId, {
        from: room.prevBatch,
        limit: OLDER_PAGE_SIZE,
      })
      await db.chatRooms.update(roomId, { prevBatch: result.end ?? undefined })
      return !!result.end && result.messages.length > 0
    } catch {
      return false
    }
  },

  markRoomRead: async (roomId) => {
    const id = roomId ?? get().selectedRoomId
    if (!id) return

    // Snapshot room for undo before mutating
    const room = get().rooms.find((r) => r.id === id)
    if (!room) return

    const isFavourite = room.tags?.includes('m.favourite') ?? false

    // Prevent live query from re-adding this room before DB confirms
    // (skip for favourites — they always stay visible in the pinned grid)
    if (!isFavourite) optimisticallyRemoved.add(id)

    // Optimistic: update Zustand synchronously (instant UI), then persist
    set((s) => {
      if (isFavourite) {
        // Favourites stay in list, just mark read
        return {
          rooms: s.rooms.map((r) => r.id === id ? { ...r, isUnread: false, unreadCount: 0 } : r),
        }
      }
      const newRooms = s.rooms.filter((r) => r.id !== id)
      const currentIdx = s.rooms.findIndex((r) => r.id === id)
      const nextRoom = s.selectedRoomId === id
        ? newRooms[Math.min(currentIdx, newRooms.length - 1)]
        : null
      return {
        rooms: newRooms,
        selectedRoomId: s.selectedRoomId === id ? (nextRoom?.id ?? null) : s.selectedRoomId,
      }
    })

    useUiStore.getState().setUndoAction({
      label: 'Marked read',
      expiresAt: Date.now() + 5000,
      undo: () => get().undoMarkRead(room),
    })

    // Persist + queue in background (DB write + network)
    db.chatRooms.update(id, { isUnread: false, unreadCount: 0 }).then(() => {
      optimisticallyRemoved.delete(id)
      return db.chatMessages
        .where('roomId')
        .equals(id)
        .reverse()
        .sortBy('timestamp')
        .then(async (msgs) => {
          const lastMsg = msgs[0]
          if (lastMsg) {
            await db.chatRooms.update(id, { lastReadEventId: lastMsg.id, lastReadTs: lastMsg.timestamp })
            await enqueue('chatMarkRead', { roomId: id, eventId: lastMsg.id }, { roomId: id })
          }
        })
    })
  },

  markRoomUnread: async (roomId) => {
    const id = roomId ?? get().selectedRoomId
    if (!id) return

    // Update DB
    await db.chatRooms.update(id, { isUnread: true, unreadCount: 1 })

    // Optimistic: add back to rooms list if not already there
    set((s) => {
      const existing = s.rooms.find((r) => r.id === id)
      if (existing) {
        return { rooms: s.rooms.map((r) => r.id === id ? { ...r, isUnread: true, unreadCount: 1 } : r) }
      }
      // Room not in list — fetch from DB
      return s
    })

    // If room wasn't in the list, the live query will pick it up from DB
  },

  snoozeRoom: async (option, customDate) => {
    const id = get().selectedRoomId
    if (!id) return

    const snoozedUntil = getSnoozeTime(option, customDate)

    // Update DB first so live query doesn't rubberband
    await db.chatRooms.update(id, { snoozedUntil })

    set((s) => {
      const newRooms = s.rooms.filter((r) => r.id !== id)
      const currentIdx = s.rooms.findIndex((r) => r.id === id)
      const nextRoom = newRooms[Math.min(currentIdx, newRooms.length - 1)]
      return {
        rooms: newRooms,
        selectedRoomId: nextRoom?.id ?? null,
      }
    })
    useUiStore.getState().setShowSnoozePicker(false)
  },

  sendMessage: async (roomId, body, formattedBody) => {
    const { replyingTo } = get()
    const localId = `~${Date.now()}.${Math.random().toString(36).slice(2)}`
    const userId = localStorage.getItem('matrix_user_id') ?? ''

    const localMsg: DbChatMessage = {
      id: localId,
      roomId,
      senderId: userId,
      senderName: userId.split(':')[0]?.slice(1) ?? 'You',
      body,
      formattedBody,
      timestamp: Date.now(),
      type: 'text',
      isEdited: false,
    }

    // Add replyTo to local message if replying
    if (replyingTo) {
      localMsg.replyTo = { eventId: replyingTo.eventId, body: replyingTo.body, sender: replyingTo.senderName }
    }

    // Clear reply state
    set({ replyingTo: null })

    // Mark room read in Zustand (keep in list — it'll drop when user navigates away)
    set((s) => ({
      rooms: s.rooms.map((r) =>
        r.id === roomId ? { ...r, isUnread: false, unreadCount: 0 } : r,
      ),
    }))

    await db.chatMessages.put(localMsg)
    await db.chatRooms.update(roomId, {
      lastMessageBody: body,
      lastMessageSender: localMsg.senderName,
      lastMessageTime: localMsg.timestamp,
      isUnread: false,
      unreadCount: 0,
      lastReadEventId: localId,
      lastReadTs: localMsg.timestamp,
    })
    await enqueue('chatSend', { roomId, body, formattedBody, replyToEventId: replyingTo?.eventId }, { roomId })
    // Send read receipt for the latest real message
    const msgs = await db.chatMessages
      .where('roomId').equals(roomId)
      .reverse().sortBy('timestamp')
    const lastReal = msgs.find((m) => !m.id.startsWith('~'))
    if (lastReal) {
      await enqueue('chatMarkRead', { roomId, eventId: lastReal.id }, { roomId })
    }
  },

  sendImage: async (roomId, file, caption) => {
    const { replyingTo } = get()
    const localId = `~${Date.now()}.${Math.random().toString(36).slice(2)}`
    const userId = localStorage.getItem('matrix_user_id') ?? ''
    const blobUrl = URL.createObjectURL(file)

    // Get image dimensions
    const dims = await new Promise<{ w: number; h: number }>((resolve) => {
      const img = new Image()
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight })
      img.onerror = () => resolve({ w: 0, h: 0 })
      img.src = blobUrl
    })

    // body = caption if provided, otherwise filename. filename always set for bridges.
    const bodyText = caption || file.name

    const localMsg: DbChatMessage = {
      id: localId,
      roomId,
      senderId: userId,
      senderName: userId.split(':')[0]?.slice(1) ?? 'You',
      body: bodyText,
      timestamp: Date.now(),
      type: 'image',
      mediaUrl: blobUrl,
      isEdited: false,
    }

    if (replyingTo) {
      localMsg.replyTo = { eventId: replyingTo.eventId, body: replyingTo.body, sender: replyingTo.senderName }
    }
    set({ replyingTo: null })

    // Mark room read + local echo
    set((s) => ({
      rooms: s.rooms.map((r) =>
        r.id === roomId ? { ...r, isUnread: false, unreadCount: 0 } : r,
      ),
    }))
    await db.chatMessages.put(localMsg)
    await db.chatRooms.update(roomId, {
      lastMessageBody: caption ? `📷 ${caption}` : `📷 ${file.name}`,
      lastMessageSender: localMsg.senderName,
      lastMessageTime: localMsg.timestamp,
      isUnread: false,
      unreadCount: 0,
      lastReadEventId: localId,
      lastReadTs: localMsg.timestamp,
    })

    try {
      const data = await file.arrayBuffer()

      // Upload raw media (unencrypted). Beeper bridges can't decrypt encrypted
      // attachments, so media bytes stay plaintext — only the m.image event
      // metadata gets Megolm-encrypted (hub decides based on room state).
      const mxcUrl = await matrixApi.uploadMedia(data, file.type, file.name)
      const content: Record<string, unknown> = {
        msgtype: 'm.image',
        body: bodyText,
        filename: file.name,
        url: mxcUrl,
        info: { mimetype: file.type, size: file.size, w: dims.w, h: dims.h },
      }
      if (replyingTo) {
        content['m.relates_to'] = { 'm.in_reply_to': { event_id: replyingTo.eventId } }
      }

      const { hubBus } = await import('@/sync-bus')
      const sendResult = await hubBus.rpc<{ event_id?: string }>('matrix', 'sendEvent', {
        roomId, type: 'm.room.message', content,
      })

      // Immediately replace local echo with confirmed message (real event_id)
      const realEventId = sendResult?.event_id
      if (realEventId) {
        const echo = await db.chatMessages.get(localId)
        if (echo) {
          await db.chatMessages.delete(localId)
          await db.chatMessages.put({ ...echo, id: realEventId })
        }
      }

      // Send read receipt
      const msgs = await db.chatMessages
        .where('roomId').equals(roomId)
        .reverse().sortBy('timestamp')
      const lastReal = msgs.find((m) => !m.id.startsWith('~'))
      if (lastReal) {
        await enqueue('chatMarkRead', { roomId, eventId: lastReal.id }, { roomId })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      await db.chatMessages.update(localId, { sendFailed: message })
      const room = await db.chatRooms.get(roomId)
      notify({
        title: 'Message failed to send',
        body: room?.name ? `in ${room.name}: ${message}` : message,
        tag: `send-failed:${localId}`,
        data: { pane: 'chat', itemId: roomId },
      })
    }
  },

  // Generic file send — videos, audio, documents, anything not an image.
  // Mirrors sendImage's local-echo + raw-upload-then-Megolm-event flow so
  // bridges (which can't decrypt encrypted attachments) can still read the
  // file URL. The msgtype is chosen from the file's MIME so receivers render
  // the right widget (`m.video`, `m.audio`, `m.file`).
  sendFile: async (roomId, file, caption) => {
    const { replyingTo } = get()
    const localId = `~${Date.now()}.${Math.random().toString(36).slice(2)}`
    const userId = localStorage.getItem('matrix_user_id') ?? ''
    const blobUrl = URL.createObjectURL(file)

    const bodyText = caption || file.name
    let msgtype: 'm.video' | 'm.audio' | 'm.file' = 'm.file'
    let localType: DbChatMessage['type'] = 'file'
    if (file.type.startsWith('video/')) { msgtype = 'm.video'; localType = 'video' }
    else if (file.type.startsWith('audio/')) {
      // WhatsApp-bridge voice notes require Opus/MP3/M4A — sending WAV/AIFF/
      // FLAC as m.audio gets bounced with `com.beeper.unsupported_event`.
      // Demote those to m.file so the attachment still goes through (renders
      // as a downloadable file on the other end instead of an inline player).
      const VOICE_NOTE_OK = /^audio\/(ogg|mp4|mpeg|aac|m4a|webm)/i
      if (VOICE_NOTE_OK.test(file.type)) {
        msgtype = 'm.audio'
        localType = 'audio'
      }
    }

    const localMsg: DbChatMessage = {
      id: localId,
      roomId,
      senderId: userId,
      senderName: userId.split(':')[0]?.slice(1) ?? 'You',
      body: bodyText,
      timestamp: Date.now(),
      type: localType,
      mediaUrl: blobUrl,
      mediaMimeType: file.type || undefined,
      isEdited: false,
    }

    if (replyingTo) {
      localMsg.replyTo = { eventId: replyingTo.eventId, body: replyingTo.body, sender: replyingTo.senderName }
    }
    set({ replyingTo: null })

    set((s) => ({
      rooms: s.rooms.map((r) =>
        r.id === roomId ? { ...r, isUnread: false, unreadCount: 0 } : r,
      ),
    }))
    await db.chatMessages.put(localMsg)
    const previewIcon = msgtype === 'm.video' ? '🎬' : msgtype === 'm.audio' ? '🎵' : '📎'
    await db.chatRooms.update(roomId, {
      lastMessageBody: caption ? `${previewIcon} ${caption}` : `${previewIcon} ${file.name}`,
      lastMessageSender: localMsg.senderName,
      lastMessageTime: localMsg.timestamp,
      isUnread: false,
      unreadCount: 0,
      lastReadEventId: localId,
      lastReadTs: localMsg.timestamp,
    })

    try {
      const data = await file.arrayBuffer()
      const mxcUrl = await matrixApi.uploadMedia(data, file.type, file.name)
      const content: Record<string, unknown> = {
        msgtype,
        body: bodyText,
        filename: file.name,
        url: mxcUrl,
        info: { mimetype: file.type, size: file.size },
      }
      if (replyingTo) {
        content['m.relates_to'] = { 'm.in_reply_to': { event_id: replyingTo.eventId } }
      }

      const { hubBus } = await import('@/sync-bus')
      const sendResult = await hubBus.rpc<{ event_id?: string }>('matrix', 'sendEvent', {
        roomId, type: 'm.room.message', content,
      })

      const realEventId = sendResult?.event_id
      if (realEventId) {
        const echo = await db.chatMessages.get(localId)
        if (echo) {
          await db.chatMessages.delete(localId)
          await db.chatMessages.put({ ...echo, id: realEventId })
        }
      }

      const msgs = await db.chatMessages
        .where('roomId').equals(roomId)
        .reverse().sortBy('timestamp')
      const lastReal = msgs.find((m) => !m.id.startsWith('~'))
      if (lastReal) {
        await enqueue('chatMarkRead', { roomId, eventId: lastReal.id }, { roomId })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      await db.chatMessages.update(localId, { sendFailed: message })
      const room = await db.chatRooms.get(roomId)
      notify({
        title: 'Message failed to send',
        body: room?.name ? `in ${room.name}: ${message}` : message,
        tag: `send-failed:${localId}`,
        data: { pane: 'chat', itemId: roomId },
      })
    }
  },

  preloadAllRooms: async () => {
    const rooms = await db.chatRooms
      .filter((r) => r.isUnread && !r.snoozedUntil)
      .toArray()

    for (const room of rooms) {
      // Skip rooms that already have messages cached
      const count = await db.chatMessages.where('roomId').equals(room.id).count()
      if (count > 0) continue

      try {
        const result = await fetchAndStoreMessages(room.id, { limit: INITIAL_PAGE_SIZE })
        if (result.end) {
          await db.chatRooms.update(room.id, { prevBatch: result.end })
        }
        if (result.messages.length > 0) {
          const latest = result.messages.reduce((a, b) => a.timestamp > b.timestamp ? a : b)
          await db.chatRooms.update(room.id, {
            lastMessageBody: latest.body,
            lastMessageSender: latest.senderName,
            lastMessageTime: latest.timestamp,
          })
        }
        await backfillLastReadTs(room.id)
      } catch {
        // Non-critical — messages will load on room open
      }
    }
  },

  setReplyingTo: (msg) => {
    set({ replyingTo: msg ? { eventId: msg.id, body: msg.body, senderName: msg.senderName } : null })
  },

  setEditingMessage: (msg) => {
    set({
      editingMessage: msg
        ? { eventId: msg.id, body: msg.body, roomId: msg.roomId }
        : null,
    })
  },

  editMessage: async (roomId, eventId, newBody) => {
    const trimmed = newBody.trim()
    if (!trimmed) return
    // No-op if the body didn't actually change. Avoids an empty edit roundtrip
    // and the resulting "(edited)" marker on a message that's textually the
    // same as before.
    const existing = await db.chatMessages.get(eventId)
    if (existing && existing.body === trimmed) {
      set({ editingMessage: null })
      return
    }
    // Optimistic IDB update — the message bubble flips to edited body
    // immediately. Inbound m.replace processing is idempotent, so when the
    // homeserver echoes our edit back through sync nothing flickers.
    if (existing) {
      await db.chatMessages.update(eventId, {
        body: trimmed,
        isEdited: true,
        originalBody: existing.originalBody ?? existing.body,
      })
      // If this was the room's last message, refresh the preview too.
      const room = await db.chatRooms.get(roomId)
      if (room?.lastReadEventId === eventId || room?.lastMessageTime === existing.timestamp) {
        await db.chatRooms.update(roomId, { lastMessageBody: trimmed })
      }
    }
    set({ editingMessage: null })
    // Build the m.replace content. The outer `body` is a fallback for clients
    // that don't understand m.new_content (Matrix spec convention prefixes a
    // " * " so it's still readable raw).
    const content: Record<string, unknown> = {
      msgtype: 'm.text',
      body: ` * ${trimmed}`,
      'm.new_content': { msgtype: 'm.text', body: trimmed },
      'm.relates_to': { rel_type: 'm.replace', event_id: eventId },
    }
    try {
      const { hubBus } = await import('@/sync-bus')
      await hubBus.rpc('matrix', 'sendEvent', {
        roomId, type: 'm.room.message', content,
      })
    } catch (err) {
      // Surface failure on the original message bubble — matches the regular
      // send-failure UX so the user sees the same red alert icon.
      const message = err instanceof Error ? err.message : 'Edit failed'
      await db.chatMessages.update(eventId, { sendFailed: message })
    }
  },

  sendReaction: async (roomId, eventId, emoji) => {
    const userId = localStorage.getItem('matrix_user_id') ?? ''
    // Optimistic: update message reactions immediately
    const msg = await db.chatMessages.get(eventId)
    if (msg) {
      const reactions = { ...(msg.reactions ?? {}) }
      const senders = reactions[emoji] ?? []
      if (!senders.includes(userId)) {
        reactions[emoji] = [...senders, userId]
        await db.chatMessages.update(eventId, { reactions })
      }
    }
    await enqueue('chatReact', { roomId, eventId, emoji }, { roomId })
  },

  undoMarkRead: async (room) => {
    optimisticallyRemoved.delete(room.id)
    await db.chatRooms.update(room.id, { isUnread: true, unreadCount: room.unreadCount, lastReadEventId: room.lastReadEventId, lastReadTs: room.lastReadTs })
    set({ selectedRoomId: room.id })
    useUiStore.getState().setUndoAction(null)
  },
}))
