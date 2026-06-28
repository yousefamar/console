import { useEffect, useRef, useCallback, useState, useMemo, memo } from 'react'
import { liveQuery } from 'dexie'
import { db } from '@/db'
import { useChatStore } from '@/store/chat'
import { ChatMessageBubble, type ReadReceiptEntry } from './ChatMessageBubble'
import { ChatComposeInput } from './ChatComposeInput'
import { InboxZero } from './InboxZero'
import { ImageLightbox } from './ImageLightbox'
import { PdfLightbox } from './PdfLightbox'
import { ChevronDown, ExternalLink } from 'lucide-react'
import { FaLinkedin } from 'react-icons/fa'
import { getHubUrl } from '@/hub'
import type { DbChatMessage, DbChatRoom } from '@/matrix/types'

export function ChatRoomView() {
  const selectedRoomId = useChatStore((s) => s.selectedRoomId)
  const rooms = useChatStore((s) => s.rooms)
  const setReplyingTo = useChatStore((s) => s.setReplyingTo)
  const sendReaction = useChatStore((s) => s.sendReaction)
  const setEditingMessage = useChatStore((s) => s.setEditingMessage)
  const matrixUserId = localStorage.getItem('matrix_user_id') ?? ''
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  const [pdfLightbox, setPdfLightbox] = useState<{ src: string; filename: string } | null>(null)
  // External "open profile" link per room (e.g. LinkedIn), fetched lazily
  // from the hub /info endpoint when a room is selected. Cached by roomId so
  // re-selecting doesn't refetch.
  const [externalProfiles, setExternalProfiles] = useState<Record<string, { network: string; url: string }>>({})

  useEffect(() => {
    if (!selectedRoomId || externalProfiles[selectedRoomId]) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`${getHubUrl()}/matrix/rooms/${encodeURIComponent(selectedRoomId)}/info`)
        if (!res.ok) return
        const data = await res.json() as { externalProfile?: { network: string; url: string } }
        if (!cancelled && data.externalProfile) {
          setExternalProfiles((prev) => ({ ...prev, [selectedRoomId]: data.externalProfile! }))
        }
      } catch { /* no profile link — header just omits the icon */ }
    })()
    return () => { cancelled = true }
  }, [selectedRoomId, externalProfiles])

  const handleReply = useCallback((msg: DbChatMessage) => {
    setReplyingTo(msg)
  }, [setReplyingTo])

  const handleReact = useCallback((msg: DbChatMessage, emoji: string) => {
    sendReaction(msg.roomId, msg.id, emoji)
  }, [sendReaction])

  const handleEdit = useCallback((msg: DbChatMessage) => {
    setEditingMessage(msg)
  }, [setEditingMessage])

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
          <div className="flex items-center gap-2.5 flex-shrink-0">
            {externalProfiles[room.id] && (
              <a
                href={externalProfiles[room.id]!.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-text-tertiary hover:text-text-primary transition-colors"
                title={`Open ${externalProfiles[room.id]!.network} profile`}
              >
                {externalProfiles[room.id]!.network === 'linkedin'
                  ? <FaLinkedin size={16} />
                  : <ExternalLink size={15} />}
              </a>
            )}
            {room.networkIcon && (
              <span className="text-xs text-text-tertiary uppercase tracking-wider">
                {room.networkIcon}
              </span>
            )}
          </div>
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
            onPdfClick={(src, filename) => setPdfLightbox({ src, filename })}
            onReply={handleReply}
            onReact={handleReact}
            onEdit={handleEdit}
          />
        ))}
      </div>

      {/* Compose input — only for selected */}
      {selectedRoomId && <ChatComposeInput roomId={selectedRoomId} />}

      {/* Image lightbox */}
      {lightboxSrc && (
        <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
      )}

      {/* PDF lightbox */}
      {pdfLightbox && (
        <PdfLightbox
          src={pdfLightbox.src}
          filename={pdfLightbox.filename}
          onClose={() => setPdfLightbox(null)}
        />
      )}
    </div>
  )
}

// Mount cap per room. Tuned so 20 pre-rendered rooms hold ~600 bubbles in
// the DOM rather than the unbounded ~2.5K we used to. Scroll-up grows the
// window in WINDOW_STEP increments — first into the local IDB cache, then
// out to the homeserver via onLoadOlder.
const INITIAL_WINDOW = 30
const WINDOW_STEP = 30

const RoomMessages = memo(function RoomMessages({
  roomId,
  isVisible,
  matrixUserId,
  lastReadTs,
  readReceipts,
  onLoadOlder,
  onImageClick,
  onPdfClick,
  onReply,
  onReact,
  onEdit,
}: {
  roomId: string
  isVisible: boolean
  matrixUserId: string
  lastReadTs?: number
  readReceipts?: DbChatRoom['readReceipts']
  onLoadOlder: (roomId: string) => Promise<boolean>
  onImageClick: (src: string) => void
  onPdfClick: (src: string, filename: string) => void
  onReply: (msg: DbChatMessage) => void
  onReact: (msg: DbChatMessage, emoji: string) => void
  onEdit: (msg: DbChatMessage) => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const didInitialScroll = useRef(false)
  const isLoadingOlder = useRef(false)
  const prevMessageCount = useRef(0)
  const [showLoadingOlder, setShowLoadingOlder] = useState(false)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)

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

  // Bounded window of mounted bubbles. Capped per room so 20+ pre-rendered
  // rooms don't drag down the main thread — Matrix sync touches every room's
  // liveQuery, and unbounded queries blow up the DOM. User scrolls to top to
  // grow the window (expanding into IDB locally first, fetching from the
  // homeserver only once the local cache is exhausted).
  const [visibleWindow, setVisibleWindow] = useState(INITIAL_WINDOW)

  useEffect(() => {
    const sub = liveQuery(async () => {
      // Use the [roomId+timestamp] compound index to walk newest-first and
      // cap at the current window — O(N) for N bubbles instead of O(allRoomMessages).
      const arr = await db.chatMessages
        .where('[roomId+timestamp]')
        .between([roomId, 0], [roomId, Number.MAX_SAFE_INTEGER])
        .reverse()
        .limit(visibleWindow)
        .toArray()
      return arr.reverse() // back to chronological order for render
    }).subscribe((msgs) => {
      messagesRef.current = msgs
      if (isVisibleRef.current) setMessages(msgs)
    })
    return () => sub.unsubscribe()
  }, [roomId, visibleWindow])

  // When becoming visible, flush ref to state immediately (instant switch, no loading flash)
  useEffect(() => {
    if (isVisible && messagesRef.current.length > 0) {
      setMessages(messagesRef.current)
    }
  }, [isVisible])

  // userId → displayName lookup for reaction tooltips. Built from three
  // sources, each filling gaps the others miss:
  //   • read receipts        (active readers, already enriched by sync)
  //   • this room's messages (anyone who's spoken)
  //   • /matrix/rooms/:id/info member list (everyone joined — covers
  //     reactors who only reacted but never spoke, including WhatsApp ghosts
  //     under @whatsapp_lid-… that aren't otherwise in our data)
  //
  // Stored in a ref + read through a stable callback so the bubble's memo
  // stays warm (a fresh map identity per Dexie tick would force every
  // bubble to re-render).
  const nameLookupRef = useRef<Map<string, string>>(new Map())
  const [memberNamesVersion, setMemberNamesVersion] = useState(0)
  const memberNamesRef = useRef<Map<string, string>>(new Map())

  // One-shot room-info fetch when the room first becomes visible. Populates
  // the member-derived half of the lookup. Cheap per session — re-uses the
  // hub's room-state cache and only runs once per mount.
  const fetchedMembersRef = useRef(false)
  useEffect(() => {
    if (!isVisible || fetchedMembersRef.current) return
    fetchedMembersRef.current = true
    ;(async () => {
      try {
        const { getHubUrl } = await import('@/hub')
        const res = await fetch(`${getHubUrl()}/matrix/rooms/${encodeURIComponent(roomId)}/info`)
        if (!res.ok) return
        const data = await res.json() as { members?: Array<{ userId: string; displayName?: string }> }
        const m = new Map<string, string>()
        for (const member of data.members ?? []) {
          if (member.displayName) m.set(member.userId, member.displayName)
        }
        memberNamesRef.current = m
        setMemberNamesVersion((v) => v + 1)
      } catch { /* tooltip will fall back to MXID localpart */ }
    })()
  }, [isVisible, roomId])

  useEffect(() => {
    const m = new Map<string, string>()
    // Highest priority: explicit displayName on read receipts.
    if (readReceipts) {
      for (const [uid, r] of Object.entries(readReceipts)) {
        if (r.displayName) m.set(uid, r.displayName)
      }
    }
    // Then senders of messages we've already loaded for this room.
    for (const msg of messagesRef.current) {
      if (msg.senderId && msg.senderName && !m.has(msg.senderId)) {
        m.set(msg.senderId, msg.senderName)
      }
    }
    // Finally, every joined room member (covers react-only ghosts).
    for (const [uid, name] of memberNamesRef.current) {
      if (!m.has(uid)) m.set(uid, name)
    }
    nameLookupRef.current = m
  }, [messages, readReceipts, memberNamesVersion])
  const resolveName = useCallback((userId: string) => {
    const hit = nameLookupRef.current.get(userId)
    if (hit) return hit
    // Fall back to localpart of the MXID (e.g. @yousef:beeper.com → yousef).
    return userId.split(':')[0]?.slice(1) || userId
  }, [])

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

  // Auto-scroll on new messages: always if own, only if near bottom for others.
  //
  // We key off the newest message id (not array length) because once the
  // bounded liveQuery window is saturated, a new message arriving causes the
  // oldest to drop and length stays constant — a length-based check would
  // silently no-op. The id check fires whenever the tail actually changes.
  const prevLastMessageId = useRef<string | null>(null)
  useEffect(() => {
    if (!isVisible || !scrollRef.current || !didInitialScroll.current) return
    if (messages.length === 0) return
    const newest = messages[messages.length - 1]!
    if (newest.id === prevLastMessageId.current) return
    const isFirstObservation = prevLastMessageId.current === null
    prevLastMessageId.current = newest.id
    // Skip the very first tail-id observation after didInitialScroll — that's
    // just us catching up with what initial-scroll already handled.
    if (isFirstObservation) return

    const hasOwnMessage = newest.senderId === matrixUserId || newest.id.startsWith('~')
    if (hasOwnMessage || isNearBottom()) {
      requestAnimationFrame(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      })
    }
  }, [isVisible, messages, matrixUserId, isNearBottom])

  // Reset when room hides. Shrinking the window back to INITIAL_WINDOW
  // frees the bubbles the user expanded into for that visit — important
  // because every room stays mounted in the pre-render strategy.
  useEffect(() => {
    if (!isVisible) {
      didInitialScroll.current = false
      didAutoLoad.current = false
      prevMessageCount.current = 0
      prevLastMessageId.current = null
      setShowScrollToBottom(false)
      setVisibleWindow(INITIAL_WINDOW)
    }
  }, [isVisible])

  // Auto-load older messages when content doesn't fill the container — but
  // only once per visibility, otherwise window-expansion re-fires the
  // effect (messages changed → check again → still under-fills → expand →
  // …) into a runaway that re-mounts the entire history.
  const didAutoLoad = useRef(false)
  useEffect(() => {
    if (!isVisible || !scrollRef.current || isLoadingOlder.current) return
    if (messages.length === 0 || didAutoLoad.current) return
    const el = scrollRef.current
    if (el.scrollHeight <= el.clientHeight) {
      didAutoLoad.current = true
      isLoadingOlder.current = true
      setShowLoadingOlder(true)
      ;(async () => {
        const totalLocal = await db.chatMessages.where('roomId').equals(roomId).count()
        if (totalLocal > visibleWindow) {
          setVisibleWindow((w) => Math.min(totalLocal, w + WINDOW_STEP))
        } else {
          const hasMore = await onLoadOlder(roomId)
          if (hasMore) setVisibleWindow((w) => w + WINDOW_STEP)
        }
        isLoadingOlder.current = false
        setShowLoadingOlder(false)
      })()
    }
  }, [isVisible, messages, roomId, onLoadOlder, visibleWindow])

  const handleScroll = useCallback(async () => {
    if (!scrollRef.current) return
    const el = scrollRef.current
    setShowScrollToBottom(el.scrollHeight - el.scrollTop - el.clientHeight > 200)
    if (isLoadingOlder.current) return
    if (el.scrollTop < 100) {
      isLoadingOlder.current = true
      setShowLoadingOlder(true)
      const prevHeight = el.scrollHeight
      // Try expanding the local window first — cheap and avoids a roundtrip
      // when IDB already has older messages cached.
      const totalLocal = await db.chatMessages.where('roomId').equals(roomId).count()
      let grew = false
      if (totalLocal > visibleWindow) {
        setVisibleWindow((w) => Math.min(totalLocal, w + WINDOW_STEP))
        grew = true
      } else {
        const hasMore = await onLoadOlder(roomId)
        // Network fetch wrote into IDB; bump the window so the new rows
        // actually become visible (otherwise liveQuery returns the same
        // capped set and the user sees no progress after the spinner).
        if (hasMore) {
          setVisibleWindow((w) => w + WINDOW_STEP)
          grew = true
        }
      }
      if (grew) {
        // Restore scroll offset after the new bubbles mount so the user
        // stays anchored to whatever they were reading.
        requestAnimationFrame(() => {
          if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight - prevHeight
          }
        })
      }
      isLoadingOlder.current = false
      setShowLoadingOlder(false)
    }
  }, [roomId, onLoadOlder, visibleWindow])

  const scrollToBottom = useCallback(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [])

  return (
    <>
      <div
        ref={scrollRef}
        className="absolute inset-0 overflow-y-auto overflow-x-hidden py-2"
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
                  onPdfClick={onPdfClick}
                  onReply={onReply}
                  onReact={onReact}
                  onEdit={onEdit}
                  resolveName={resolveName}
                />
              </div>
            )
          })
        )}
      </div>
      {isVisible && showScrollToBottom && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 rounded-full bg-bg-tertiary border border-border p-1.5 shadow-md hover:bg-bg-secondary transition-opacity"
          title="Jump to bottom"
        >
          <ChevronDown size={16} className="text-text-secondary" />
        </button>
      )}
    </>
  )
})
