// Chat pane renderer.
//
// Body layout:
//   row 2-4: last 3 messages in the selected room, oldest→newest.
//            `<sender>: <body>` clipped to 40; empty rows top-padding.
//   row 5  : composer echo (what the user is typing on the phone).
//
// Messages are pulled from Dexie (live cache); the renderer is
// synchronous so we read from an in-memory tail that `mirror.ts`
// maintains — but keeping this renderer simple for now, we read the
// most recent from the chat store's view-model.

import { useChatStore } from '@/store/chat'
import { useGlassesStore } from '../store'
import { buildStatus, clipRow, composerRow, scheduleFrame, type MirrorFrame } from '../mirror'
import { db } from '@/db'

// Cache the last-fetched tail so renders between Dexie queries still have
// something to show. Updated by `refreshChatTail()`.
let tailCache: { roomId: string; messages: { senderName: string; body: string }[] } | null = null
let inFlight = false

function refreshChatTail(roomId: string) {
  if (inFlight) return
  inFlight = true
  ;(async () => {
    try {
      const rows = await db.chatMessages
        .where('roomId')
        .equals(roomId)
        .reverse()
        .limit(12) // over-fetch; filter tombstones + images, take last 3
        .toArray()
      const ordered = rows.reverse()
      const visible = ordered
        .filter((m) => !m.isDeleted && (m.type === 'text' || m.type === 'image'))
        .slice(-3)
        .map((m) => ({
          senderName: m.senderName || 'unknown',
          body: m.type === 'image' ? '[image]' : (m.body || ''),
        }))
      tailCache = { roomId, messages: visible }
      // Trigger a re-render now that the async data is ready.
      scheduleFrame()
    } finally {
      inFlight = false
    }
  })()
}

function shortName(name: string): string {
  // Strip matrix userIds to the local-part for readability.
  if (name.startsWith('@')) return name.split(':')[0]!.slice(1)
  return name
}

function renderMessageRow(senderName: string, body: string): string {
  const who = shortName(senderName)
  // Trim body of newlines — we only get one row.
  const flat = body.replace(/\s+/g, ' ').trim()
  return clipRow(`${who}: ${flat}`)
}

export function renderChat(): MirrorFrame | null {
  const roomId = useChatStore.getState().selectedRoomId
  const rooms = useChatStore.getState().rooms
  const composer = useGlassesStore.getState().composerText.chat

  if (!roomId) {
    return {
      status: buildStatus(['Chat', 'no room selected']),
      body: [],
    }
  }

  const room = rooms.find((r) => r.id === roomId)
  const name = room?.name || roomId
  const unread = room?.unreadCount ?? 0

  // Kick off a background refresh if we don't have a cached tail for this room.
  if (!tailCache || tailCache.roomId !== roomId) {
    refreshChatTail(roomId)
  }

  const msgs = tailCache && tailCache.roomId === roomId ? tailCache.messages : []
  const body = msgs.map((m) => renderMessageRow(m.senderName, m.body))
  body.push(composerRow(composer ?? ''))

  return {
    status: buildStatus(['Chat', name, unread > 0 ? `${unread}u` : null]),
    body,
  }
}

/** Called by the chat store subscription when messages change in the active
 *  room so the cached tail stays fresh. */
export function invalidateChatTail() {
  tailCache = null
}
