// ============================================================================
// Room-state computation — port of src/matrix/sync.ts::processJoinedRoom's
// room-shaping logic from the SPA to the hub. The SPA used to derive the
// canonical room view (name, isUnread, memberCount, avatar, tags, …) locally
// from each /sync delta; that meant every client diverged whenever it missed
// or processed deltas differently. With this module the hub owns the
// derivation, persists the result via SnapshotStore, and broadcasts it.
//
// Messages stay client-cached on demand — only room metadata is mirrored.
// ============================================================================
import type { MatrixEvent } from '../matrix-client.js'

/** Read-receipt entry, mirrors the SPA's DbChatRoom['readReceipts'] shape. */
export interface ReadReceipt {
  eventId: string
  ts: number
  displayName?: string
  avatar?: string
}

/** Canonical hub-side room snapshot. Shape mirrors the SPA's DbChatRoom so
 *  the client can drop straight into IDB. */
export interface RoomState {
  id: string
  name: string
  avatar?: string
  isDirect: boolean
  memberCount: number
  lastMessageBody?: string
  lastMessageSender?: string
  lastMessageTime: number
  isUnread: boolean
  /** User explicitly marked the room unread (no homeserver concept). Sticky:
   *  survives sync recomputes that report notification_count=0, cleared only by
   *  an explicit mark-read. Without this, any sync touching the room (notably
   *  the big catch-up after a hub restart) wiped the manual flag. */
  manualUnread?: boolean
  unreadCount?: number
  lastReadEventId?: string
  lastReadTs?: number
  isMuted: boolean
  isLowPriority: boolean
  tags?: string[]
  isEncrypted: boolean
  networkIcon?: string
  snoozedUntil?: number
  /** Pagination cursor — preserved per room for client `loadOlder`. */
  prevBatch?: string
  readReceipts?: Record<string, ReadReceipt>
}

// --- bridge bot / ghost detection ---------------------------------------

const BRIDGE_BOT_RE = /^@(whatsapp|signal|telegram|discord(?:go)?|slack(?:go)?|instagram(?:go)?|facebook|twitter|linkedin|googlechat|gmessages|imessage(?:cloud)?)bot:/i
const GHOST_RE = /^@(whatsapp|signal|telegram|discord(?:go)?|slack(?:go)?|instagram(?:go)?|facebook|twitter|linkedin|googlechat|gmessages|imessage(?:cloud)?)_/i

export function isBridgeBotUser(userId: string): boolean {
  return BRIDGE_BOT_RE.test(userId)
}

function networkFromGhostUserId(userId: string): string | undefined {
  const m = userId.match(GHOST_RE)
  if (!m) return undefined
  const raw = m[1]!.toLowerCase()
  if (raw === 'imessagecloud') return 'imessage'
  return raw.replace(/go$/, '')
}

function networkFromBotUserId(userId: string): string | undefined {
  const m = userId.match(BRIDGE_BOT_RE)
  if (!m) return undefined
  const raw = m[1]!.toLowerCase()
  if (raw === 'imessagecloud') return 'imessage'
  return raw.replace(/go$/, '')
}

export function detectBridgeNetwork(stateEvents: MatrixEvent[]): string | undefined {
  const joined = stateEvents.filter(
    (e) => e.type === 'm.room.member' && (e.content as any)?.membership === 'join',
  )
  let botNetwork: string | undefined
  for (const ev of joined) {
    const uid = (ev.state_key as string) ?? ''
    const ghost = networkFromGhostUserId(uid)
    if (ghost) return ghost
    if (!botNetwork) botNetwork = networkFromBotUserId(uid)
  }
  return botNetwork
}

// --- name / avatar / member derivation ----------------------------------

function dedupeCommaJoinedName(name: string): string {
  if (!name.includes(',')) return name
  const parts = name.split(', ').map((p) => p.trim()).filter(Boolean)
  if (parts.length < 2) return name
  const first = parts[0]!
  if (parts.every((p) => p === first)) return first
  return name
}

function cleanBridgeBotFromName(name: string, stateEvents: MatrixEvent[]): string {
  const botNames: string[] = []
  for (const e of stateEvents) {
    if (e.type === 'm.room.member' && e.state_key && isBridgeBotUser(e.state_key)) {
      const dn = (e.content as any)?.displayname as string | undefined
      if (dn) botNames.push(dn)
    }
  }
  if (botNames.length === 0) return name
  let cleaned = name
  for (const bn of botNames) {
    cleaned = cleaned.replace(new RegExp(`(^|, )${bn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(, |$)`, 'g'), (_m, pre, post) => pre && post ? ', ' : '')
  }
  return cleaned.trim().replace(/^,\s*|,\s*$/g, '') || name
}

export function getRoomName(stateEvents: MatrixEvent[], roomId: string, myUserId: string): string {
  for (const e of stateEvents) {
    if (e.type === 'm.room.name' && e.state_key === '' && (e.content as any)?.name) {
      return cleanBridgeBotFromName((e.content as any).name as string, stateEvents)
    }
  }
  for (const e of stateEvents) {
    if (e.type === 'm.room.canonical_alias' && e.state_key === '' && (e.content as any)?.alias) {
      return (e.content as any).alias as string
    }
  }
  const members = stateEvents.filter(
    (e) => e.type === 'm.room.member' && (e.content as any)?.membership === 'join',
  )
  const others = members.filter((e) => {
    const uid = e.state_key ?? ''
    if (uid === myUserId) return false
    if (isBridgeBotUser(uid)) return false
    return true
  })
  if (others.length === 1) {
    return ((others[0]!.content as any).displayname as string) || others[0]!.state_key || roomId
  }
  if (others.length > 1) {
    const names = others.map((e) => ((e.content as any).displayname as string) || e.state_key || '?')
    const unique = Array.from(new Set(names))
    return dedupeCommaJoinedName(unique.slice(0, 3).join(', '))
  }
  return roomId
}

export function isDirect(stateEvents: MatrixEvent[]): boolean {
  const hasExplicitName = stateEvents.some(
    (e) => e.type === 'm.room.name' && e.state_key === '' && (e.content as any)?.name,
  )
  if (hasExplicitName) return false
  const realMembers = stateEvents.filter(
    (e) => e.type === 'm.room.member'
      && (e.content as any)?.membership === 'join'
      && !isBridgeBotUser(e.state_key ?? ''),
  )
  return realMembers.length <= 2
}

export function getMemberCount(stateEvents: MatrixEvent[]): number {
  return stateEvents.filter(
    (e) => e.type === 'm.room.member'
      && (e.content as any)?.membership === 'join'
      && !isBridgeBotUser(e.state_key ?? ''),
  ).length
}

export function getRoomAvatar(stateEvents: MatrixEvent[], directRoom: boolean, myUserId: string): string | undefined {
  const avatarEvent = stateEvents.find(
    (e) => e.type === 'm.room.avatar' && e.state_key === '',
  )
  const explicitAvatar = ((avatarEvent?.content as any)?.url as string) ?? undefined
  if (explicitAvatar) return explicitAvatar
  if (!directRoom) return undefined
  const members = stateEvents.filter(
    (e) => e.type === 'm.room.member' && (e.content as any)?.membership === 'join',
  )
  const others = members.filter((e) => {
    const uid = e.state_key ?? ''
    return uid !== myUserId && !isBridgeBotUser(uid)
  })
  if (others.length === 1 && (others[0]!.content as any).avatar_url) {
    return (others[0]!.content as any).avatar_url as string
  }
  if (others.length === 0) {
    const self = members.find((e) => e.state_key === myUserId)
    if ((self?.content as any)?.avatar_url) return (self!.content as any).avatar_url as string
  }
  return undefined
}

// --- Sender display-name + avatar map for read receipts ------------------

function getSenderInfo(stateEvents: MatrixEvent[]): Map<string, { name: string; avatar?: string }> {
  const info = new Map<string, { name: string; avatar?: string }>()
  for (const event of stateEvents) {
    if (event.type === 'm.room.member' && event.state_key) {
      const content = event.content as any
      info.set(event.state_key, {
        name: (content.displayname as string) || event.state_key.split(':')[0]?.slice(1) || event.state_key,
        avatar: content.avatar_url as string | undefined,
      })
    }
  }
  return info
}

// --- Main computation ----------------------------------------------------

export interface SyncRoomDelta {
  state?: { events: MatrixEvent[] }
  timeline?: { events: MatrixEvent[]; prev_batch?: string; limited?: boolean }
  ephemeral?: { events: MatrixEvent[] }
  account_data?: { events: MatrixEvent[] }
  unread_notifications?: { notification_count?: number; highlight_count?: number }
}

export interface ComputeContext {
  myUserId: string
  /** roomIds in the server-tracked `room`-kind push-rule muted set. */
  mutedRoomIds: Set<string>
}

/**
 * Compute the canonical room snapshot from an existing snapshot + an incoming
 * /sync delta. Pure function — no IO. Mirrors the SPA's processJoinedRoom
 * derivation so the hub can take ownership of the room view and broadcast it.
 */
export function computeRoomState(
  roomId: string,
  existing: RoomState | undefined,
  delta: SyncRoomDelta,
  ctx: ComputeContext,
): RoomState {
  const stateEvents = delta.state?.events ?? []
  const timelineEvents = delta.timeline?.events ?? []
  const allStateForRoom = [...stateEvents]
  for (const event of timelineEvents) {
    if (event.state_key !== undefined) allStateForRoom.push(event)
  }

  const senderInfo = getSenderInfo(allStateForRoom)

  const isEncrypted = allStateForRoom.some(
    (e) => e.type === 'm.room.encryption' && e.state_key === '',
  )

  // Read receipts (ephemeral) — accumulate so we don't drop existing ones.
  const updatedReceipts: Record<string, ReadReceipt> = { ...(existing?.readReceipts ?? {}) }
  for (const event of delta.ephemeral?.events ?? []) {
    if (event.type !== 'm.receipt') continue
    const content = event.content as Record<string, Record<string, Record<string, { ts?: number }>>>
    for (const [eventId, receiptTypes] of Object.entries(content)) {
      const readers = receiptTypes['m.read'] ?? receiptTypes['m.read.private'] ?? {}
      for (const [userId, data] of Object.entries(readers)) {
        if (userId === ctx.myUserId) continue
        if (isBridgeBotUser(userId)) continue
        const info = senderInfo.get(userId)
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

  // Tags (m.lowpriority, m.archive, m.favourite) from account_data
  const tagEvent = (delta.account_data?.events ?? []).find((e) => e.type === 'm.tag')
  const rawTags = ((tagEvent?.content as any)?.tags ?? (tagEvent?.content as any)) as Record<string, unknown> | undefined
  const tagNames = rawTags ? Object.keys(rawTags) : existing?.tags
  const roomIsLowPriority = !!(rawTags?.['m.lowpriority'] || rawTags?.['m.archive']) || (existing?.isLowPriority ?? false)

  // Latest message preview from timeline
  type PreviewMsg = { senderId?: string; senderName?: string; body?: string; timestamp: number }
  let lastMsg: PreviewMsg | undefined
  for (const ev of timelineEvents) {
    if (ev.type !== 'm.room.message') continue
    const ts = ev.origin_server_ts ?? 0
    if (!lastMsg || ts > lastMsg.timestamp) {
      const content = ev.content as Record<string, unknown>
      const body = typeof content.body === 'string' ? content.body : ''
      const info = ev.sender ? senderInfo.get(ev.sender) : undefined
      lastMsg = {
        senderId: ev.sender,
        senderName: info?.name ?? ev.sender,
        body,
        timestamp: ts,
      }
    }
  }

  // CRITICAL: distinguish "field absent" from "explicitly zero". Matrix
  // omits unread_notifications on deltas that don't change it (receipt-only
  // / ephemeral-only updates). Treating absent as 0 made every such delta
  // silently clear isUnread — that's how 22 unread rooms got lost from the
  // snapshot on 2026-06-08. Absent ⇒ no new unread information; preserve
  // the existing flags verbatim (see isUnread/unreadCount below).
  const notifInfoPresent = delta.unread_notifications !== undefined
  const serverNotifCount = delta.unread_notifications?.notification_count ?? 0
  const serverHighlightCount = delta.unread_notifications?.highlight_count ?? 0
  const hasNewMessages = !!lastMsg
  const hadMessages = !!existing?.lastMessageBody
  const newestMessageTime = lastMsg?.timestamp ?? 0
  const advancesPreview = newestMessageTime > (existing?.lastMessageTime ?? 0)
  const hasNewerMessagesFromOthers = existing
    ? advancesPreview && !!lastMsg && lastMsg.senderId !== ctx.myUserId
    : false
  const latestIsFromMe = lastMsg?.senderId === ctx.myUserId

  let lastMessageTime = advancesPreview ? newestMessageTime : (existing?.lastMessageTime ?? 0)
  if (lastMessageTime === 0 && timelineEvents.length > 0) {
    const latestTs = timelineEvents.reduce(
      (max, e) => Math.max(max, e.origin_server_ts ?? 0),
      0,
    )
    if (latestTs > 0) lastMessageTime = latestTs
  }

  const computedName = getRoomName(allStateForRoom, roomId, ctx.myUserId)
  const hasFullMembers = allStateForRoom.some((e) => e.type === 'm.room.create')
  const directRoom = hasFullMembers ? isDirect(allStateForRoom) : (existing?.isDirect ?? true)
  const computedAvatar = hasFullMembers
    ? getRoomAvatar(allStateForRoom, directRoom, ctx.myUserId)
    : undefined
  const explicitAvatarEvent = allStateForRoom.find(
    (e) => e.type === 'm.room.avatar' && e.state_key === '',
  )
  const hasExplicitName = allStateForRoom.some(
    (e) => (e.type === 'm.room.name' && e.state_key === '' && (e.content as any)?.name)
        || (e.type === 'm.room.canonical_alias' && e.state_key === '' && (e.content as any)?.alias),
  )

  // A manual "mark unread" is a sticky hub-only intent with no homeserver
  // backing. Carry it through every recompute and force isUnread true — the
  // server-notif-zero path below must never clear it (only an explicit
  // mark-read does, via ChatRoomsStore.setRoomRead).
  const manualUnread = existing?.manualUnread ?? false

  return {
    id: roomId,
    name: hasExplicitName ? computedName
      : (hasFullMembers && computedName !== roomId) ? computedName
      : existing?.name ? existing.name
      : computedName !== roomId ? computedName
      : roomId,
    avatar: hasFullMembers
      ? (computedAvatar ?? (directRoom ? existing?.avatar : undefined))
      : (explicitAvatarEvent?.content as any)?.url
        ? ((explicitAvatarEvent!.content as any).url as string)
        : existing?.avatar,
    isDirect: directRoom,
    memberCount: hasFullMembers ? getMemberCount(allStateForRoom) : (existing?.memberCount ?? 2),
    lastMessageBody: advancesPreview ? (lastMsg?.body ?? '') : (existing?.lastMessageBody ?? ''),
    lastMessageSender: advancesPreview ? (lastMsg?.senderName ?? '') : (existing?.lastMessageSender ?? ''),
    lastMessageTime,
    manualUnread: manualUnread || undefined,
    isUnread: manualUnread
      ? true
      : latestIsFromMe
      ? false
      : existing
        ? (!notifInfoPresent && !hasNewerMessagesFromOthers
          // No unread info on this delta and no new messages — this delta
          // carries nothing that should change read state. Preserve.
          ? existing.isUnread
          : (serverNotifCount === 0 && notifInfoPresent && !hasNewerMessagesFromOthers
            ? false // explicit zero — read on another client
            : (existing.isUnread || (roomIsLowPriority ? serverHighlightCount > 0 : hasNewerMessagesFromOthers))))
        : (roomIsLowPriority
          ? (serverHighlightCount > 0)
          : (serverNotifCount > 0 && (hasNewMessages || hadMessages || lastMessageTime > 0))),
    unreadCount: latestIsFromMe
      ? 0
      : existing
        ? (!notifInfoPresent && !hasNewerMessagesFromOthers
          ? existing.unreadCount // preserve — no new information
          : (serverNotifCount === 0 && notifInfoPresent && !hasNewerMessagesFromOthers
            ? 0
            : hasNewerMessagesFromOthers
              ? (existing.unreadCount ?? 0) + 1
              : existing.unreadCount))
        : serverNotifCount || undefined,
    lastReadEventId: existing?.lastReadEventId,
    lastReadTs: existing?.lastReadTs
      ?? (hasNewerMessagesFromOthers && existing?.lastMessageTime
        ? existing.lastMessageTime
        : undefined),
    isMuted: ctx.mutedRoomIds.has(roomId),
    isLowPriority: roomIsLowPriority,
    tags: tagNames,
    isEncrypted: isEncrypted || (existing?.isEncrypted ?? false),
    networkIcon: detectBridgeNetwork(allStateForRoom) ?? existing?.networkIcon,
    snoozedUntil: existing?.snoozedUntil,
    prevBatch: delta.timeline?.prev_batch ?? existing?.prevBatch,
    readReceipts: updatedReceipts,
  }
}
