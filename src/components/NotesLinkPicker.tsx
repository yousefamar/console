import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { useNotesStore } from '@/store/notes'
import { wikiTarget, wikiDisplay } from '@/notes/wiki-target'
import { File, FileSearch, Link, ExternalLink } from 'lucide-react'

type Mode = 'wiki' | 'url'

export function NotesLinkPicker() {
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<Mode>('wiki')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [url, setUrl] = useState('')
  const [displayText, setDisplayText] = useState('')

  const closeLinkPicker = useNotesStore((s) => s.closeLinkPicker)
  const context = useNotesStore((s) => s.linkPickerContext)
  const searchFilenames = useNotesStore((s) => s.searchFilenames)
  const searchContent = useNotesStore((s) => s.searchContent)
  const files = useNotesStore((s) => s.files)

  const inputRef = useRef<HTMLInputElement>(null)
  const urlInputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const canToggle = context?.mode === 'both'

  // Pre-fill display text from selection
  useEffect(() => {
    if (context?.selectedText) {
      setDisplayText(context.selectedText)
    }
  }, [context?.selectedText])

  useEffect(() => {
    if (mode === 'url') {
      urlInputRef.current?.focus()
    } else {
      inputRef.current?.focus()
    }
  }, [mode])

  const results = useMemo(() => {
    if (mode !== 'wiki') return []
    if (!query.trim()) {
      return files
        .slice()
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 30)
        .map((f) => ({
          path: f.path,
          name: f.name,
          dir: f.dir,
          byContent: false,
        }))
    }
    // Filename matches first, then full-text content hits the name search
    // missed — one list, content hits flagged so the row can say why it's here.
    const byName = searchFilenames(query).map((r) => ({
      path: r.path, name: r.name, dir: r.dir, byContent: false,
    }))
    const seen = new Set(byName.map((r) => r.path))
    const byContent = searchContent(query)
      .filter((r) => !seen.has(r.path))
      .slice(0, 15)
      .map((r) => {
        const parts = r.path.split('/')
        const name = parts.pop() ?? r.path
        return { path: r.path, name, dir: parts.join('/'), byContent: true }
      })
    return [...byName, ...byContent]
  }, [query, files, searchFilenames, searchContent, mode])

  const resultCount = results.length

  useEffect(() => {
    if (selectedIndex >= resultCount) {
      setSelectedIndex(Math.max(0, resultCount - 1))
    }
  }, [resultCount, selectedIndex])

  useEffect(() => {
    if (!listRef.current) return
    const item = listRef.current.children[selectedIndex] as HTMLElement
    item?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const insertWikiLink = useCallback((path: string, _name: string) => {
    const { editorView, linkPickerContext, closeLinkPicker: close, files: allFiles } = useNotesStore.getState()
    if (!editorView || !linkPickerContext) return

    const { from, to, selectedText } = linkPickerContext
    // Target must be unambiguous: basename when unique across the vault,
    // full path otherwise (many index.mds — a bare "index" link is a coin flip).
    const linkTarget = wikiTarget(path, allFiles.map((f) => f.path))
    const display = selectedText || wikiDisplay(path)
    const insert = `[[${linkTarget}|${display}]]`

    // Select the display segment so typing renames it immediately; two
    // backspaces remove display + pipe for a bare [[target]].
    const displayFrom = from + 2 + linkTarget.length + 1
    editorView.dispatch({
      changes: { from, to, insert },
      selection: { anchor: displayFrom, head: displayFrom + display.length },
    })
    editorView.focus()
    close()
  }, [])

  const insertUrlLink = useCallback(() => {
    const { editorView, linkPickerContext, closeLinkPicker: close } = useNotesStore.getState()
    if (!editorView || !linkPickerContext || !url.trim()) return

    const { from, to } = linkPickerContext
    const text = displayText.trim() || url.trim()
    const insert = `[${text}](${url.trim()})`

    editorView.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length },
    })
    editorView.focus()
    close()
  }, [url, displayText])

  const handleClose = useCallback(() => {
    // If triggered by [[ and nothing was selected, remove the [[
    if (context?.mode === 'wiki' && !context.selectedText) {
      const { editorView } = useNotesStore.getState()
      if (editorView) {
        const doc = editorView.state.doc.toString()
        const from = context.from
        // Check if [[ is still at the expected position
        if (doc.slice(from, from + 2) === '[[') {
          editorView.dispatch({
            changes: { from, to: from + 2, insert: '' },
          })
        }
        editorView.focus()
      }
    } else {
      const { editorView } = useNotesStore.getState()
      editorView?.focus()
    }
    closeLinkPicker()
  }, [context, closeLinkPicker])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      handleClose()
    } else if (e.key === 'Tab' && canToggle) {
      e.preventDefault()
      setMode((m) => m === 'wiki' ? 'url' : 'wiki')
      setSelectedIndex(0)
    } else if (mode === 'wiki') {
      if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
        e.preventDefault()
        setSelectedIndex((i) => Math.min(i + 1, resultCount - 1))
      } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
        e.preventDefault()
        setSelectedIndex((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const r = results[selectedIndex]
        if (r) insertWikiLink(r.path, r.name)
      }
    } else if (mode === 'url') {
      if (e.key === 'Enter') {
        e.preventDefault()
        insertUrlLink()
      }
    }
  }

  const displayName = (name: string) => name.replace(/\.md$/, '')

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
      onClick={(e) => { if (e.target === e.currentTarget) handleClose() }}
      onKeyDown={handleKeyDown}
    >
      <div className="w-full max-w-lg bg-surface-0 border border-border rounded-sm shadow-lg overflow-hidden">
        {/* Mode tabs */}
        {canToggle && (
          <div className="flex items-center gap-0.5 px-3 pt-1.5 border-b border-border">
            <button
              onClick={() => { setMode('wiki'); setSelectedIndex(0) }}
              className={`px-2 py-0.5 text-[10px] rounded-sm transition-colors ${
                mode === 'wiki' ? 'bg-surface-2 text-text-primary' : 'text-text-tertiary hover:text-text-secondary'
              }`}
            >
              Wiki Link
            </button>
            <button
              onClick={() => { setMode('url'); setSelectedIndex(0) }}
              className={`px-2 py-0.5 text-[10px] rounded-sm transition-colors ${
                mode === 'url' ? 'bg-surface-2 text-text-primary' : 'text-text-tertiary hover:text-text-secondary'
              }`}
            >
              URL
            </button>
          </div>
        )}

        {mode === 'wiki' ? (
          <>
            {/* Wiki search input */}
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
              <Link size={12} className="text-text-tertiary flex-shrink-0" />
              <input
                ref={inputRef}
                type="text"
                placeholder="Search by name or content..."
                value={query}
                onChange={(e) => { setQuery(e.target.value); setSelectedIndex(0) }}
                className="w-full bg-transparent text-sm text-text-primary placeholder:text-text-tertiary outline-none"
              />
            </div>

            {/* Results */}
            <div ref={listRef} className="max-h-72 overflow-y-auto">
              {resultCount === 0 ? (
                <div className="px-3 py-4 text-center text-xs text-text-tertiary">
                  No files found
                </div>
              ) : (
                results.map((result, i) => (
                  <div
                    key={result.path}
                    onClick={() => insertWikiLink(result.path, result.name)}
                    className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer transition-colors duration-fast ${
                      i === selectedIndex ? 'bg-surface-2' : 'hover:bg-surface-1'
                    }`}
                  >
                    {result.byContent
                      ? <FileSearch size={11} className="text-accent flex-shrink-0" />
                      : <File size={11} className="text-text-tertiary flex-shrink-0" />}
                    <div className="min-w-0 flex-1">
                      <div className="text-xs text-text-primary truncate">
                        {displayName(result.name)}
                      </div>
                      {result.dir && (
                        <div className="text-[10px] text-text-tertiary truncate">
                          {result.dir}
                        </div>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </>
        ) : (
          <>
            {/* URL inputs */}
            <div className="px-3 py-2 space-y-2 border-b border-border">
              <div className="flex items-center gap-2">
                <ExternalLink size={12} className="text-text-tertiary flex-shrink-0" />
                <input
                  ref={urlInputRef}
                  type="text"
                  placeholder="https://..."
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  className="w-full bg-transparent text-sm text-text-primary placeholder:text-text-tertiary outline-none"
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-text-tertiary flex-shrink-0 w-3 text-center">A</span>
                <input
                  type="text"
                  placeholder="Display text (optional)"
                  value={displayText}
                  onChange={(e) => setDisplayText(e.target.value)}
                  className="w-full bg-transparent text-sm text-text-primary placeholder:text-text-tertiary outline-none"
                />
              </div>
            </div>
          </>
        )}

        {/* Footer hint */}
        <div className="px-3 py-1 text-[10px] text-text-tertiary flex items-center gap-3">
          {mode === 'wiki' ? (
            <>
              <span><kbd className="font-mono">↑↓</kbd> navigate</span>
              <span><kbd className="font-mono">Enter</kbd> insert</span>
            </>
          ) : (
            <span><kbd className="font-mono">Enter</kbd> insert link</span>
          )}
          {canToggle && (
            <span><kbd className="font-mono">Tab</kbd> {mode === 'wiki' ? 'URL mode' : 'wiki mode'}</span>
          )}
          <span><kbd className="font-mono">Esc</kbd> cancel</span>
        </div>
      </div>
    </div>
  )
}
