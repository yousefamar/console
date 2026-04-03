import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { useNotesStore } from '@/store/notes'
import { File, Search } from 'lucide-react'

type Mode = 'filename' | 'content'

export function NotesQuickSwitcher() {
  const [query, setQuery] = useState('')
  const initialMode = useNotesStore((s) => s.quickSwitcherMode)
  const [mode, setMode] = useState<Mode>(initialMode)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const closeQuickSwitcher = useNotesStore((s) => s.closeQuickSwitcher)
  const openFile = useNotesStore((s) => s.openFile)
  const searchFilenames = useNotesStore((s) => s.searchFilenames)
  const searchContent = useNotesStore((s) => s.searchContent)
  const files = useNotesStore((s) => s.files)
  const adapter = useNotesStore((s) => s.adapter)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Content search: load snippets for results
  const [contentSnippets, setContentSnippets] = useState<Record<string, string>>({})

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const filenameResults = useMemo(() => {
    if (mode !== 'filename') return []
    if (!query.trim()) {
      return files
        .slice()
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 30)
        .map((f) => ({
          path: f.path,
          name: f.name,
          dir: f.dir,
          score: 0,
          positions: new Set<number>(),
        }))
    }
    return searchFilenames(query)
  }, [query, files, searchFilenames, mode])

  const contentResults = useMemo(() => {
    if (mode !== 'content' || !query.trim()) return []
    return searchContent(query)
  }, [query, searchContent, mode])

  // Load snippets for content results
  useEffect(() => {
    if (mode !== 'content' || !adapter || contentResults.length === 0) return
    const q = query.toLowerCase()
    let cancelled = false

    async function loadSnippets() {
      const snippets: Record<string, string> = {}
      for (const result of contentResults.slice(0, 20)) {
        if (cancelled) break
        try {
          const content = await adapter!.readFile(result.path)
          const lines = content.split('\n')
          // Find first line containing the query
          const matchLine = lines.findIndex((l) => l.toLowerCase().includes(q))
          if (matchLine >= 0) {
            // Show the matching line + context
            const start = Math.max(0, matchLine - 1)
            const end = Math.min(lines.length, matchLine + 2)
            snippets[result.path] = lines.slice(start, end).join('\n').slice(0, 200)
          } else {
            snippets[result.path] = lines.slice(0, 3).join('\n').slice(0, 200)
          }
        } catch {
          snippets[result.path] = ''
        }
      }
      if (!cancelled) setContentSnippets(snippets)
    }
    loadSnippets()
    return () => { cancelled = true }
  }, [contentResults, adapter, mode, query])

  const results = mode === 'filename' ? filenameResults : contentResults
  const resultCount = results.length

  // Clamp selected index
  useEffect(() => {
    if (selectedIndex >= resultCount) {
      setSelectedIndex(Math.max(0, resultCount - 1))
    }
  }, [resultCount, selectedIndex])

  // Scroll selected into view
  useEffect(() => {
    if (!listRef.current) return
    const item = listRef.current.children[selectedIndex] as HTMLElement
    item?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const handleSelect = useCallback((path: string) => {
    openFile(path)
    closeQuickSwitcher()
  }, [openFile, closeQuickSwitcher])

  const toggleMode = useCallback(() => {
    setMode((m) => m === 'filename' ? 'content' : 'filename')
    setSelectedIndex(0)
    setContentSnippets({})
    inputRef.current?.focus()
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
      e.preventDefault()
      setSelectedIndex((i) => Math.min(i + 1, resultCount - 1))
    } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
      e.preventDefault()
      setSelectedIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const r = results[selectedIndex]
      if (r) handleSelect('path' in r ? r.path : '')
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closeQuickSwitcher()
    } else if (e.key === 'Tab') {
      e.preventDefault()
      toggleMode()
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
      onClick={(e) => { if (e.target === e.currentTarget) closeQuickSwitcher() }}
    >
      <div className="w-full max-w-lg bg-surface-0 border border-border rounded-sm shadow-lg overflow-hidden">
        {/* Mode tabs + search input */}
        <div className="border-b border-border">
          <div className="flex items-center gap-0.5 px-3 pt-1.5">
            <button
              onClick={() => { setMode('filename'); setSelectedIndex(0) }}
              className={`px-2 py-0.5 text-[10px] rounded-sm transition-colors ${
                mode === 'filename' ? 'bg-surface-2 text-text-primary' : 'text-text-tertiary hover:text-text-secondary'
              }`}
            >
              Files
            </button>
            <button
              onClick={() => { setMode('content'); setSelectedIndex(0) }}
              className={`px-2 py-0.5 text-[10px] rounded-sm transition-colors ${
                mode === 'content' ? 'bg-surface-2 text-text-primary' : 'text-text-tertiary hover:text-text-secondary'
              }`}
            >
              Content
            </button>
          </div>
          <div className="flex items-center gap-2 px-3 py-2">
            {mode === 'content' ? (
              <Search size={12} className="text-text-tertiary flex-shrink-0" />
            ) : (
              <File size={12} className="text-text-tertiary flex-shrink-0" />
            )}
            <input
              ref={inputRef}
              type="text"
              placeholder={mode === 'filename' ? 'Find file...' : 'Search in files...'}
              value={query}
              onChange={(e) => { setQuery(e.target.value); setSelectedIndex(0) }}
              onKeyDown={handleKeyDown}
              className="w-full bg-transparent text-sm text-text-primary placeholder:text-text-tertiary outline-none"
            />
          </div>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-72 overflow-y-auto">
          {resultCount === 0 ? (
            <div className="px-3 py-4 text-center text-xs text-text-tertiary">
              {!query.trim() && mode === 'content'
                ? 'Type to search across all files'
                : 'No results found'}
            </div>
          ) : mode === 'filename' ? (
            filenameResults.map((result, i) => (
              <div
                key={result.path}
                onClick={() => handleSelect(result.path)}
                className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer transition-colors duration-fast ${
                  i === selectedIndex ? 'bg-surface-2' : 'hover:bg-surface-1'
                }`}
              >
                <File size={11} className="text-text-tertiary flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-text-primary truncate">
                    {result.name.replace(/\.md$/, '')}
                  </div>
                  {result.dir && (
                    <div className="text-[10px] text-text-tertiary truncate">
                      {result.dir}
                    </div>
                  )}
                </div>
              </div>
            ))
          ) : (
            contentResults.map((result, i) => (
              <div
                key={result.path}
                onClick={() => handleSelect(result.path)}
                className={`px-3 py-1.5 cursor-pointer transition-colors duration-fast ${
                  i === selectedIndex ? 'bg-surface-2' : 'hover:bg-surface-1'
                }`}
              >
                <div className="flex items-center gap-2">
                  <Search size={10} className="text-text-tertiary flex-shrink-0" />
                  <span className="text-xs text-text-primary truncate">
                    {result.title || result.path.split('/').pop()?.replace(/\.md$/, '')}
                  </span>
                  <span className="text-[10px] text-text-tertiary truncate ml-auto flex-shrink-0">
                    {result.path}
                  </span>
                </div>
                {contentSnippets[result.path] && (
                  <div className="mt-0.5 ml-5 text-[10px] text-text-tertiary line-clamp-2 whitespace-pre-wrap font-mono leading-relaxed">
                    {highlightSnippet(contentSnippets[result.path]!, query)}
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* Footer hint */}
        <div className="border-t border-border px-3 py-1 text-[10px] text-text-tertiary flex items-center gap-3">
          <span><kbd className="font-mono">↑↓</kbd> navigate</span>
          <span><kbd className="font-mono">Enter</kbd> open</span>
          <span><kbd className="font-mono">Tab</kbd> {mode === 'filename' ? 'search content' : 'search files'}</span>
          <span><kbd className="font-mono">Esc</kbd> close</span>
        </div>
      </div>
    </div>
  )
}

/** Highlight query terms in snippet text */
function highlightSnippet(text: string, query: string) {
  if (!query.trim()) return text
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const parts: Array<{ text: string; highlight: boolean }> = []
  let remaining = text

  while (remaining.length > 0) {
    let earliestIdx = remaining.length
    let matchLen = 0

    for (const term of terms) {
      const idx = remaining.toLowerCase().indexOf(term)
      if (idx >= 0 && idx < earliestIdx) {
        earliestIdx = idx
        matchLen = term.length
      }
    }

    if (matchLen === 0) {
      parts.push({ text: remaining, highlight: false })
      break
    }

    if (earliestIdx > 0) {
      parts.push({ text: remaining.slice(0, earliestIdx), highlight: false })
    }
    parts.push({ text: remaining.slice(earliestIdx, earliestIdx + matchLen), highlight: true })
    remaining = remaining.slice(earliestIdx + matchLen)
  }

  return (
    <>
      {parts.map((p, i) =>
        p.highlight ? (
          <span key={i} className="text-text-primary bg-accent/20 rounded-sm px-0.5">{p.text}</span>
        ) : (
          <span key={i}>{p.text}</span>
        )
      )}
    </>
  )
}
