import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useChatStore } from '@/store/chat'
import { useIsMobile } from '@/hooks/useMediaQuery'
import { ChatRoomListItem } from './ChatRoomListItem'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { mxcToThumbnail, getRoomState } from '@/matrix/api'
import { db } from '@/db'
import clsx from 'clsx'
import type { DbChatRoom } from '@/matrix/types'

function isFavourite(room: DbChatRoom) {
  return room.tags?.includes('m.favourite') ?? false
}

function PinnedAvatarInner({ room, isSelected, onSelect, roomId }: { room: DbChatRoom; isSelected: boolean; onSelect: (id: string) => void; roomId: string }) {
  const avatarUrl = room.avatar ? mxcToThumbnail(room.avatar, 40, 40) : undefined
  const initial = room.name.charAt(0).toUpperCase()
  const hasUnread = room.isUnread
  const [imgError, setImgError] = useState(false)

  const handleReload = useCallback(async () => {
    await db.chatMessages.where('roomId').equals(room.id).delete()
    await db.chatRooms.update(room.id, { prevBatch: undefined })
    try {
      const state = await getRoomState(room.id)
      const nameEvent = state.find((e) => e.type === 'm.room.name' && e.state_key === '')
      if (nameEvent?.content?.name) {
        await db.chatRooms.update(room.id, { name: nameEvent.content.name as string })
      }
    } catch { /* best effort */ }
    const { useChatStore } = await import('@/store/chat')
    await useChatStore.getState().ensureMessages(room.id)
  }, [room.id])

  const menuItems = useMemo<ContextMenuItem[]>(() => [
    { label: 'Reload room', onClick: handleReload },
  ], [handleReload])

  return (
    <ContextMenu items={menuItems}>
    <button
      onClick={() => onSelect(roomId)}
      title={room.name}
      className={clsx(
        'relative flex flex-col items-center gap-0.5 w-14',
        isSelected && 'opacity-100',
        !isSelected && 'opacity-70 hover:opacity-100',
      )}
    >
      <div className={clsx(
        'relative h-10 w-10 rounded-full overflow-hidden ring-2 transition-all duration-fast',
        isSelected ? 'ring-text-secondary' : 'ring-transparent',
      )}>
        {avatarUrl && !imgError ? (
          <img src={avatarUrl} alt="" className="h-full w-full object-cover" onError={() => setImgError(true)} />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-surface-2 text-sm font-medium text-text-tertiary">
            {initial}
          </div>
        )}
      </div>
      {hasUnread && (
        <div className="absolute top-0 right-1 h-2.5 w-2.5 rounded-full bg-blue-500 border-2 border-surface-0" />
      )}
      <span className="text-[10px] text-text-tertiary truncate w-full text-center leading-tight">
        {room.name}
      </span>
    </button>
    </ContextMenu>
  )
}

const PinnedAvatar = memo(PinnedAvatarInner)

export function ChatRoomList() {
  const rooms = useChatStore((s) => s.rooms)
  const selectedRoomId = useChatStore((s) => s.selectedRoomId)
  const selectRoom = useChatStore((s) => s.selectRoom)
  const listRef = useRef<HTMLDivElement>(null)
  const isMobile = useIsMobile()

  const pinnedRooms = useMemo(() => rooms.filter(isFavourite).sort((a, b) => a.name.localeCompare(b.name)), [rooms])
  const inboxRooms = useMemo(() => rooms.filter((r) => r.isUnread && !r.snoozedUntil), [rooms])

  // Auto-select first room if none selected (desktop only)
  useEffect(() => {
    if (!isMobile && !selectedRoomId && rooms.length > 0) {
      // Prefer first inbox room, fall back to first pinned
      const first = inboxRooms[0] ?? pinnedRooms[0]
      if (first) selectRoom(first.id)
    }
  }, [rooms, selectedRoomId, selectRoom, isMobile])

  // Scroll selected room into view
  useEffect(() => {
    if (!selectedRoomId || !listRef.current) return
    const el = listRef.current.querySelector(`[data-room-id="${selectedRoomId}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedRoomId])

  if (rooms.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <p className="text-xs text-text-tertiary">No unread chats</p>
      </div>
    )
  }

  return (
    <div ref={listRef} className="h-full overflow-y-auto">
      {/* Pinned favourites — always visible */}
      {pinnedRooms.length > 0 && (
        <div className="flex flex-wrap justify-start gap-x-2 gap-y-1 px-3 py-2 border-b border-border">
          {pinnedRooms.map((room) => (
            <PinnedAvatar
              key={room.id}
              room={room}
              roomId={room.id}
              isSelected={room.id === selectedRoomId}
              onSelect={selectRoom}
            />
          ))}
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
