// Pinned chats (Matrix `m.favourite` rooms) as an avatar-only strip at the
// top of the Inbox column — the Chat pane's pinned section, compressed to
// one row so it costs the list a single line of height. Unread rooms still
// appear as normal rows below; the strip is for reaching a favourite whether
// or not it has anything new.

import { memo, useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { MessageCircle } from 'lucide-react'
import clsx from 'clsx'
import { db } from '@/db'
import { mxcToThumbnail } from '@/matrix/api'
import { roomToItem } from '@/inbox/route'
import { useUnifiedInboxStore } from '@/store/unified-inbox'
import { NetworkIcon } from './ChatRoomListItem'
import type { DbChatRoom } from '@/matrix/types'

export const InboxPinnedChats = memo(function InboxPinnedChats() {
  const rooms = useLiveQuery(
    () => db.chatRooms.filter((r) => r.tags?.includes('m.favourite') ?? false).toArray(),
    [],
  )
  const selectedKey = useUnifiedInboxStore((s) => s.selected?.key ?? null)
  // Alphabetical like the Chat pane — a stable order so the row you reach for
  // is where it was last time, unread or not.
  const sorted = useMemo(() => [...(rooms ?? [])].sort((a, b) => a.name.localeCompare(b.name)), [rooms])
  if (sorted.length === 0) return null

  const open = (room: DbChatRoom) => {
    const s = useUnifiedInboxStore.getState()
    s.select(roomToItem(room, s.rules, Date.now()))
  }

  return (
    <div className="flex gap-2 overflow-x-auto border-b border-border px-3 py-1.5 [scrollbar-width:none]">
      {sorted.map((room) => (
        <PinnedAvatar key={room.id} room={room} selected={`chat:${room.id}` === selectedKey} onClick={() => open(room)} />
      ))}
    </div>
  )
})

function PinnedAvatar({ room, selected, onClick }: { room: DbChatRoom; selected: boolean; onClick: () => void }) {
  const avatarUrl = room.avatar ? mxcToThumbnail(room.avatar, 64, 64) : undefined
  const unread = room.isUnread && !room.snoozedUntil
  const count = room.unreadCount ?? 0
  return (
    <button
      onClick={onClick}
      className={clsx(
        'relative flex-shrink-0 rounded-full transition-opacity duration-fast',
        selected ? 'ring-2 ring-text-tertiary ring-offset-1 ring-offset-surface-0' : 'hover:opacity-80',
        !unread && !selected && 'opacity-60',
      )}
      title={room.name}
    >
      {avatarUrl ? (
        <img src={avatarUrl} alt="" className="h-8 w-8 rounded-full object-cover" />
      ) : (
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-2 text-text-tertiary">
          <MessageCircle size={14} />
        </span>
      )}
      {room.networkIcon && (
        <span className="absolute -bottom-0.5 -right-0.5 flex items-center justify-center rounded-full bg-surface-0 p-[2px] text-text-tertiary border border-border">
          <NetworkIcon network={room.networkIcon} />
        </span>
      )}
      {unread && (
        <span className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-blue-500 px-0.5 text-[9px] font-medium leading-none text-white tabular-nums">
          {count > 99 ? '99+' : count > 0 ? count : ''}
        </span>
      )}
    </button>
  )
}
