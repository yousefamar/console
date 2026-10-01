import { memo, useCallback } from 'react'
import clsx from 'clsx'
import { relativeTime } from '@/utils/date'
import type { DbChatRoom } from '@/matrix/types'
import { Check, Clock, MessageCircle, Pin } from 'lucide-react'
import { FaWhatsapp, FaSlack, FaDiscord, FaInstagram, FaTelegram, FaLinkedin, FaFacebook, FaTwitter } from 'react-icons/fa'
import { SiGooglemessages, SiImessage, SiX, SiGooglechat, SiSignal } from 'react-icons/si'
import { mxcToThumbnail } from '@/matrix/api'
import { RoomContextMenu } from './RoomContextMenu'
import { SwipeableRow } from './SwipeableRow'
import { useIsMobile } from '@/hooks/useMediaQuery'
import { useChatStore } from '@/store/chat'

interface ChatRoomListItemProps {
  room: DbChatRoom
  isSelected: boolean
  onSelect: (id: string) => void
  snoozed?: boolean
}

// Network icon component — proper brand icons from react-icons (monochrome via currentColor)
const NETWORK_ICONS: Record<string, React.ComponentType<{ size?: number }>> = {
  whatsapp: FaWhatsapp,
  slack: FaSlack,
  discord: FaDiscord,
  instagram: FaInstagram,
  signal: SiSignal,
  telegram: FaTelegram,
  linkedin: FaLinkedin,
  facebook: FaFacebook,
  twitter: FaTwitter,
  googlechat: SiGooglechat,
  gmessages: SiGooglemessages,
  imessage: SiImessage,
}

export function NetworkIcon({ network }: { network: string }) {
  // X (formerly Twitter) uses Simple Icons
  if (network === 'twitter') {
    const Icon = SiX
    return <Icon size={10} />
  }
  const Icon = NETWORK_ICONS[network]
  if (!Icon) return null
  return <Icon size={10} />
}

function ChatRoomListItemInner({ room, isSelected, onSelect, snoozed }: ChatRoomListItemProps) {
  const avatarUrl = room.avatar ? mxcToThumbnail(room.avatar, 32, 32) : undefined
  const isMobile = useIsMobile()

  const handleMarkRead = useCallback(() => {
    useChatStore.getState().markRoomRead(room.id)
  }, [room.id])

  const button = (
    <button
      onClick={() => onSelect(room.id)}
      className={clsx(
        'flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors duration-fast border-b border-border bg-surface-0',
        snoozed && 'opacity-50',
        isSelected
          ? 'bg-surface-2'
          : 'hover:bg-surface-1',
      )}
    >
      {/* Avatar */}
      <div className="relative flex-shrink-0 mt-0.5">
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt=""
            className="h-7 w-7 rounded-full object-cover"
          />
        ) : (
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-surface-2 text-text-tertiary">
            <MessageCircle size={14} />
          </div>
        )}
        {room.networkIcon && (
          <span className="absolute -bottom-1 -right-1 flex items-center justify-center rounded-full bg-surface-0 p-[2px] text-text-tertiary border border-border">
            <NetworkIcon network={room.networkIcon} />
          </span>
        )}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm text-text-secondary">
            {room.name}
          </span>
          <span className="flex items-center gap-1 flex-shrink-0 text-xs text-text-tertiary">
            {room.tags?.includes('m.favourite') && <Pin size={10} className="opacity-40" />}
            {snoozed && <Clock size={10} />}
            {snoozed ? relativeTime(room.snoozedUntil!) : relativeTime(room.lastMessageTime)}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <span className="truncate text-xs text-text-tertiary flex-1">
            {room.draft ? (
              <>
                <span className="text-amber-500">Draft: </span>
                {room.draft}
              </>
            ) : (
              <>
                {room.lastMessageSender && (
                  <span className="text-text-tertiary">{room.lastMessageSender}: </span>
                )}
                {room.lastMessageBody}
              </>
            )}
          </span>
          {room.unreadCount && room.unreadCount > 0 ? (
            <span className="flex-shrink-0 text-[10px] text-blue-500 font-medium tabular-nums">
              {room.unreadCount > 99 ? '99+' : room.unreadCount}
            </span>
          ) : null}
        </div>
      </div>
    </button>
  )

  const content = isMobile && !snoozed ? (
    <SwipeableRow
      right={{
        icon: <Check size={20} className="text-green-500" />,
        color: '34, 197, 94',
        onTrigger: handleMarkRead,
      }}
    >
      {button}
    </SwipeableRow>
  ) : button

  return <RoomContextMenu room={room}>{content}</RoomContextMenu>
}

export const ChatRoomListItem = memo(ChatRoomListItemInner)
