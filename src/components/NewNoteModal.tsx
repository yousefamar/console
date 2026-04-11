import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { useNotesStore, slugify, getDirectoriesByRecency } from '@/store/notes'
import { Folder } from 'lucide-react'

export function NewNoteModal() {
  const [title, setTitle] = useState('')
  const dir = useNotesStore((s) => s.newFileFormDir)
  const [dirInput, setDirInput] = useState(dir)
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [selectedSuggestion, setSelectedSuggestion] = useState(0)
  const files = useNotesStore((s) => s.files)
  const closeNewFileForm = useNotesStore((s) => s.closeNewFileForm)

  const titleRef = useRef<HTMLInputElement>(null)
  const dirRef = useRef<HTMLInputElement>(null)
  const suggestionsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setDirInput(dir)
  }, [dir])

  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  const allDirs = useMemo(() => getDirectoriesByRecency(files), [files])

  const filteredDirs = useMemo(() => {
    if (!dirInput.trim()) return allDirs
    const q = dirInput.toLowerCase()
    return allDirs.filter((d) => d.toLowerCase().includes(q))
  }, [allDirs, dirInput])

  useEffect(() => {
    if (selectedSuggestion >= filteredDirs.length) {
      setSelectedSuggestion(Math.max(0, filteredDirs.length - 1))
    }
  }, [filteredDirs.length, selectedSuggestion])

  useEffect(() => {
    if (!suggestionsRef.current) return
    const item = suggestionsRef.current.children[selectedSuggestion] as HTMLElement
    item?.scrollIntoView({ block: 'nearest' })
  }, [selectedSuggestion])

  const handleCreate = useCallback(async () => {
    const trimmed = title.trim()
    if (!trimmed) return
    const slug = slugify(trimmed)
    const folder = dirInput.trim()
    const path = folder ? `${folder}/${slug}.md` : `${slug}.md`
    await useNotesStore.getState().createFile(path, `# ${trimmed}\n\n`)
    closeNewFileForm()
  }, [title, dirInput, closeNewFileForm])

  const handleTitleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (title.trim()) {
        // Tab to dir input if empty/default, otherwise create
        dirRef.current?.focus()
        setShowSuggestions(true)
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      closeNewFileForm()
    }
  }

  const handleDirKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      if (showSuggestions) {
        setShowSuggestions(false)
      } else {
        closeNewFileForm()
      }
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (showSuggestions && filteredDirs.length > 0) {
        setDirInput(filteredDirs[selectedSuggestion]!)
        setShowSuggestions(false)
      } else {
        handleCreate()
      }
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      if (showSuggestions && filteredDirs.length > 0) {
        setDirInput(filteredDirs[selectedSuggestion]!)
        setShowSuggestions(false)
      }
      return
    }
    if (showSuggestions) {
      if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
        e.preventDefault()
        setSelectedSuggestion((i) => Math.min(i + 1, filteredDirs.length - 1))
      } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
        e.preventDefault()
        setSelectedSuggestion((i) => Math.max(i - 1, 0))
      }
    }
  }

  const preview = useMemo(() => {
    const trimmed = title.trim()
    if (!trimmed) return ''
    const slug = slugify(trimmed)
    const folder = dirInput.trim()
    return folder ? `${folder}/${slug}.md` : `${slug}.md`
  }, [title, dirInput])

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
      onClick={(e) => { if (e.target === e.currentTarget) closeNewFileForm() }}
    >
      <div className="w-full max-w-md bg-surface-0 border border-border rounded-sm shadow-lg overflow-visible">
        {/* Title */}
        <div className="px-3 pt-2.5 pb-1">
          <input
            ref={titleRef}
            type="text"
            placeholder="Note title..."
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={handleTitleKeyDown}
            className="w-full bg-transparent text-sm text-text-primary placeholder:text-text-tertiary outline-none"
          />
        </div>

        {/* Directory with autocomplete */}
        <div className="px-3 pb-2 relative">
          <div className="flex items-center gap-1.5">
            <Folder size={11} className="text-text-tertiary flex-shrink-0" />
            <input
              ref={dirRef}
              type="text"
              placeholder="Directory..."
              value={dirInput}
              onChange={(e) => {
                setDirInput(e.target.value)
                setShowSuggestions(true)
                setSelectedSuggestion(0)
              }}
              onFocus={() => setShowSuggestions(true)}
              onBlur={() => {
                // Delay to allow click on suggestion
                setTimeout(() => setShowSuggestions(false), 150)
              }}
              onKeyDown={handleDirKeyDown}
              className="w-full bg-transparent text-xs text-text-secondary placeholder:text-text-tertiary outline-none"
            />
          </div>

          {/* Suggestions dropdown */}
          {showSuggestions && filteredDirs.length > 0 && (
            <div
              ref={suggestionsRef}
              className="absolute left-0 right-0 mx-3 mt-1 max-h-40 overflow-y-auto bg-surface-1 border border-border rounded-sm shadow-md z-10"
            >
              {filteredDirs.map((d, i) => (
                <div
                  key={d}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    setDirInput(d)
                    setShowSuggestions(false)
                  }}
                  className={`flex items-center gap-1.5 px-2 py-1 cursor-pointer text-xs transition-colors duration-fast ${
                    i === selectedSuggestion ? 'bg-surface-2 text-text-primary' : 'text-text-secondary hover:bg-surface-2'
                  }`}
                >
                  <Folder size={10} className="text-text-tertiary flex-shrink-0" />
                  <span className="truncate">{d}</span>
                  {d === 'scratch' && <span className="text-[9px] text-text-tertiary ml-auto">default</span>}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Preview + footer */}
        <div className="px-3 py-1.5 border-t border-border flex items-center justify-between">
          <span className="text-[10px] text-text-tertiary truncate">
            {preview || 'Type a title...'}
          </span>
          <div className="flex items-center gap-2 text-[10px] text-text-tertiary flex-shrink-0">
            <span><kbd className="font-mono">Tab</kbd> pick dir</span>
            <span><kbd className="font-mono">Enter</kbd> create</span>
            <span><kbd className="font-mono">Esc</kbd> close</span>
          </div>
        </div>
      </div>
    </div>
  )
}
