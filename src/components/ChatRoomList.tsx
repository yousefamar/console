import { useEffect, useMemo, useRef } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useChatStore } from '@/store/chat'
import { useIsMobile } from '@/hooks/useMediaQuery'
import { ChatRoomListItem } from './ChatRoomListItem'
import { db } from '@/db'
import type { DbChatRoom } from '@/matrix/types'

function isFavourite(room: DbChatRoom) {
  return room.tags?.includes('m.favourite') ?? false
}

export function ChatRoomList() {
  const selectedRoomId = useChatStore((s) => s.selectedRoomId)
  const selectRoom = useChatStore((s) => s.selectRoom)
  const listRef = useRef<HTMLDivElement>(null)
  const isMobile = useIsMobile()

  // Live query for chat rooms — drives the chat store
  const liveChatRooms = useLiveQuery(
    () =>
      db.chatRooms
        .filter((r) => {
          const isFav = r.tags?.includes('m.favourite') ?? false
          if (isFav) return true
          return r.isUnread && !r.snoozedUntil && !r.isLowPriority
        })
        .reverse()
        .sortBy('lastMessageTime'),
    [],
  )

  // Split into pinned + inbox, then set store in visual order so j/k navigation matches
  const pinnedRooms = useMemo(() =>
    (liveChatRooms ?? []).filter(isFavourite).sort((a, b) => a.name.localeCompare(b.name)),
    [liveChatRooms],
  )
  const inboxRooms = useMemo(() =>
    (liveChatRooms ?? []).filter((r) => r.isUnread && !r.snoozedUntil && !isFavourite(r)),
    [liveChatRooms],
  )

  useEffect(() => {
    if (liveChatRooms) {
      useChatStore.getState().setRooms([...pinnedRooms, ...inboxRooms])
    }
  }, [liveChatRooms, pinnedRooms, inboxRooms])

  // Auto-select first room if none selected (desktop only)
  useEffect(() => {
    if (!isMobile && !selectedRoomId && liveChatRooms && liveChatRooms.length > 0) {
      // Prefer first inbox room, fall back to first pinned
      const first = inboxRooms[0] ?? pinnedRooms[0]
      if (first) selectRoom(first.id)
    }
  }, [liveChatRooms, selectedRoomId, selectRoom, isMobile, inboxRooms, pinnedRooms])

  // Scroll selected room into view
  useEffect(() => {
    if (!selectedRoomId || !listRef.current) return
    const el = listRef.current.querySelector(`[data-room-id="${selectedRoomId}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedRoomId])

  if (!liveChatRooms || liveChatRooms.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <p className="text-xs text-text-tertiary">No unread chats</p>
      </div>
    )
  }

  return (
    <div ref={listRef} className="h-full overflow-y-auto">
      {/* Pinned favourites — always visible */}
      {pinnedRooms.map((room) => (
        <div key={room.id} data-room-id={room.id}>
          <ChatRoomListItem
            room={room}
            isSelected={room.id === selectedRoomId}
            onSelect={selectRoom}
          />
        </div>
      ))}

      {/* Divider between pinned and inbox */}
      {pinnedRooms.length > 0 && inboxRooms.length > 0 && (
        <div className="flex items-center gap-2 px-3 py-1.5">
          <div className="flex-1 border-t border-border" />
          <span className="text-[10px] text-text-tertiary uppercase tracking-wider">Inbox</span>
          <div className="flex-1 border-t border-border" />
        </div>
      )}

      {/* Inbox rooms */}
      {inboxRooms.map((room) => (
        <div key={room.id} data-room-id={room.id}>
          <ChatRoomListItem
            room={room}
            isSelected={room.id === selectedRoomId}
            onSelect={selectRoom}
          />
        </div>
      ))}

      {inboxRooms.length === 0 && (
        <div className="flex h-32 items-center justify-center">
          <p className="text-xs text-text-tertiary">No unread chats</p>
        </div>
      )}
    </div>
  )
}
