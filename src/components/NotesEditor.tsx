import { memo, useEffect, useState } from 'react'
import { useNotesStore } from '@/store/notes'
import { useBlogStore, projectSlugFromPath } from '@/store/blog'
import { NotesEditorCore } from './NotesEditorCore'
import { ProjectPill } from './notes/ProjectPill'
import { ProjectPanel } from './notes/ProjectPanel'
import { X, ChevronLeft, Send } from 'lucide-react'
import { useIsMobile } from '@/hooks/useMediaQuery'
import { showConfirm } from '@/dialog'
import { useUiStore } from '@/store/ui'

const PANEL_TOGGLE_KEY = 'console:notes:projectPanelOpen'
const DRAFTS_DIR = 'scratch/blog-drafts/'

function isDraftPath(path: string | null | undefined): boolean {
  return !!path && path.startsWith(DRAFTS_DIR)
}

export const NotesEditor = memo(function NotesEditor() {
  const openFiles = useNotesStore((s) => s.openFiles)
  const activeFilePath = useNotesStore((s) => s.activeFilePath)
  const setActiveFile = useNotesStore((s) => s.setActiveFile)
  const closeFile = useNotesStore((s) => s.closeFile)
  const isFileDirty = useNotesStore((s) => s.isFileDirty)
  const isMobile = useIsMobile()

  // Project panel: only relevant when activeFilePath is a tracked project page.
  // Detection runs on activeFilePath change only (not on every keystroke).
  const slug = projectSlugFromPath(activeFilePath)
  const isTracked = useBlogStore((s) => slug ? s.projects.some((p) => p.slug === slug) : false)
  // Per-client toggle (localStorage, not synced) — defaults to last user choice.
  // First-time default: open on desktop, closed on mobile (so it doesn't fill the screen).
  const [panelOpen, setPanelOpen] = useState<boolean>(() => {
    if (typeof localStorage === 'undefined') return false
    const v = localStorage.getItem(PANEL_TOGGLE_KEY)
    if (v === 'true') return true
    if (v === 'false') return false
    return !isMobile  // first-run default
  })
  useEffect(() => { localStorage.setItem(PANEL_TOGGLE_KEY, String(panelOpen)) }, [panelOpen])
  const showPanel = panelOpen && slug !== null && isTracked && !isMobile

  const paths = Object.keys(openFiles)
  const activeFile = activeFilePath ? openFiles[activeFilePath] : null

  if (!activeFile) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center space-y-1">
          <p className="text-xs text-text-tertiary">No file open</p>
          <p className="text-[10px] text-text-tertiary">
            {isMobile ? 'Tap a file to open' : 'Select a file from the tree or press Ctrl+P'}
          </p>
        </div>
      </div>
    )
  }

  const handleClose = async (path: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
    const dirty = isFileDirty(path)
    if (dirty) {
      if (!(await showConfirm('This file has unsaved changes. Close anyway?', { title: 'Unsaved changes', danger: true, confirmLabel: 'Close' }))) return
    }
    closeFile(path, true)
  }

  const handlePublish = async () => {
    if (!activeFilePath || !isDraftPath(activeFilePath)) return
    const dirty = isFileDirty(activeFilePath)
    if (dirty) {
      if (!(await showConfirm('This draft has unsaved changes. Save and publish?', { title: 'Publish draft', confirmLabel: 'Save & publish' }))) return
      await useNotesStore.getState().saveFile()
    } else {
      if (!(await showConfirm('Publish this draft? It will be moved to log/ and the site rebuilt.', { title: 'Publish draft', confirmLabel: 'Publish' }))) return
    }
    const path = activeFilePath
    const ui = useUiStore.getState()
    const blog = useBlogStore.getState()
    const notes = useNotesStore.getState()
    ui.pushToast({ kind: 'info', message: 'Publishing…' })
    const r = await blog.publish(path)
    if (!r.ok) {
      ui.pushToast({ kind: 'error', message: `Publish failed: ${r.error}` })
      return
    }
    ui.pushToast({
      kind: r.rebuildOk ? 'success' : 'error',
      message: r.rebuildOk ? `Published → ${r.newPath}` : `Moved but rebuild failed: ${r.rebuildBody ?? '?'}`,
    })
    notes.closeFile(path, true)
    if (r.newPath) await notes.openFile(r.newPath)
    void blog.refreshDrafts()
  }

  const displayName = (path: string) => {
    const parts = path.split('/')
    return parts[parts.length - 1]!.replace(/\.md$/, '')
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Tab bar */}
      <div className="flex items-center border-b border-border overflow-x-auto flex-shrink-0">
        {isMobile && (
          <button
            onClick={() => useNotesStore.setState({ activeFilePath: null })}
            className="flex items-center gap-0.5 px-2 py-1 text-xs text-text-tertiary hover:text-text-secondary flex-shrink-0"
          >
            <ChevronLeft size={12} />
          </button>
        )}
        {paths.map((path) => {
          const isActive = path === activeFilePath
          const dirty = isFileDirty(path)
          return (
            <div
              key={path}
              onClick={() => setActiveFile(path)}
              onMouseDown={(e) => {
                if (e.button === 1 && !isFileDirty(path)) closeFile(path, true)
              }}
              className={`flex items-center gap-1 px-2 py-1 text-xs cursor-pointer border-r border-border flex-shrink-0 transition-colors duration-fast ${
                isActive
                  ? 'bg-surface-0 text-text-primary'
                  : 'bg-surface-1 text-text-tertiary hover:text-text-secondary'
              }`}
            >
              {dirty && <span className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" />}
              <span className="truncate max-w-32">{displayName(path)}</span>
              <button
                onClick={(e) => handleClose(path, e)}
                className="text-text-tertiary hover:text-text-secondary transition-colors ml-0.5"
              >
                <X size={10} />
              </button>
            </div>
          )
        })}
      </div>

      {/* Editor + side panel overlay */}
      <div className="relative flex flex-col flex-1 min-h-0">
        <NotesEditorCore
          key={activeFilePath!}
          filePath={activeFilePath!}
          content={activeFile.content}
        />
        {showPanel && slug && (
          <ProjectPanel slug={slug} onClose={() => setPanelOpen(false)} />
        )}
      </div>

      {/* Status bar */}
      <div className="flex items-center justify-between border-t border-border px-3 py-0.5 flex-shrink-0">
        <span className="text-[10px] text-text-tertiary truncate">
          {activeFilePath}
        </span>
        <div className="flex items-center gap-2">
          {isDraftPath(activeFilePath) && (
            <button
              onClick={() => { void handlePublish() }}
              className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-text-secondary hover:text-text-primary hover:bg-surface-2 rounded-sm transition-colors"
              title="Publish this draft (:publish)"
            >
              <Send size={10} />
              publish
            </button>
          )}
          {slug && isTracked && !isMobile && (
            <ProjectPill slug={slug} open={panelOpen} onToggle={() => setPanelOpen((v) => !v)} />
          )}
          {isFileDirty(activeFilePath!) && (
            <span className="text-[10px] text-accent">modified</span>
          )}
          <span className="text-[10px] text-text-tertiary">vim</span>
        </div>
      </div>
    </div>
  )
})
