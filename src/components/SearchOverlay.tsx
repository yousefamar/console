import { useState, useEffect, useRef, useCallback } from 'react'
import { db } from '@/db'
import { useInboxStore } from '@/store/inbox'
import { useUiStore } from '@/store/ui'
import type { DbThread } from '@/gmail/types'
import { relativeTime } from '@/utils/date'

export function SearchOverlay() {
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
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-0 md:pt-[15vh]">
      <div className="absolute inset-0 bg-black/40" onClick={() => setShowSearch(false)} />

      <div className="relative z-10 w-full max-w-lg md:rounded-sm border border-border bg-surface-1 shadow-lg animate-slide-down">
        <div className="flex items-center border-b border-border px-4 py-3 md:py-2">
          <span className="mr-2 text-text-tertiary">/</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search threads..."
            className="flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-tertiary"
          />
        </div>

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
      </div>
    </div>
  )
}
