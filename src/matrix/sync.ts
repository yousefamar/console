import { db, getMeta, setMeta } from '@/db'
import * as api from './api'
import { getMatrixUserId, isMatrixConnected } from './auth'
import {
  processSyncCrypto,
  decryptRoomEvent,
  encryptRoomEvent,
  shareRoomKeys,
  isCryptoReady,
} from './crypto'
import type {
  MatrixJoinedRoom,
  MatrixEvent,
  DbChatRoom,
  DbChatMessage,
  EncryptedFile,
} from './types'

export type MatrixSyncStatus = 'idle' | 'syncing' | 'error' | 'offline'

type SyncListener = (status: MatrixSyncStatus, detail?: string) => void
let listeners: SyncListener[] = []
let currentStatus: MatrixSyncStatus = 'idle'

export function onMatrixSyncStatus(fn: SyncListener): () => void {
  listeners.push(fn)
  fn(currentStatus)
  return () => { listeners = listeners.filter((l) => l !== fn) }
}

function setStatus(status: MatrixSyncStatus, detail?: string) {
  currentStatus = status
  for (const fn of listeners) fn(status, detail)
}

function isNetworkError(message: string): boolean {
  return message === 'Failed to fetch' || message === 'Load failed' || message === 'NetworkError when attempting to fetch resource.'
}

// --- Event → DbChatMessage conversion ---

// Build a DbChatMessage from event envelope + decrypted/plaintext content
export function buildMessageFromContent(
  event: MatrixEvent,
  roomId: string,
  content: Record<string, unknown>,
): DbChatMessage | null {
  const msgtype = content.msgtype as string
  if (!msgtype) return null

  let type: DbChatMessage['type'] = 'text'
  if (msgtype === 'm.notice') type = 'notice'
  else if (msgtype === 'm.emote') type = 'emote'
  else if (msgtype === 'm.image') type = 'image'
  else if (msgtype === 'm.file') type = 'file'
  else if (msgtype === 'm.audio') type = 'audio'
  else if (msgtype === 'm.video') type = 'video'

  // Handle replies
  let replyTo: DbChatMessage['replyTo'] = undefined
  const relatesTo = content['m.relates_to'] as Record<string, unknown> | undefined
  const inReplyTo = relatesTo?.['m.in_reply_to'] as { event_id: string } | undefined
  if (inReplyTo?.event_id) {
    replyTo = {
      eventId: inReplyTo.event_id,
      body: '',
      sender: '',
    }
  }

  // Check if this is an edit
  if (relatesTo?.rel_type === 'm.replace') return null

  // Extract audio metadata (MSC 3245 voice notes, MSC 1767 audio)
  const info = content.info as Record<string, unknown> | undefined
  const msc1767Audio = content['org.matrix.msc1767.audio'] as Record<string, unknown> | undefined
  const audioDuration = type === 'audio'
    ? ((msc1767Audio?.duration ?? info?.duration) as number | undefined)
    : undefined
  const audioWaveform = type === 'audio'
    ? (msc1767Audio?.waveform as number[] | undefined)
    : undefined
  const isVoiceNote = type === 'audio' && 'org.matrix.msc3245.voice' in content

  return {
    id: event.event_id!,
    roomId,
    senderId: event.sender!,
    senderName: event.sender!.split(':')[0]?.slice(1) ?? event.sender!,
    senderAvatar: undefined,
    body: (content.body as string) || (content.filename as string) || '',
    formattedBody: content.format === 'org.matrix.custom.html'
      ? (content.formatted_body as string)
      : undefined,
    timestamp: event.origin_server_ts ?? Date.now(),
    type,
    mediaUrl: (content.url as string) ?? undefined,
    encryptedFile: content.file ? (content.file as EncryptedFile) : undefined,
    replyTo,
    isEdited: false,
    reactions: undefined,
    mediaMimeType: (info?.mimetype as string) ?? undefined,
    audioDuration,
    audioWaveform,
    isVoiceNote,
  }
}

// Sync version: tries to decrypt from already-processed crypto state
async function eventToMessage(event: MatrixEvent, roomId: string): Promise<DbChatMessage | null> {
  if (!event.event_id || !event.sender) return null

  // Handle encrypted events — attempt decryption
  if (event.type === 'm.room.encrypted') {
    if (isCryptoReady()) {
      const decrypted = await decryptRoomEvent(event, roomId)
      if (decrypted) {
        // Expose decrypted type/content so downstream handlers (reactions, edits) can process them
        event.type = decrypted.type
        event.content = decrypted.content
        if (decrypted.type === 'm.room.message') {
          return buildMessageFromContent(event, roomId, decrypted.content)
        }
        if (decrypted.type === 'm.sticker') {
          return buildMessageFromContent(event, roomId, {
            ...decrypted.content,
            msgtype: 'm.image',
          })
        }
        // Non-renderable types (m.reaction, m.room.redaction, etc.)
        // are handled by processJoinedRoom after this returns null
        return null
      }
    }
    // Fallback: couldn't decrypt — store original event for retry after key import
    return {
      id: event.event_id,
      roomId,
      senderId: event.sender,
      senderName: event.sender.split(':')[0]?.slice(1) ?? event.sender,
      senderAvatar: undefined,
      body: '\u{1F512} Encrypted message',
      timestamp: event.origin_server_ts ?? Date.now(),
      type: 'text',
      isEdited: false,
      encryptedEvent: JSON.stringify(event),
    }
  }

  if (event.type === 'm.sticker') {
    return buildMessageFromContent(event, roomId, { ...event.content, msgtype: 'm.image' })
  }

  if (event.type !== 'm.room.message') return null

  return buildMessageFromContent(event, roomId, event.content)
}

// --- Process a joined room from sync response ---

function getRoomName(stateEvents: MatrixEvent[], roomId: string): string {
  // Check m.room.name
  const nameEvent = stateEvents.find(
    (e) => e.type === 'm.room.name' && e.state_key === '',
  )
  if (nameEvent?.content.name) {
    // Strip bridge bot display names from room names (e.g. "Slack bridge bot, Ben Camara" → "Ben Camara")
    return cleanBridgeBotFromName(nameEvent.content.name as string, stateEvents)
  }

  // Check m.room.canonical_alias
  const aliasEvent = stateEvents.find(
    (e) => e.type === 'm.room.canonical_alias' && e.state_key === '',
  )
  if (aliasEvent?.content.alias) return aliasEvent.content.alias as string

  // For DMs, use the other member's display name (exclude bots)
  const myUserId = getMatrixUserId()
  const members = stateEvents.filter(
    (e) => e.type === 'm.room.member' && e.content.membership === 'join',
  )
  const otherMembers = members.filter((e) => {
    const uid = e.state_key ?? ''
    if (uid === myUserId) return false
    if (isBridgeBotUser(uid)) return false
    return true
  })
  if (otherMembers.length === 1) {
    return (otherMembers[0]!.content.displayname as string) || otherMembers[0]!.state_key || roomId
  }
  if (otherMembers.length > 1) {
    return otherMembers
      .slice(0, 3)
      .map((m) => (m.content.displayname as string) || m.state_key || '?')
      .join(', ')
  }

  return roomId
}

// Remove bridge bot display names from room names set by bridges.
// Bridges often set room names like "Slack bridge bot, Ben Camara" or "WhatsApp bridge bot, Group Name".
function cleanBridgeBotFromName(name: string, stateEvents: MatrixEvent[]): string {
  // Collect display names of bridge bot users in this room
  const botNames: string[] = []
  for (const e of stateEvents) {
    if (e.type === 'm.room.member' && e.state_key && isBridgeBotUser(e.state_key)) {
      const dn = e.content.displayname as string | undefined
      if (dn) botNames.push(dn)
    }
  }
  if (botNames.length === 0) return name

  // Remove each bot name from the room name (handles comma-separated lists)
  let cleaned = name
  for (const botName of botNames) {
    // "BotName, Real Name" or "Real Name, BotName" or "BotName, Real Name, Other"
    cleaned = cleaned
      .replace(new RegExp(`${escapeRegex(botName)},\\s*`, 'gi'), '')
      .replace(new RegExp(`,\\s*${escapeRegex(botName)}`, 'gi'), '')
      .replace(new RegExp(`^${escapeRegex(botName)}$`, 'gi'), '')
  }
  cleaned = cleaned.trim()
  return cleaned || name // fall back to original if cleaning removed everything
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Bridge bot users are the appservice bots that manage bridges (not ghost users representing contacts).
// Ghost users like @whatsapp_123:server are real contacts — bots like @whatsappbot:server are not.
// Beeper uses "go" variants: @slackgobot, @discordgobot, @instagramgobot, etc.
const BRIDGE_BOT_RE = /^@(whatsapp|signal|telegram|discord(?:go)?|slack(?:go)?|instagram(?:go)?|facebook|twitter|linkedin|googlechat|gmessages|imessage|imessagecloud|meta|bluesky)bot$/i

// Map bot localpart prefix → canonical network name
function botToNetwork(localpart: string): string | undefined {
  const m = localpart.match(BRIDGE_BOT_RE)
  if (!m) return undefined
  const raw = m[1]!.toLowerCase()
  // Normalize "go" variants: slackgo→slack, discordgo→discord, instagramgo→instagram
  return raw.replace(/go$/, '')
}

function isBridgeBotUser(userId: string): boolean {
  const localpart = userId.split(':')[0] ?? ''
  return BRIDGE_BOT_RE.test(localpart)
}

// Extract bridge network from a bot user ID (e.g. @slackgobot:server → 'slack')
function networkFromBotUserId(userId: string): string | undefined {
  return botToNetwork(userId.split(':')[0] ?? '')
}

// Extract bridge network from a ghost user ID (e.g. @slackgo_U123:server → 'slack')
// Handles both standard (@slack_*) and Beeper "go" variants (@slackgo_*)
const GHOST_RE = /^@(whatsapp|signal|telegram|discord(?:go)?|slack(?:go)?|instagram(?:go)?|facebook|twitter|linkedin|googlechat|gmessages|imessage(?:cloud)?)_/i

function networkFromGhostUserId(userId: string): string | undefined {
  const m = (userId.split(':')[0] ?? '').match(GHOST_RE)
  if (!m) return undefined
  const raw = m[1]!.toLowerCase()
  if (raw === 'imessagecloud') return 'imessage'
  return raw.replace(/go$/, '')
}

function getRoomAvatar(stateEvents: MatrixEvent[], directRoom?: boolean): string | undefined {
  // Explicit room avatar always wins when present (intentionally set)
  const avatarEvent = stateEvents.find(
    (e) => e.type === 'm.room.avatar' && e.state_key === '',
  )
  const explicitAvatar = (avatarEvent?.content.url as string) ?? undefined
  if (explicitAvatar) return explicitAvatar

  // DM fallback: use member avatar when no explicit room avatar
  if (directRoom) {
    const myUserId = getMatrixUserId()
    const members = stateEvents.filter(
      (e) => e.type === 'm.room.member' && e.content.membership === 'join',
    )
    const otherMembers = members.filter((e) => {
      const uid = e.state_key ?? ''
      return uid !== myUserId && !isBridgeBotUser(uid)
    })
    if (otherMembers.length === 1 && otherMembers[0]!.content.avatar_url) {
      return otherMembers[0]!.content.avatar_url as string
    }
    // Self-rooms (e.g. "Note to self"): use own member avatar
    if (otherMembers.length === 0) {
      const self = members.find((e) => e.state_key === myUserId)
      if (self?.content.avatar_url) return self.content.avatar_url as string
    }
  }

  return undefined
}

function detectBridgeNetwork(stateEvents: MatrixEvent[]): string | undefined {
  // Detect bridge type from ghost user IDs or bridge bot user IDs in the room
  const members = stateEvents.filter(
    (e) => e.type === 'm.room.member' && e.content.membership === 'join',
  )

  let botNetwork: string | undefined
  for (const member of members) {
    const userId = member.state_key ?? ''
    // Ghost users (direct contacts) — most reliable signal
    // Beeper uses "go" variants: @slackgo_*, @discordgo_*, @instagramgo_*
    const ghostNetwork = networkFromGhostUserId(userId)
    if (ghostNetwork) return ghostNetwork
    // Bridge bot — fallback for channels/broadcasts that have no ghost users
    if (!botNetwork) botNetwork = networkFromBotUserId(userId)
  }

  return botNetwork
}

function isDirect(stateEvents: MatrixEvent[]): boolean {
  // A room with an explicit m.room.name is a group/channel, not a DM.
  // Bridge DMs derive names from members; channels have explicit names.
  const hasExplicitName = stateEvents.some(
    (e) => e.type === 'm.room.name' && e.state_key === '' && e.content.name,
  )
  if (hasExplicitName) return false

  // Heuristic: room with 2 or fewer real (non-bot) joined members
  const realMembers = stateEvents.filter(
    (e) => e.type === 'm.room.member' && e.content.membership === 'join' && !isBridgeBotUser(e.state_key ?? ''),
  )
  return realMembers.length <= 2
}

function getMemberCount(stateEvents: MatrixEvent[]): number {
  return stateEvents.filter(
    (e) => e.type === 'm.room.member' && e.content.membership === 'join' && !isBridgeBotUser(e.state_key ?? ''),
  ).length
}

// Update sender display names from state events
function getSenderInfo(
  stateEvents: MatrixEvent[],
): Map<string, { name: string; avatar?: string }> {
  const info = new Map<string, { name: string; avatar?: string }>()
  for (const event of stateEvents) {
    if (event.type === 'm.room.member' && event.state_key) {
      info.set(event.state_key, {
        name: (event.content.displayname as string) || event.state_key.split(':')[0]?.slice(1) || event.state_key,
        avatar: event.content.avatar_url as string | undefined,
      })
    }
  }
  return info
}

async function processJoinedRoom(
  roomId: string,
  room: MatrixJoinedRoom,
): Promise<void> {
  const stateEvents = room.state?.events ?? []
  const timelineEvents = room.timeline?.events ?? []
  const allStateForRoom = [...stateEvents]

  // Merge state from timeline (state events can appear in timeline too)
  for (const event of timelineEvents) {
    if (event.state_key !== undefined) {
      allStateForRoom.push(event)
    }
  }

  // When timeline is limited, there may be a gap between cached messages and the
  // new sync batch. We keep old messages (re-decryption would lose E2EE messages)
  // and let prev_batch pagination fill the gap when the user scrolls up.

  // Get sender info for enriching messages (from state events in this sync batch)
  const senderInfo = getSenderInfo(allStateForRoom)

  // On incremental sync, state events may be absent — fill gaps from cached messages
  const existing = await db.chatRooms.get(roomId)

  // Detect if room is encrypted
  const isEncrypted = allStateForRoom.some(
    (e) => e.type === 'm.room.encryption' && e.state_key === '',
  )

  // Fill sender info gaps from cached messages (incremental sync may lack state events)
  if (existing) {
    const missingSenders = new Set<string>()
    for (const event of timelineEvents) {
      if (event.sender && !senderInfo.has(event.sender)) missingSenders.add(event.sender)
    }
    if (missingSenders.size > 0) {
      const cachedMsgs = await db.chatMessages.where('roomId').equals(roomId).toArray()
      for (const m of cachedMsgs) {
        if (missingSenders.has(m.senderId)) {
          const localpart = m.senderId.split(':')[0]?.slice(1) ?? ''
          if (m.senderName !== localpart) {
            senderInfo.set(m.senderId, { name: m.senderName, avatar: m.senderAvatar })
            missingSenders.delete(m.senderId)
          }
        }
        if (missingSenders.size === 0) break
      }
    }
  }

  // Convert timeline events to messages (with decryption)
  const messages: DbChatMessage[] = []
  for (const event of timelineEvents) {
    const msg = await eventToMessage(event, roomId)
    if (msg) {
      // Enrich with sender display name and avatar
      const info = senderInfo.get(msg.senderId)
      if (info) {
        msg.senderName = info.name
        msg.senderAvatar = info.avatar
      } else if (existing?.isDirect && existing.name && msg.senderId !== getMatrixUserId()) {
        // DM fallback: use room name for unresolved bridge ghost users
        msg.senderName = existing.name
      }
      messages.push(msg)
    }
    // Handle reactions
    if (event.type === 'm.reaction' && event.event_id) {
      const relates = event.content['m.relates_to'] as Record<string, unknown> | undefined
      if (relates?.rel_type === 'm.annotation' && relates.event_id && relates.key) {
        const targetId = relates.event_id as string
        const emoji = relates.key as string
        const sender = event.sender ?? ''
        // Check in-flight messages first (same batch, not yet persisted), then DB
        const inFlight = messages.find((m) => m.id === targetId)
        const existing = inFlight ?? await db.chatMessages.get(targetId)
        if (existing) {
          const reactions = existing.reactions ?? {}
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
    // Handle redactions — mark as deleted (keep message for diff view)
    if (event.type === 'm.room.redaction') {
      const targetId = (event.content.redacts as string) || (event as unknown as Record<string, unknown>).redacts as string
      if (targetId) {
        await db.chatMessages.update(targetId, {
          isDeleted: true,
          deletedBy: event.sender ?? undefined,
        })
      }
    }
    // Handle edits — store original body for diff view
    if (event.type === 'm.room.message' || event.type === 'm.room.encrypted') {
      const content = event.type === 'm.room.encrypted' && isCryptoReady()
        ? (await decryptRoomEvent(event, roomId))?.content ?? event.content
        : event.content
      const relates = content['m.relates_to'] as Record<string, unknown> | undefined
      if (relates?.rel_type === 'm.replace' && relates.event_id) {
        const targetId = relates.event_id as string
        const newContent = content['m.new_content'] as Record<string, unknown> | undefined
        if (newContent) {
          const target = await db.chatMessages.get(targetId)
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

  // Second pass: populate replyTo.body and replyTo.sender from batch or DB
  for (const msg of messages) {
    if (msg.replyTo && !msg.replyTo.body) {
      // Look up in same batch first
      const batchTarget = messages.find((m) => m.id === msg.replyTo!.eventId)
      if (batchTarget) {
        msg.replyTo.body = batchTarget.body
        msg.replyTo.sender = batchTarget.senderName
      } else {
        // Fall back to DB
        const dbTarget = await db.chatMessages.get(msg.replyTo.eventId)
        if (dbTarget) {
          msg.replyTo.body = dbTarget.body
          msg.replyTo.sender = dbTarget.senderName
        }
      }
    }
  }

  // Save messages + clean up local echoes that have been confirmed by the server
  if (messages.length > 0) {
    await db.chatMessages.bulkPut(messages)

    // Delete local echo messages now that server-confirmed versions have arrived
    const myUserId = getMatrixUserId()
    const myMessages = messages.filter((m) => m.senderId === myUserId)
    if (myMessages.length > 0) {
      const localEchos = await db.chatMessages
        .where('roomId').equals(roomId)
        .filter((m) => m.id.startsWith('~'))
        .toArray()
      for (const echo of localEchos) {
        // Match by body content (local echo body matches sent message body)
        if (myMessages.some((m) => m.body === echo.body || m.body === echo.body.replace(/^📷 /, ''))) {
          await db.chatMessages.delete(echo.id)
        }
      }
    }
  }

  // Process read receipts from ephemeral events
  const myUserId = getMatrixUserId()
  const ephemeralEvents = room.ephemeral?.events ?? []
  const existingReceipts = existing?.readReceipts ?? {}
  const updatedReceipts = { ...existingReceipts }

  for (const event of ephemeralEvents) {
    if (event.type === 'm.receipt') {
      const content = event.content as Record<string, Record<string, Record<string, { ts?: number }>>>
      for (const [eventId, receiptTypes] of Object.entries(content)) {
        const readers = receiptTypes['m.read'] ?? receiptTypes['m.read.private'] ?? {}
        for (const [userId, data] of Object.entries(readers)) {
          if (userId === myUserId) continue // Don't show own receipts
          if (isBridgeBotUser(userId)) continue // Skip bridge bot users
          const info = senderInfo.get(userId)
          // For DM rooms, use room name for bridge ghost users (e.g. @whatsapp_123 → "Veronica")
          const localpart = userId.split(':')[0]?.slice(1) ?? userId
          const resolvedName = info?.name ?? localpart
          const displayName = existing?.isDirect && existing.name && resolvedName === localpart
            ? existing.name
            : resolvedName
          updatedReceipts[userId] = {
            eventId,
            ts: data.ts ?? Date.now(),
            displayName,
            avatar: info?.avatar ?? (existing?.isDirect ? existing?.avatar : undefined),
          }
        }
      }
    }
  }

  // Check room tags (m.lowpriority, m.archive) from account data
  const accountDataEvents = room.account_data?.events ?? []
  const tagEvent = accountDataEvents.find((e) => e.type === 'm.tag')
  const tags = (tagEvent?.content.tags ?? tagEvent?.content) as Record<string, unknown> | undefined
  const tagNames = tags ? Object.keys(tags) : existing?.tags
  const roomIsLowPriority = !!(tags?.['m.lowpriority'] || tags?.['m.archive']) || (existing?.isLowPriority ?? false)

  // Build/update room record
  const lastMsg = messages[messages.length - 1]
  const serverNotifCount = room.unread_notifications?.notification_count ?? 0
  const serverHighlightCount = room.unread_notifications?.highlight_count ?? 0

  const hasNewMessages = messages.length > 0
  const hadMessages = !!existing?.lastMessageBody
  // For existing rooms, only re-unread when genuinely new messages from others arrive —
  // don't let stale server notification_count override local read state.
  // But DO respect server notification_count dropping to 0 (read on another client/platform).
  const newestMessageTime = hasNewMessages
    ? Math.max(...messages.map((m) => m.timestamp))
    : 0
  const hasNewerMessagesFromOthers = existing
    ? newestMessageTime > (existing.lastMessageTime ?? 0) && messages.some((m) => m.senderId !== myUserId)
    : false
  // If the latest message is from me (sent from another device/client), room is handled — mark read
  const latestIsFromMe = lastMsg?.senderId === myUserId

  // For lastMessageTime, use: last message timestamp > any timeline event timestamp > existing > 0
  let lastMessageTime = lastMsg?.timestamp ?? existing?.lastMessageTime ?? 0
  if (lastMessageTime === 0 && timelineEvents.length > 0) {
    // Fall back to the latest timeline event's origin_server_ts (even non-message events)
    const latestTs = timelineEvents.reduce(
      (max, e) => Math.max(max, e.origin_server_ts ?? 0),
      0,
    )
    if (latestTs > 0) lastMessageTime = latestTs
  }

  // Prefer computed name if we have a room name state event, otherwise keep existing name.
  // On incremental sync, member-list-derived names are unreliable (partial state) —
  // only override existing name if we got an explicit m.room.name or m.room.canonical_alias.
  const computedName = getRoomName(allStateForRoom, roomId)
  // Full member list is only available during full sync (has m.room.create) or when
  // many members are present. With lazy_load_members, incremental sync only includes
  // the sender's member event — not enough to compute isDirect/memberCount/avatar.
  const hasFullMembers = allStateForRoom.some((e) => e.type === 'm.room.create')
  const directRoom = hasFullMembers ? isDirect(allStateForRoom) : (existing?.isDirect ?? true)
  const computedAvatar = hasFullMembers
    ? getRoomAvatar(allStateForRoom, directRoom)
    : undefined
  // Explicit room avatar changes (m.room.avatar state event) should always be picked up
  const explicitAvatarEvent = allStateForRoom.find(
    (e) => e.type === 'm.room.avatar' && e.state_key === '',
  )
  const hasExplicitName = allStateForRoom.some(
    (e) => (e.type === 'm.room.name' && e.state_key === '' && e.content.name) ||
           (e.type === 'm.room.canonical_alias' && e.state_key === '' && e.content.alias),
  )

  const dbRoom: DbChatRoom = {
    id: roomId,
    name: hasExplicitName ? computedName
      : existing?.name ? existing.name
      : computedName !== roomId ? computedName
      : roomId,
    avatar: hasFullMembers
      ? (computedAvatar ?? (directRoom ? existing?.avatar : undefined))
      : explicitAvatarEvent?.content.url
        ? (explicitAvatarEvent.content.url as string)
        : existing?.avatar,
    isDirect: directRoom,
    memberCount: hasFullMembers ? getMemberCount(allStateForRoom) : (existing?.memberCount ?? 2),
    lastMessageBody: lastMsg?.body ?? existing?.lastMessageBody ?? '',
    lastMessageSender: lastMsg?.senderName ?? existing?.lastMessageSender ?? '',
    lastMessageTime,
    isUnread: latestIsFromMe
      ? false
      : existing
        ? (serverNotifCount === 0 && !hasNewerMessagesFromOthers
          ? false  // read on another client — server says 0 notifications
          : (existing.isUnread || (roomIsLowPriority ? serverHighlightCount > 0 : hasNewerMessagesFromOthers)))
        : (roomIsLowPriority
          ? (serverHighlightCount > 0)
          : (serverNotifCount > 0 && (hasNewMessages || hadMessages || lastMessageTime > 0))),
    unreadCount: latestIsFromMe
      ? 0
      : existing
        ? (serverNotifCount === 0 && !hasNewerMessagesFromOthers
          ? 0  // read on another client
          : hasNewerMessagesFromOthers
            ? (existing.unreadCount ?? 0) + messages.filter((m) => m.senderId !== myUserId).length
            : existing.unreadCount)
        : serverNotifCount || undefined,
    lastReadEventId: existing?.lastReadEventId,
    // When new unread messages arrive and there's no lastReadTs yet, set it to the
    // previous last message time so the "New" divider renders at the right boundary.
    lastReadTs: existing?.lastReadTs
      ?? (hasNewerMessagesFromOthers && existing?.lastMessageTime
        ? existing.lastMessageTime
        : undefined),
    isMuted: existing?.isMuted ?? false,
    isLowPriority: roomIsLowPriority,
    tags: tagNames,
    isEncrypted: isEncrypted || (existing?.isEncrypted ?? false),
    networkIcon: detectBridgeNetwork(allStateForRoom) ?? existing?.networkIcon,
    snoozedUntil: existing?.snoozedUntil,
    prevBatch: room.timeline?.prev_batch ?? existing?.prevBatch,
    readReceipts: updatedReceipts,
  }

  await db.chatRooms.put(dbRoom)

  // Fire notification for new messages from others
  // Skip low-priority rooms and rooms the server says have no notifications (muted via push rules)
  if (hasNewerMessagesFromOthers && lastMsg && lastMsg.senderId !== myUserId && !roomIsLowPriority && serverNotifCount > 0) {
    import('@/notifications').then(({ notify }) => {
      const senderName = lastMsg.senderName || lastMsg.senderId
      const body = lastMsg.body?.slice(0, 100) || 'New message'
      // Convert mxc:// avatar to HTTP URL
      let icon: string | undefined
      if (dbRoom.avatar?.startsWith('mxc://')) {
        const [server, mediaId] = dbRoom.avatar.slice(6).split('/')
        const hs = localStorage.getItem('matrix_homeserver') || ''
        if (hs && server && mediaId) {
          icon = `${hs}/_matrix/media/v3/thumbnail/${server}/${mediaId}?width=96&height=96&method=crop`
        }
      }
      notify({
        title: !dbRoom.isDirect && dbRoom.name ? `${senderName} in ${dbRoom.name}` : senderName,
        body,
        icon,
        tag: `chat-${roomId}`,
        data: { pane: 'chat', itemId: roomId },
      })
    })
  }
}

// --- Sync lock (prevents concurrent syncs) ---

let syncInProgress: Promise<void> | null = null

// --- Full Sync ---

export async function fullMatrixSync(): Promise<void> {
  if (syncInProgress) await syncInProgress
  const done = runFullMatrixSync()
  syncInProgress = done.catch(() => {}).finally(() => { syncInProgress = null })
  return done
}

async function runFullMatrixSync(): Promise<void> {
  if (!isMatrixConnected()) return
  setStatus('syncing', 'Matrix: full sync...')

  try {
    const response = await api.sync({ timeout: 0 })

    // Process crypto first so decryption keys are available for room events
    if (isCryptoReady()) {
      await processSyncCrypto(response)
    }

    // Process all joined rooms
    const joinedRooms = response.rooms?.join ?? {}
    const roomIds = Object.keys(joinedRooms)

    for (let i = 0; i < roomIds.length; i++) {
      const roomId = roomIds[i]!
      await processJoinedRoom(roomId, joinedRooms[roomId]!)
      if (i % 10 === 0 && i > 0) {
        setStatus('syncing', `Matrix: synced ${i}/${roomIds.length} rooms`)
      }
    }

    // Save sync token for incremental sync
    await setMeta('matrixSyncToken', response.next_batch)

    // Remove rooms we've left
    const leftRooms = Object.keys(response.rooms?.leave ?? {})
    if (leftRooms.length > 0) {
      for (const roomId of leftRooms) {
        await db.chatRooms.delete(roomId)
        await db.chatMessages.where('roomId').equals(roomId).delete()
      }
    }

    setStatus('idle')
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    setStatus(isNetworkError(message) ? 'offline' : 'error', message)
    throw err
  }
}

// --- Incremental Sync ---

export async function incrementalMatrixSync(): Promise<void> {
  if (syncInProgress) await syncInProgress
  const done = runIncrementalMatrixSync()
  syncInProgress = done.catch(() => {}).finally(() => { syncInProgress = null })
  return done
}

async function runIncrementalMatrixSync(): Promise<void> {
  if (!isMatrixConnected()) return

  const syncToken = await getMeta('matrixSyncToken')
  if (!syncToken) {
    return runFullMatrixSync()
  }

  try {
    const response = await api.sync({ since: syncToken, timeout: 30_000 })

    // Process crypto first so decryption keys are available
    if (isCryptoReady()) {
      await processSyncCrypto(response)
    }

    // Save sync token immediately so next long-poll can start from the right place
    // even if room processing is slow or partially fails
    await setMeta('matrixSyncToken', response.next_batch)

    // Process updated rooms concurrently — each room is independent.
    // Errors are caught per-room so one failure doesn't block others.
    const joinedRooms = response.rooms?.join ?? {}
    await Promise.all(
      Object.entries(joinedRooms).map(([roomId, room]) =>
        processJoinedRoom(roomId, room).catch(() => {}),
      ),
    )

    // Handle left rooms
    const leftRooms = Object.keys(response.rooms?.leave ?? {})
    for (const roomId of leftRooms) {
      await db.chatRooms.delete(roomId)
      await db.chatMessages.where('roomId').equals(roomId).delete()
    }

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    // Only surface real errors (not transient network blips) to status
    if (!isNetworkError(message)) {
      setStatus('error', message)
    }
    throw err
  }
}

// --- Get room member IDs for key sharing ---

async function getRoomMemberIds(roomId: string): Promise<string[]> {
  try {
    const stateEvents = await api.getRoomState(roomId)
    return stateEvents
      .filter((e) => e.type === 'm.room.member' && e.content.membership === 'join')
      .map((e) => e.state_key ?? '')
      .filter(Boolean)
  } catch {
    // Fallback to just our own user
    return [getMatrixUserId() ?? ''].filter(Boolean)
  }
}

// --- Process chat queue actions ---

let chatQueueLock = false

export async function processChatQueue(): Promise<void> {
  if (!isMatrixConnected()) return
  if (chatQueueLock) return
  chatQueueLock = true

  try {

  const pending = await db.queue
    .where('status')
    .equals('pending')
    .filter((a) => a.type.startsWith('chat'))
    .sortBy('createdAt')

  for (const action of pending) {
    if (!action.id) continue
    await db.queue.update(action.id, { status: 'processing' })

    try {
      switch (action.type) {
        case 'chatSend': {
          const p = action.payload as { roomId: string; body: string; formattedBody?: string; replyToEventId?: string }
          const room = await db.chatRooms.get(p.roomId)
          let sendResult: { event_id?: string } | undefined

          // Build reply relation if replying
          const replyRelation = p.replyToEventId
            ? { 'm.in_reply_to': { event_id: p.replyToEventId } }
            : undefined

          if (room?.isEncrypted && isCryptoReady()) {
            // Get room members for key sharing
            const memberIds = await getRoomMemberIds(p.roomId)
            await shareRoomKeys(p.roomId, memberIds)

            // Build message content
            const content: Record<string, unknown> = {
              msgtype: 'm.text',
              body: p.body,
            }
            if (p.formattedBody) {
              content.format = 'org.matrix.custom.html'
              content.formatted_body = p.formattedBody
            }
            if (replyRelation) {
              content['m.relates_to'] = replyRelation
            }

            // Encrypt and send
            const encrypted = await encryptRoomEvent(p.roomId, 'm.room.message', content)
            if (encrypted) {
              sendResult = await api.sendEncryptedMessage(p.roomId, JSON.parse(encrypted))
            } else {
              // Encryption failed — fall back to plaintext
              sendResult = await api.sendMessage(p.roomId, p.body, p.formattedBody)
            }
          } else {
            // Build content with reply relation for unencrypted path
            if (replyRelation) {
              const content: Record<string, unknown> = {
                msgtype: 'm.text',
                body: p.body,
                'm.relates_to': replyRelation,
              }
              if (p.formattedBody) {
                content.format = 'org.matrix.custom.html'
                content.formatted_body = p.formattedBody
              }
              sendResult = await api.sendRoomEvent(p.roomId, 'm.room.message', content)
            } else {
              sendResult = await api.sendMessage(p.roomId, p.body, p.formattedBody)
            }
          }

          // Immediately replace local echo with confirmed message (real event_id).
          // Don't wait for sync echo — sync loop may be blocked processing other rooms.
          const realEventId = sendResult?.event_id
          if (realEventId) {
            const localEchos = await db.chatMessages
              .where('roomId').equals(p.roomId)
              .filter((m) => m.id.startsWith('~') && m.body === p.body)
              .toArray()
            const echo = localEchos[0]
            if (echo) {
              await db.chatMessages.delete(echo.id)
              await db.chatMessages.put({ ...echo, id: realEventId })
            }
          }
          break
        }
        case 'chatMarkRead': {
          const p = action.payload as { roomId: string; eventId: string }
          await api.setReadMarker(p.roomId, p.eventId)
          await api.sendReadReceipt(p.roomId, p.eventId)
          break
        }
        case 'chatReact': {
          const p = action.payload as { roomId: string; eventId: string; emoji: string }
          const room = await db.chatRooms.get(p.roomId)
          if (room?.isEncrypted && isCryptoReady()) {
            const memberIds = await getRoomMemberIds(p.roomId)
            await shareRoomKeys(p.roomId, memberIds)
            const content = {
              'm.relates_to': { rel_type: 'm.annotation', event_id: p.eventId, key: p.emoji },
            }
            const encrypted = await encryptRoomEvent(p.roomId, 'm.reaction', content)
            if (encrypted) {
              await api.sendEncryptedMessage(p.roomId, JSON.parse(encrypted))
            } else {
              await api.sendReaction(p.roomId, p.eventId, p.emoji)
            }
          } else {
            await api.sendReaction(p.roomId, p.eventId, p.emoji)
          }
          break
        }
      }
      await db.queue.delete(action.id)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      const retryCount = action.retryCount + 1
      const isFinalFailure = retryCount >= 3
      await db.queue.update(action.id, {
        status: isFinalFailure ? 'failed' : 'pending',
        error: message,
        retryCount,
      })
      // Mark local echo message as failed so the UI shows the error
      if (isFinalFailure && action.type === 'chatSend' && action.roomId) {
        const localMsgs = await db.chatMessages
          .where('roomId').equals(action.roomId)
          .filter((m) => m.id.startsWith('~'))
          .toArray()
        // Match by body content (local echo has same body as queued action)
        const p = action.payload as { body?: string }
        const match = localMsgs.find((m) => m.body === p.body)
        if (match) {
          await db.chatMessages.update(match.id, { sendFailed: message })
        }
        const room = await db.chatRooms.get(action.roomId)
        import('@/notifications').then(({ notify }) => {
          notify({
            title: 'Message failed to send',
            body: room?.name ? `in ${room.name}: ${message}` : message,
            tag: `send-failed:${match?.id ?? action.id}`,
            data: { pane: 'chat' as const, itemId: action.roomId! },
          })
        })
      }
    }
  }

  } finally {
    chatQueueLock = false
  }
}

// --- Check snoozed chat rooms ---

export async function checkChatSnoozes(): Promise<void> {
  const now = Date.now()
  const snoozed = await db.chatRooms
    .where('snoozedUntil')
    .belowOrEqual(now)
    .toArray()

  for (const room of snoozed) {
    if (!room.snoozedUntil) continue
    await db.chatRooms.update(room.id, { snoozedUntil: undefined })
  }
}
