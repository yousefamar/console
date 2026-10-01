// Right-click / long-press menu for a chat ROOM — Pin, Mute, Demote, Reload.
// One definition for every surface that lists rooms (the Chat pane's room
// list, the Inbox column's chat rows, the pinned-avatar strip), so the menus
// can't drift apart.

import { useCallback, useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db'
import { getRoomState, setRoomTag, removeRoomTag, setRoomMuted } from '@/matrix/api'
import type { DbChatRoom } from '@/matrix/types'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'

const NO_ITEMS: ContextMenuItem[] = []

/** `room` may be undefined while a by-id lookup is still resolving — the
 *  menu is simply empty (ContextMenu lets the native one through). */
export function useRoomMenuItems(room: DbChatRoom | undefined): ContextMenuItem[] {
  const roomId = room?.id ?? ''
  const tags = room?.tags
  const isPinned = tags?.includes('m.favourite') ?? false
  const isLow = room?.isLowPriority ?? false
  const isMuted = room?.isMuted ?? false

  const handleReload = useCallback(async () => {
    // Delete everything EXCEPT deleted messages that still carry a body.
    // Their text is irreplaceable — the server stripped the content on
    // redaction, so re-pagination returns only an empty tombstone. Blindly
    // wiping them turns recoverable struck-through text into "Message
    // deleted" permanently (the bug that ate Katie's "back garden" message).
    const stale = await db.chatMessages
      .where('roomId').equals(roomId)
      .filter((m) => !(m.isDeleted && !!m.body))
      .primaryKeys()
    await db.chatMessages.bulkDelete(stale as string[])
    await db.chatRooms.update(roomId, { prevBatch: undefined })
    try {
      const state = await getRoomState(roomId)
      const nameEvent = state.find((e) => e.type === 'm.room.name' && e.state_key === '')
      if (nameEvent?.content?.name) {
        await db.chatRooms.update(roomId, { name: nameEvent.content.name as string })
      }
    } catch { /* best effort */ }
    const { useChatStore } = await import('@/store/chat')
    await useChatStore.getState().ensureMessages(roomId)
  }, [roomId])

  // Optimistic tag/mute toggles — flip the local IDB row immediately so the
  // UI reacts without waiting for the round-trip, then fire the hub call.
  // Matrix sync replays account_data / push_rules back authoritatively
  // within the next tick, so any divergence is self-healing.
  const togglePin = useCallback(async () => {
    const next = !isPinned
    const nextTags = next
      ? Array.from(new Set([...(tags ?? []), 'm.favourite']))
      : (tags ?? []).filter((t) => t !== 'm.favourite')
    await db.chatRooms.update(roomId, { tags: nextTags })
    try {
      if (next) await setRoomTag(roomId, 'm.favourite')
      else await removeRoomTag(roomId, 'm.favourite')
    } catch { /* sync will reconcile */ }
  }, [isPinned, roomId, tags])

  const toggleLowPriority = useCallback(async () => {
    const next = !isLow
    const baseTags = (tags ?? []).filter((t) => t !== 'm.lowpriority')
    const nextTags = next ? [...baseTags, 'm.lowpriority'] : baseTags
    await db.chatRooms.update(roomId, { tags: nextTags, isLowPriority: next })
    try {
      if (next) await setRoomTag(roomId, 'm.lowpriority')
      else await removeRoomTag(roomId, 'm.lowpriority')
    } catch { /* sync will reconcile */ }
  }, [isLow, roomId, tags])

  const toggleMute = useCallback(async () => {
    const next = !isMuted
    await db.chatRooms.update(roomId, { isMuted: next })
    try {
      await setRoomMuted(roomId, next)
    } catch { /* sync will reconcile */ }
  }, [isMuted, roomId])

  const hasRoom = !!room
  return useMemo<ContextMenuItem[]>(() => hasRoom ? [
    { label: isPinned ? 'Unpin' : 'Pin', onClick: togglePin },
    { label: isMuted ? 'Unmute' : 'Mute', onClick: toggleMute },
    { label: isLow ? 'Restore to inbox' : 'Demote to low priority', onClick: toggleLowPriority },
    { label: 'Reload room', onClick: handleReload },
  ] : NO_ITEMS, [hasRoom, isPinned, isMuted, isLow, togglePin, toggleMute, toggleLowPriority, handleReload])
}

export function RoomContextMenu({ room, children, className }: { room: DbChatRoom; children: React.ReactNode; className?: string }) {
  const items = useRoomMenuItems(room)
  return <ContextMenu items={items} className={className}>{children}</ContextMenu>
}

/** Same menu for a surface that only knows the room ID (the Inbox's rows
 *  carry an InboxItem, not the room). Resolves the row from Dexie by key, so
 *  only a write to THIS room re-runs it. */
export function RoomIdContextMenu({ roomId, children, className }: { roomId: string; children: React.ReactNode; className?: string }) {
  const room = useLiveQuery(() => db.chatRooms.get(roomId), [roomId])
  const items = useRoomMenuItems(room)
  return <ContextMenu items={items} className={className}>{children}</ContextMenu>
}
