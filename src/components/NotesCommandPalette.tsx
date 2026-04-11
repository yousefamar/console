import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { useNotesStore } from '@/store/notes'
import { Command, Trash2, PenLine, FilePlus, Save, X, XCircle, RotateCcw } from 'lucide-react'

interface CommandItem {
  id: string
  label: string
  icon: React.ReactNode
  action: () => void | Promise<void>
  /** If set, selecting this command transitions to a prompt input */
  prompt?: { placeholder: string; defaultValue?: string }
}

type Phase = { type: 'list' } | { type: 'prompt'; command: CommandItem; value: string }

export function NotesCommandPalette() {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [phase, setPhase] = useState<Phase>({ type: 'list' })

  const closeCommandPalette = useNotesStore((s) => s.closeCommandPalette)
  const activeFilePath = useNotesStore((s) => s.activeFilePath)

  const inputRef = useRef<HTMLInputElement>(null)
  const promptRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (phase.type === 'prompt') {
      promptRef.current?.focus()
      promptRef.current?.select()
    } else {
      inputRef.current?.focus()
    }
  }, [phase.type])

  const commands = useMemo((): CommandItem[] => {
    const cmds: CommandItem[] = []
    const state = useNotesStore.getState()
    const hasActiveFile = !!activeFilePath

    if (hasActiveFile) {
      cmds.push({
        id: 'rename',
        label: 'Rename File',
        icon: <PenLine size={12} />,
        action: () => {},
        prompt: {
          placeholder: 'New filename...',
          defaultValue: activeFilePath!.split('/').pop()?.replace(/\.md$/, '') || '',
        },
      })
      cmds.push({
        id: 'delete',
        label: 'Delete File',
        icon: <Trash2 size={12} />,
        action: async () => {
          const path = activeFilePath!
          const name = path.split('/').pop() || path
          if (confirm(`Delete "${name}"?`)) {
            await state.deleteFile(path)
            closeCommandPalette()
          }
        },
      })
      cmds.push({
        id: 'save',
        label: 'Save File',
        icon: <Save size={12} />,
        action: async () => {
          await state.saveFile()
          closeCommandPalette()
        },
      })
      cmds.push({
        id: 'close',
        label: 'Close File',
        icon: <X size={12} />,
        action: () => {
          if (activeFilePath) state.closeFile(activeFilePath, false)
          closeCommandPalette()
        },
      })
    }

    cmds.push({
      id: 'new',
      label: 'New File',
      icon: <FilePlus size={12} />,
      action: () => {
        closeCommandPalette()
        useNotesStore.getState().openNewFileForm()
      },
    })

    if (state.recentlyClosedPaths.length > 0) {
      cmds.push({
        id: 'reopen',
        label: 'Reopen Closed Tab',
        icon: <RotateCcw size={12} />,
        action: async () => {
          await useNotesStore.getState().reopenLastClosedTab()
          closeCommandPalette()
        },
      })
    }

    if (Object.keys(state.openFiles).length > 1) {
      cmds.push({
        id: 'close-all',
        label: 'Close All Files',
        icon: <XCircle size={12} />,
        action: () => {
          const state = useNotesStore.getState()
          for (const path of Object.keys(state.openFiles)) {
            state.closeFile(path, true)
          }
          closeCommandPalette()
        },
      })
    }

    return cmds
  }, [activeFilePath, closeCommandPalette])

  const filtered = useMemo(() => {
    if (!query.trim()) return commands
    const q = query.toLowerCase()
    return commands.filter((c) => c.label.toLowerCase().includes(q))
  }, [commands, query])

  useEffect(() => {
    if (selectedIndex >= filtered.length) {
      setSelectedIndex(Math.max(0, filtered.length - 1))
    }
  }, [filtered.length, selectedIndex])

  useEffect(() => {
    if (!listRef.current) return
    const item = listRef.current.children[selectedIndex] as HTMLElement
    item?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const executeCommand = useCallback((cmd: CommandItem) => {
    if (cmd.prompt) {
      setPhase({ type: 'prompt', command: cmd, value: cmd.prompt.defaultValue || '' })
    } else {
      cmd.action()
    }
  }, [])

  const handlePromptSubmit = useCallback(async (cmd: CommandItem, value: string) => {
    const state = useNotesStore.getState()
    const trimmed = value.trim()
    if (!trimmed) return

    if (cmd.id === 'rename' && activeFilePath) {
      const dir = activeFilePath.split('/').slice(0, -1).join('/')
      const newPath = dir ? `${dir}/${trimmed}.md` : `${trimmed}.md`
      await state.renameFile(activeFilePath, newPath)
    }

    closeCommandPalette()
  }, [activeFilePath, closeCommandPalette])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      if (phase.type === 'prompt') {
        setPhase({ type: 'list' })
      } else {
        closeCommandPalette()
      }
    } else if (phase.type === 'list') {
      if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
        e.preventDefault()
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1))
      } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
        e.preventDefault()
        setSelectedIndex((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const cmd = filtered[selectedIndex]
        if (cmd) executeCommand(cmd)
      }
    } else if (phase.type === 'prompt') {
      if (e.key === 'Enter') {
        e.preventDefault()
        handlePromptSubmit(phase.command, phase.value)
      }
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
      onClick={(e) => { if (e.target === e.currentTarget) closeCommandPalette() }}
      onKeyDown={handleKeyDown}
    >
      <div className="w-full max-w-lg bg-surface-0 border border-border rounded-sm shadow-lg overflow-hidden">
        {phase.type === 'list' ? (
          <>
            {/* Search input */}
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
              <Command size={12} className="text-text-tertiary flex-shrink-0" />
              <input
                ref={inputRef}
                type="text"
                placeholder="Type a command..."
                value={query}
                onChange={(e) => { setQuery(e.target.value); setSelectedIndex(0) }}
                className="w-full bg-transparent text-sm text-text-primary placeholder:text-text-tertiary outline-none"
              />
            </div>

            {/* Commands */}
            <div ref={listRef} className="max-h-72 overflow-y-auto">
              {filtered.length === 0 ? (
                <div className="px-3 py-4 text-center text-xs text-text-tertiary">
                  No commands found
                </div>
              ) : (
                filtered.map((cmd, i) => (
                  <div
                    key={cmd.id}
                    onClick={() => executeCommand(cmd)}
                    className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer transition-colors duration-fast ${
                      i === selectedIndex ? 'bg-surface-2' : 'hover:bg-surface-1'
                    }`}
                  >
                    <span className="text-text-tertiary flex-shrink-0">{cmd.icon}</span>
                    <span className="text-xs text-text-primary">{cmd.label}</span>
                  </div>
                ))
              )}
            </div>
          </>
        ) : (
          <>
            {/* Prompt input */}
            <div className="px-3 py-2 border-b border-border">
              <div className="text-[10px] text-text-tertiary mb-1">{phase.command.label}</div>
              <input
                ref={promptRef}
                type="text"
                placeholder={phase.command.prompt?.placeholder || ''}
                value={phase.value}
                onChange={(e) => setPhase({ ...phase, value: e.target.value })}
                className="w-full bg-transparent text-sm text-text-primary placeholder:text-text-tertiary outline-none"
              />
            </div>
          </>
        )}

        {/* Footer */}
        <div className="px-3 py-1 text-[10px] text-text-tertiary flex items-center gap-3">
          {phase.type === 'list' ? (
            <>
              <span><kbd className="font-mono">↑↓</kbd> navigate</span>
              <span><kbd className="font-mono">Enter</kbd> run</span>
              <span><kbd className="font-mono">Esc</kbd> close</span>
            </>
          ) : (
            <>
              <span><kbd className="font-mono">Enter</kbd> confirm</span>
              <span><kbd className="font-mono">Esc</kbd> back</span>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
