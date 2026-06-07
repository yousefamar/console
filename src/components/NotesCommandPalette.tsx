import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { useNotesStore } from '@/store/notes'
import { Command, Trash2, PenLine, FilePlus, Save, Send, X, XCircle, RotateCcw, FileText, Folder, Bot } from 'lucide-react'
import { useBlogStore, projectSlugFromPath, enclosingProjectSlug } from '@/store/blog'
import { useAgentStore } from '@/store/agent'
import { useUiStore } from '@/store/ui'
import { showConfirm, showAlert, showPrompt } from '@/dialog'
import { getVaultPath } from '@/notes/vault-info'

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
          if (await showConfirm(`Delete "${name}"?`, { title: 'Delete file', danger: true, confirmLabel: 'Delete' })) {
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

    // Blog: new draft (inherits project from active file's path if it's a project page)
    const inferredProject = projectSlugFromPath(activeFilePath)
    cmds.push({
      id: 'new-blog-draft',
      label: inferredProject
        ? `New Blog Draft (project: ${inferredProject})`
        : 'New Blog Draft',
      icon: <FileText size={12} />,
      action: () => {},
      prompt: { placeholder: 'Draft title…' },
    })

    cmds.push({
      id: 'new-project',
      label: 'New Project',
      icon: <Folder size={12} />,
      action: () => {},
      prompt: { placeholder: 'Project title…' },
    })

    // Agent in current project — visible whenever active file is in a project
    // directory, tracked or not. Untracked dirs get a humanised slug as title.
    const enclosingSlug = enclosingProjectSlug(activeFilePath)
    if (enclosingSlug) {
      const enclosingProject = useBlogStore.getState().projects.find((p) => p.slug === enclosingSlug)
      const projectTitle = enclosingProject?.title ?? enclosingSlug
        .split('-')
        .filter(Boolean)
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
        .join(' ')

      // Existing sessions jumper
      const needle = `/projects/${enclosingSlug}`
      const projectSessions = useAgentStore.getState().sessions.filter((s) => {
        if (!s.cwd || s.status === 'ended') return false
        return s.cwd === needle || s.cwd.endsWith(needle) || s.cwd.includes(needle + '/')
      })
      for (const s of projectSessions) {
        cmds.push({
          id: `jump-agent-${s.id}`,
          label: `Jump to agent: ${s.name || s.prompt?.slice(0, 50) || s.id}`,
          icon: <Bot size={12} />,
          action: () => {
            useAgentStore.getState().selectSession(s.id)
            useUiStore.getState().setActivePane('agents')
            closeCommandPalette()
          },
        })
      }
      cmds.push({
        id: 'start-agent',
        label: `Start Agent in ${projectTitle}`,
        icon: <Bot size={12} />,
        action: async () => {
          closeCommandPalette()
          const vaultPath = await getVaultPath()
          if (!vaultPath) {
            await showAlert('Vault path not loaded yet — try again in a moment.', { title: 'Not ready' })
            return
          }
          const prompt = await showPrompt(`First message for the new ${projectTitle} agent:`, {
            title: `Start agent — ${projectTitle}`,
            placeholder: 'e.g. Help me plan the next iteration',
            confirmLabel: 'Start',
          })
          if (!prompt || !prompt.trim()) return
          const cwd = `${vaultPath}/projects/${enclosingSlug}`
          useAgentStore.getState().createSession(prompt.trim(), cwd, undefined, projectTitle)
          useUiStore.getState().setActivePane('agents')
        },
      })
    }

    if (hasActiveFile && activeFilePath!.startsWith('scratch/blog-drafts/')) {
      cmds.push({
        id: 'publish',
        label: 'Publish Draft',
        icon: <Send size={12} />,
        action: async () => {
          closeCommandPalette()
          const ui = useUiStore.getState()
          const blog = useBlogStore.getState()
          const notes = useNotesStore.getState()
          const path = activeFilePath!
          try { await notes.saveFile() } catch {}
          ui.pushToast({ kind: 'info', message: 'Publishing…', detail: path })
          const result = await blog.publish(path)
          if (!result.ok) {
            ui.pushToast({ kind: 'error', message: 'Publish failed', detail: result.error })
            return
          }
          try { notes.closeFile(path, true) } catch {}
          void notes.loadVaultFiles()
          void blog.refreshDrafts()
          void blog.refreshProjects()
          if (result.rebuildOk) {
            ui.pushToast({
              kind: 'success', message: 'Published',
              detail: result.newPath, href: 'https://yousefamar.com/log/',
            })
          } else {
            ui.pushToast({
              kind: 'error', message: 'Moved, but rebuild failed',
              detail: result.rebuildBody?.slice(0, 200) ?? 'no response',
            })
          }
        },
      })
    }

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
    } else if (cmd.id === 'new-blog-draft') {
      closeCommandPalette()
      const project = projectSlugFromPath(activeFilePath) ?? undefined
      const r = await useBlogStore.getState().createDraft({ title: trimmed, project })
      if (!r.ok) await showAlert(`Failed to create draft: ${r.error}`, { title: 'Error' })
      return
    } else if (cmd.id === 'new-project') {
      closeCommandPalette()
      const r = await useBlogStore.getState().createProject({ title: trimmed })
      if (!r.ok) await showAlert(`Failed to create project: ${r.error}`, { title: 'Error' })
      return
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
