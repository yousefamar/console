import { useState, useEffect, useRef, useCallback, forwardRef } from 'react'
import { db } from '@/db'
import { useInboxStore } from '@/store/inbox'
import { useChatStore } from '@/store/chat'
import { useUiStore } from '@/store/ui'
import type { DbThread } from '@/gmail/types'
import type { DbChatRoom } from '@/matrix/types'
import { mxcToThumbnail } from '@/matrix/api'
import { relativeTime } from '@/utils/date'

export function SearchOverlay() {
  const activePane = useUiStore((s) => s.activePane)
  const isChat = activePane === 'chat'

  return isChat ? <ChatSearch /> : <EmailSearch />
}

// --- Email search (existing) ---

function EmailSearch() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<DbThread[]>([])
  const [selectedIdx, setSelectedIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const setShowSearch = useUiStore((s) => s.setShowSearch)
  const selectThread = useInboxStore((s) => s.selectThread)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const search = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResults([])
      return
    }
    const lower = q.toLowerCase()
    const threads = await db.threads
      .filter(
        (t) =>
          t.subject.toLowerCase().includes(lower) ||
          t.from.toLowerCase().includes(lower) ||
          t.snippet.toLowerCase().includes(lower),
      )
      .limit(20)
      .toArray()
    threads.sort((a, b) => b.date - a.date)
    setResults(threads)
    setSelectedIdx(0)
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => search(query), 150)
    return () => clearTimeout(timer)
  }, [query, search])

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIdx((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const thread = results[selectedIdx]
      if (thread) {
        selectThread(thread.id)
        setShowSearch(false)
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setShowSearch(false)
    }
  }

  return (
    <SearchShell>
      <SearchInput
        ref={inputRef}
        value={query}
        onChange={setQuery}
        onKeyDown={handleKeyDown}
        placeholder="Search threads..."
      />

      {results.length > 0 && (
        <div className="max-h-80 overflow-y-auto py-1">
          {results.map((thread, i) => (
            <button
              key={thread.id}
              onClick={() => {
                selectThread(thread.id)
                setShowSearch(false)
              }}
              className={`flex w-full flex-col gap-0.5 px-4 py-2 text-left transition-colors duration-fast ${
                i === selectedIdx ? 'bg-surface-2' : 'hover:bg-surface-1'
              }`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-sm text-text-primary">{thread.from}</span>
                <span className="flex-shrink-0 text-xs text-text-tertiary">
                  {relativeTime(thread.date)}
                </span>
              </div>
              <span className="truncate text-sm text-text-secondary">{thread.subject}</span>
            </button>
          ))}
        </div>
      )}

      {query && results.length === 0 && (
        <div className="px-4 py-6 text-center text-sm text-text-tertiary">
          No results
        </div>
      )}
    </SearchShell>
  )
}

// --- Chat room search ---

function ChatSearch() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<DbChatRoom[]>([])
  const [selectedIdx, setSelectedIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const setShowSearch = useUiStore((s) => s.setShowSearch)
  const selectRoom = useChatStore((s) => s.selectRoom)
  const setRooms = useChatStore((s) => s.setRooms)
  const rooms = useChatStore((s) => s.rooms)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Show recent rooms when query is empty, search all rooms when typing
  const search = useCallback(async (q: string) => {
    if (!q.trim()) {
      // Show all rooms sorted by last message time (most recent first)
      const allRooms = await db.chatRooms.toArray()
      allRooms.sort((a, b) => (b.lastMessageTime ?? 0) - (a.lastMessageTime ?? 0))
      setResults(allRooms.slice(0, 20))
      setSelectedIdx(0)
      return
    }
    const lower = q.toLowerCase()
    const allRooms = await db.chatRooms.toArray()
    const matched = allRooms.filter(
      (r) => r.name.toLowerCase().includes(lower),
    )
    // Sort: exact prefix first, then by recency
    matched.sort((a, b) => {
      const aPrefix = a.name.toLowerCase().startsWith(lower) ? 0 : 1
      const bPrefix = b.name.toLowerCase().startsWith(lower) ? 0 : 1
      if (aPrefix !== bPrefix) return aPrefix - bPrefix
      return (b.lastMessageTime ?? 0) - (a.lastMessageTime ?? 0)
    })
    setResults(matched.slice(0, 20))
    setSelectedIdx(0)
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => search(query), 100)
    return () => clearTimeout(timer)
  }, [query, search])

  const select = useCallback((room: DbChatRoom) => {
    // Ensure the room is in the store's rooms list so it stays visible after selection
    if (!rooms.some((r) => r.id === room.id)) {
      setRooms([...rooms, room])
    }
    selectRoom(room.id)
    setShowSearch(false)
  }, [rooms, setRooms, selectRoom, setShowSearch])

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIdx((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const room = results[selectedIdx]
      if (room) select(room)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setShowSearch(false)
    }
  }

  return (
    <SearchShell>
      <SearchInput
        ref={inputRef}
        value={query}
        onChange={setQuery}
        onKeyDown={handleKeyDown}
        placeholder="Search rooms..."
      />

      {results.length > 0 && (
        <div className="max-h-80 overflow-y-auto py-1">
          {results.map((room, i) => (
            <RoomResult
              key={room.id}
              room={room}
              isSelected={i === selectedIdx}
              onSelect={() => select(room)}
            />
          ))}
        </div>
      )}

      {query && results.length === 0 && (
        <div className="px-4 py-6 text-center text-sm text-text-tertiary">
          No rooms found
        </div>
      )}
    </SearchShell>
  )
}

function RoomResult({ room, isSelected, onSelect }: { room: DbChatRoom; isSelected: boolean; onSelect: () => void }) {
  const avatarUrl = room.avatar ? mxcToThumbnail(room.avatar, 32, 32) : undefined

  return (
    <button
      onClick={onSelect}
      className={`flex w-full items-center gap-3 px-4 py-2 text-left transition-colors duration-fast ${
        isSelected ? 'bg-surface-2' : 'hover:bg-surface-1'
      }`}
    >
      {avatarUrl ? (
        <img src={avatarUrl} alt="" className="h-8 w-8 rounded-full object-cover flex-shrink-0" />
      ) : (
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-2 text-xs font-medium text-text-tertiary flex-shrink-0">
          {room.name.charAt(0).toUpperCase()}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm text-text-primary">{room.name}</span>
          {room.lastMessageTime > 0 && (
            <span className="flex-shrink-0 text-xs text-text-tertiary">
              {relativeTime(room.lastMessageTime)}
            </span>
          )}
        </div>
        {room.lastMessageBody && (
          <span className="truncate text-xs text-text-tertiary block">
            {room.lastMessageSender ? `${room.lastMessageSender}: ` : ''}{room.lastMessageBody}
          </span>
        )}
      </div>
      {room.isUnread && (
        <div className="h-2 w-2 rounded-full bg-blue-500 flex-shrink-0" />
      )}
    </button>
  )
}

// --- Shared shell ---

function SearchShell({ children }: { children: React.ReactNode }) {
  const setShowSearch = useUiStore((s) => s.setShowSearch)

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-0 md:pt-[15vh]">
      <div className="absolute inset-0 bg-black/40" onClick={() => setShowSearch(false)} />
      <div className="relative z-10 w-full max-w-lg md:rounded-sm border border-border bg-surface-1 shadow-lg animate-slide-down">
        {children}
      </div>
    </div>
  )
}

const SearchInput = forwardRef<HTMLInputElement, {
  value: string
  onChange: (v: string) => void
  onKeyDown: (e: React.KeyboardEvent) => void
  placeholder: string
}>(function SearchInput({ value, onChange, onKeyDown, placeholder }, ref) {
  return (
    <div className="flex items-center border-b border-border px-4 py-3 md:py-2">
      <span className="mr-2 text-text-tertiary">/</span>
      <input
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className="flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-tertiary"
      />
    </div>
  )
})
