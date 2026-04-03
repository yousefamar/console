import { useEffect, useRef, useCallback, useState, useMemo, memo } from 'react'
import { liveQuery } from 'dexie'
import { db } from '@/db'
import { useChatStore } from '@/store/chat'
import { ChatMessageBubble, type ReadReceiptEntry } from './ChatMessageBubble'
import { ChatComposeInput } from './ChatComposeInput'
import { InboxZero } from './InboxZero'
import { ImageLightbox } from './ImageLightbox'
import type { DbChatMessage, DbChatRoom } from '@/matrix/types'

export function ChatRoomView() {
  const selectedRoomId = useChatStore((s) => s.selectedRoomId)
  const rooms = useChatStore((s) => s.rooms)
  const setReplyingTo = useChatStore((s) => s.setReplyingTo)
  const sendReaction = useChatStore((s) => s.sendReaction)
  const matrixUserId = localStorage.getItem('matrix_user_id') ?? ''
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)

  const handleReply = useCallback((msg: DbChatMessage) => {
    setReplyingTo(msg)
  }, [setReplyingTo])

  const handleReact = useCallback((msg: DbChatMessage, emoji: string) => {
    sendReaction(msg.roomId, msg.id, emoji)
  }, [sendReaction])

  // Stable DOM order: sort by id so rooms.map() never reorders DOM nodes.
  // Reordering absolutely-positioned scrollable divs causes Chrome to reset scrollTop.
  const sortedRooms = useMemo(
    () => [...rooms].sort((a, b) => a.id.localeCompare(b.id)),
    [rooms],
  )

  // Stable reference to avoid re-renders of all RoomMessages on every store update
  const loadOlderMessages = useCallback(
    (roomId: string) => useChatStore.getState().loadOlderMessages(roomId),
    [],
  )

  if (rooms.length === 0) {
    return <InboxZero />
  }

  if (!selectedRoomId) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-text-tertiary">Select a chat</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Room headers — only selected visible */}
      {sortedRooms.map((room) => (
        <div
          key={`header-${room.id}`}
          style={{ display: room.id === selectedRoomId ? 'flex' : 'none' }}
          className="items-center justify-between border-b border-border px-3 md:px-4 py-2"
        >
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base md:text-lg font-medium text-text-primary">
              {room.name}
            </h2>
            {room.memberCount > 2 && (
              <span className="text-xs text-text-tertiary">{room.memberCount} members</span>
            )}
          </div>
          {room.networkIcon && (
            <span className="text-xs text-text-tertiary uppercase tracking-wider">
              {room.networkIcon}
            </span>
          )}
        </div>
      ))}

      {/* All room message groups — always mounted, display toggled */}
      <div className="flex-1 overflow-hidden relative">
        {sortedRooms.map((room) => (
          <RoomMessages
            key={room.id}
            roomId={room.id}
            isVisible={room.id === selectedRoomId}
            matrixUserId={matrixUserId}
            lastReadTs={room.lastReadTs}
            readReceipts={room.readReceipts}
            onLoadOlder={loadOlderMessages}
            onImageClick={setLightboxSrc}
            onReply={handleReply}
            onReact={handleReact}
          />
        ))}
      </div>

      {/* Compose input — only for selected */}
      {selectedRoomId && <ChatComposeInput roomId={selectedRoomId} />}

      {/* Image lightbox */}
      {lightboxSrc && (
        <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
      )}
    </div>
  )
}

const RoomMessages = memo(function RoomMessages({
  roomId,
  isVisible,
  matrixUserId,
  lastReadTs,
  readReceipts,
  onLoadOlder,
  onImageClick,
  onReply,
  onReact,
}: {
  roomId: string
  isVisible: boolean
  matrixUserId: string
  lastReadTs?: number
  readReceipts?: DbChatRoom['readReceipts']
  onLoadOlder: (roomId: string) => Promise<boolean>
  onImageClick: (src: string) => void
  onReply: (msg: DbChatMessage) => void
  onReact: (msg: DbChatMessage, emoji: string) => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const didInitialScroll = useRef(false)
  const isLoadingOlder = useRef(false)
  const prevMessageCount = useRef(0)
  const [showLoadingOlder, setShowLoadingOlder] = useState(false)

  // Group read receipts by eventId for efficient lookup per message
  const receiptsByEventId = useMemo(() => {
    if (!readReceipts) return {}
    const groups: Record<string, ReadReceiptEntry[]> = {}
    for (const [userId, receipt] of Object.entries(readReceipts)) {
      const list = groups[receipt.eventId] ?? []
      list.push({ userId, displayName: receipt.displayName, avatar: receipt.avatar, ts: receipt.ts })
      groups[receipt.eventId] = list
    }
    return groups
  }, [readReceipts])

  // Manual liveQuery observable: ref always current, state only updates when visible.
  // This avoids 30 React re-renders on every Matrix sync — only the visible room re-renders.
  const messagesRef = useRef<DbChatMessage[]>([])
  const [messages, setMessages] = useState<DbChatMessage[]>([])
  const isVisibleRef = useRef(isVisible)
  isVisibleRef.current = isVisible

  useEffect(() => {
    const sub = liveQuery(
      () => db.chatMessages.where('roomId').equals(roomId).sortBy('timestamp')
    ).subscribe(msgs => {
      messagesRef.current = msgs
      if (isVisibleRef.current) setMessages(msgs)
    })
    return () => sub.unsubscribe()
  }, [roomId])

  // When becoming visible, flush ref to state immediately (instant switch, no loading flash)
  useEffect(() => {
    if (isVisible && messagesRef.current.length > 0) {
      setMessages(messagesRef.current)
    }
  }, [isVisible])

  // Check if user is scrolled near the bottom
  const isNearBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return true
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }, [])

  // Scroll to bottom (or unread divider) only on first render of a room
  useEffect(() => {
    if (!isVisible || !scrollRef.current || messages.length === 0) return
    if (didInitialScroll.current) return
    didInitialScroll.current = true

    const el = scrollRef.current
    if (lastReadTs) {
      requestAnimationFrame(() => {
        const divider = el.querySelector('[data-unread-divider]')
        if (divider) {
          divider.scrollIntoView({ block: 'center' })
        } else {
          el.scrollTop = el.scrollHeight
        }
      })
    } else {
      el.scrollTop = el.scrollHeight
    }
  }, [isVisible, messages, lastReadTs])

  // Auto-scroll on new messages: always if own message, only if near bottom for others
  useEffect(() => {
    if (!isVisible || !scrollRef.current || !didInitialScroll.current) return
    if (messages.length <= prevMessageCount.current) {
      prevMessageCount.current = messages.length
      return
    }
    const newMessages = messages.slice(prevMessageCount.current)
    prevMessageCount.current = messages.length

    const hasOwnMessage = newMessages.some((m) => m.senderId === matrixUserId || m.id.startsWith('~'))
    if (hasOwnMessage || isNearBottom()) {
      requestAnimationFrame(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      })
    }
  }, [isVisible, messages, matrixUserId, isNearBottom])

  // Reset when room hides
  useEffect(() => {
    if (!isVisible) {
      didInitialScroll.current = false
      prevMessageCount.current = 0
    }
  }, [isVisible])

  // Auto-load older messages when content doesn't fill the container
  useEffect(() => {
    if (!isVisible || !scrollRef.current || isLoadingOlder.current) return
    if (messages.length === 0) return
    const el = scrollRef.current
    if (el.scrollHeight <= el.clientHeight) {
      isLoadingOlder.current = true
      setShowLoadingOlder(true)
      onLoadOlder(roomId).then(() => {
        isLoadingOlder.current = false
        setShowLoadingOlder(false)
      })
    }
  }, [isVisible, messages, roomId, onLoadOlder])

  const handleScroll = useCallback(async () => {
    if (!scrollRef.current || isLoadingOlder.current) return
    const el = scrollRef.current
    if (el.scrollTop < 100) {
      isLoadingOlder.current = true
      setShowLoadingOlder(true)
      const prevHeight = el.scrollHeight
      const hasMore = await onLoadOlder(roomId)
      if (hasMore && scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight - prevHeight
      }
      isLoadingOlder.current = false
      setShowLoadingOlder(false)
    }
  }, [roomId, onLoadOlder])

  return (
    <div
      ref={scrollRef}
      className="absolute inset-0 overflow-y-auto py-2"
      style={{ display: isVisible ? 'block' : 'none' }}
      onScroll={handleScroll}
    >
      {showLoadingOlder && (
        <div className="flex items-center justify-center py-2">
          <span className="text-[10px] text-text-tertiary">Loading…</span>
        </div>
      )}
      {messages.length === 0 && !showLoadingOlder ? (
        <div className="flex h-32 items-center justify-center">
          <p className="text-sm text-text-tertiary">No messages yet</p>
        </div>
      ) : (
        messages.map((msg, i) => {
          const prevMsg = i > 0 ? messages[i - 1] : null
          const showSender = !prevMsg || prevMsg.senderId !== msg.senderId ||
            msg.timestamp - prevMsg.timestamp > 5 * 60 * 1000
          const showUnreadDivider = lastReadTs &&
            prevMsg && prevMsg.timestamp <= lastReadTs &&
            msg.timestamp > lastReadTs &&
            msg.senderId !== matrixUserId
          return (
            <div key={msg.id}>
              {showUnreadDivider && (
                <div data-unread-divider className="flex items-center gap-3 px-3 my-2">
                  <div className="flex-1 border-t border-red-500/60" />
                  <span className="text-[10px] font-medium text-red-400 uppercase tracking-wider">New</span>
                  <div className="flex-1 border-t border-red-500/60" />
                </div>
              )}
              <ChatMessageBubble
                message={msg}
                isOwn={msg.senderId === matrixUserId}
                showSender={showSender}
                receipts={receiptsByEventId[msg.id]}
                onImageClick={onImageClick}
                onReply={onReply}
                onReact={onReact}
              />
            </div>
          )
        })
      )}
    </div>
  )
})
